/**
 * photo-avatar.js — голова по фотографии: шарж с портретным сходством + кожа со снимка.
 *
 *   const report = await head.fromPhoto(file, { caricature: 1.5, texture: 0.9 });
 *   head.setPhotoOptions({ caricature: 2 });     // перестроить без повторного распознавания
 *   head.clearPhoto();                           // вернуть стандартную голову
 *
 * Как это работает (всё локально в браузере, фото никуда не отправляется):
 *  1. MediaPipe Face Landmarker → 478 точек лица + 52 blendshape-оценки выражения на снимке;
 *     MediaPipe Hair Segmenter → маска волос (цвет, длина, линия роста).
 *  2. Точки переводятся в координаты головы (глаза на y=0.03, рот на y=-0.52), выражение на фото
 *     (улыбка, прищур, открытый рот) компенсируется, левая/правая половины усредняются.
 *  3. Шарж: каждая мера лица (ширина овала на разных высотах, размер/посадка/наклон глаз, брови, нос,
 *     рот, губы, подбородок) сравнивается со «средним лицом» MediaPipe (canonical face model)
 *     и отклонение усиливается в k раз. Стилизация процедурной головы сохраняется: меняется только то,
 *     чем человек отличается от среднего.
 *  4. Кожа: снимок проецируется на лицо тонкопластинчатым сплайном (TPS) по опорным точкам
 *     (глаза, брови, нос, рот, овал), из фото вычитается крупномасштабное освещение, брови и губы
 *     закрашиваются кожей (их рисуют подвижные 3D-брови и губы), края плавно уходят в тон кожи.
 *
 * Модели грузятся с CDN при первом вызове (~4.5 МБ). Свои пути: fromPhoto(src, { assets: {...} }).
 */
import { PRESETS, LAYOUT, upperLipProfile } from './head-model.js';

const MP = '0.10.14';
export const PHOTO_ASSETS = {
  module: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/vision_bundle.mjs`,
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`,
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hair: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite',
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
const hex = (c) => '#' + c.map((v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0')).join('');
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const EY = LAYOUT.eyeY, MY = LAYOUT.mouthY;
const TEX_MAX = 1.25;             // запас яркости текстуры при экспорте (после выравнивания света бывает > 1)
const TEX_GAIN = 0.86;            // студийный свет сцены ярче, чем «плоская» текстура: компенсируем

// «Среднее лицо» MediaPipe (canonical_face_model.obj, 468 точек) в координатах головы
const MEAN = (() => {
  const a = '0,-0.451,0.477,0,-0.269,0.597,0,-0.346,0.483,-0.037,-0.103,0.529,0,-0.216,0.605,0,-0.15,0.578,0,0.018,0.462,-0.339,0.026,0.262,0,0.141,0.422,0,0.21,0.43,0,0.48,0.358,0,-0.475,0.468,0,-0.492,0.444,0,-0.498,0.416,0,-0.542,0.431,0,-0.558,0.441,0,-0.58,0.447,0,-0.608,0.442,0,-0.67,0.405,0,-0.299,0.568,-0.033,-0.296,0.514,-0.566,0.254,0.008,-0.21,-0.017,0.307,-0.255,-0.021,0.303,-0.301,-0.017,0.291,-0.356,0.014,0.252,-0.173,-0.005,0.307,-0.256,0.078,0.328,-0.213,0.076,0.327,-0.299,0.073,0.317,-0.332,0.065,0.297,-0.404,-0.025,0.222,-0.181,-0.772,0.35,-0.355,0.033,0.253,-0.576,0.001,0.006,-0.463,0.008,0.176,-0.227,-0.237,0.354,-0.057,-0.445,0.469,-0.048,-0.493,0.434,-0.114,-0.459,0.439,-0.153,-0.483,0.401,-0.09,-0.496,0.414,-0.125,-0.505,0.386,-0.211,-0.579,0.334,-0.034,-0.267,0.587,-0.04,-0.217,0.594,-0.419,0.13,0.268,-0.137,-0.102,0.364,-0.128,-0.255,0.464,-0.132,-0.228,0.445,-0.38,-0.235,0.282,-0.038,-0.156,0.567,-0.298,0.18,0.363,-0.366,0.164,0.323,-0.501,0.348,0.114,-0.097,0.151,0.407,-0.175,0.068,0.319,-0.248,-0.527,0.327,-0.536,-0.561,-0.139,-0.095,-0.284,0.458,-0.058,-0.307,0.465,-0.196,-0.526,0.342,-0.176,-0.523,0.332,-0.398,0.204,0.299,-0.127,-0.28,0.435,-0.211,0.182,0.393,-0.22,0.228,0.4,-0.281,0.459,0.298,-0.447,0.277,0.217,-0.244,0.344,0.361,-0.457,0.16,0.226,-0.509,0.202,0.127,-0.054,-0.474,0.458,-0.101,-0.482,0.432,-0.138,-0.495,0.399,-0.083,-0.296,0.452,-0.185,-0.525,0.34,-0.164,-0.537,0.361,-0.172,-0.521,0.322,-0.076,-0.262,0.52,-0.117,-0.501,0.367,-0.082,-0.498,0.393,-0.043,-0.498,0.41,-0.061,-0.666,0.398,-0.056,-0.602,0.435,-0.053,-0.574,0.44,-0.05,-0.554,0.435,-0.046,-0.54,0.426,-0.123,-0.532,0.379,-0.129,-0.537,0.384,-0.138,-0.548,0.387,-0.147,-0.565,0.385,-0.189,-0.427,0.388,-0.602,-0.263,-0.194,0,-0.317,0.527,-0.146,-0.53,0.351,-0.154,-0.531,0.359,-0.048,-0.34,0.468,-0.112,-0.316,0.418,-0.053,-0.325,0.468,-0.187,-0.134,0.343,-0.266,-0.171,0.328,-0.138,-0.253,0.421,-0.41,0.418,0.212,-0.362,0.325,0.294,-0.318,0.228,0.356,-0.173,-0.614,0.355,-0.111,0.221,0.424,-0.129,0.347,0.393,-0.151,0.478,0.341,-0.335,-0.001,0.269,-0.458,-0.067,0.194,-0.148,0.009,0.307,-0.398,0.066,0.246,-0.104,-0.066,0.386,-0.104,-0.233,0.512,-0.516,-0.105,0.135,-0.42,-0.104,0.237,-0.354,-0.122,0.281,-0.263,-0.111,0.309,-0.194,-0.089,0.322,-0.145,-0.062,0.337,-0.045,0.005,0.444,-0.506,-0.222,0.15,-0.446,0.077,0.214,-0.019,-0.296,0.564,-0.129,-0.152,0.391,-0.618,0.009,-0.16,-0.111,-0.032,0.355,-0.142,-0.258,0.387,-0.373,0.033,0.246,-0.106,-0.202,0.486,-0.58,-0.41,-0.18,-0.148,0.027,0.3,-0.074,-0.174,0.532,-0.399,-0.669,0.151,-0.406,-0.752,0.057,-0.571,-0.244,-0.006,-0.466,-0.598,0.074,-0.546,0.113,0.058,-0.193,-0.838,0.329,-0.014,-0.314,0.524,-0.168,-0.193,0.364,-0.511,-0.001,0.124,-0.293,0.009,0.29,-0.254,0.004,0.301,-0.175,-0.546,0.357,-0.497,-0.335,0.133,-0.103,-0.921,0.327,-0.256,-0.86,0.224,-0.325,-0.817,0.154,0,0.343,0.401,0,-0.93,0.34,-0.217,0.005,0.301,-0.183,0.012,0.295,-0.159,0.02,0.294,-0.489,0.092,0.163,-0.183,0.051,0.301,-0.217,0.057,0.309,-0.254,0.057,0.309,-0.293,0.054,0.297,-0.321,0.049,0.278,-0.603,0.148,-0.079,-0.321,0.019,0.275,0,-0.381,0.473,-0.142,-0.394,0.416,-0.098,-0.274,0.475,-0.058,-0.382,0.464,0,0.082,0.418,-0.33,-0.738,0.213,-0.264,-0.791,0.27,-0.105,-0.869,0.375,-0.474,-0.676,-0.05,-0.159,0.04,0.299,-0.072,-0.081,0.459,0,-0.879,0.39,-0.184,-0.895,0.288,-0.555,-0.374,-0.011,-0.088,-0.535,0.409,-0.094,-0.545,0.414,-0.1,-0.561,0.418,-0.106,-0.587,0.415,-0.123,-0.644,0.38,-0.156,-0.513,0.354,-0.169,-0.509,0.363,-0.182,-0.503,0.366,-0.227,-0.472,0.358,-0.421,-0.358,0.228,-0.075,-0.027,0.415,-0.105,0.068,0.338,-0.142,0.049,0.31,-0.147,-0.506,0.339,-0.434,-0.501,0.168,-0.061,0.074,0.388,-0.155,-0.707,0.361,0,-0.095,0.541,-0.041,-0.053,0.491,0,-0.042,0.504,-0.1,-0.161,0.453,0,-0.813,0.413,0,-0.737,0.411,-0.08,-0.732,0.397,-0.262,-0.609,0.303,-0.184,-0.304,0.366,-0.214,-0.667,0.327,-0.306,-0.302,0.33,-0.236,-0.361,0.354,-0.35,-0.394,0.291,-0.097,-0.804,0.397,-0.123,-0.19,0.415,-0.309,-0.661,0.264,-0.246,-0.723,0.304,-0.299,-0.539,0.297,-0.486,-0.435,0.118,-0.366,-0.557,0.238,-0.525,-0.494,0.006,-0.279,-0.434,0.33,-0.1,-0.115,0.423,-0.09,-0.254,0.522,-0.115,-0.271,0.471,-0.074,-0.222,0.559,-0.14,0.102,0.345,-0.21,0.117,0.348,-0.27,0.118,0.344,-0.325,0.114,0.325,-0.369,0.098,0.291,-0.413,0.023,0.213,-0.582,-0.118,-0.004,-0.376,-0.048,0.248,-0.325,-0.062,0.277,-0.261,-0.062,0.298,-0.202,-0.05,0.308,-0.157,-0.031,0.316,-0.126,-0.012,0.326,-0.612,-0.126,-0.194,-0.112,-0.286,0.449,-0.071,-0.127,0.497,-0.061,-0.257,0.565,-0.037,-0.286,0.542,-0.06,-0.265,0.542,-0.099,-0.306,0.437,-0.031,-0.292,0.555,-0.025,-0.308,0.519,-0.131,0.025,0.308,-0.1,0.017,0.335,-0.082,0.011,0.368,-0.339,0.042,0.265,-0.361,0.053,0.267,0.037,-0.103,0.529,0.339,0.026,0.262,0.033,-0.296,0.514,0.566,0.254,0.008,0.21,-0.017,0.307,0.255,-0.021,0.303,0.301,-0.017,0.291,0.356,0.014,0.252,0.173,-0.005,0.307,0.256,0.078,0.328,0.213,0.076,0.327,0.299,0.073,0.317,0.332,0.065,0.297,0.404,-0.025,0.222,0.181,-0.772,0.35,0.355,0.033,0.253,0.576,0.001,0.006,0.463,0.008,0.176,0.227,-0.237,0.354,0.057,-0.445,0.469,0.048,-0.493,0.434,0.114,-0.459,0.439,0.153,-0.483,0.401,0.09,-0.496,0.414,0.125,-0.505,0.386,0.211,-0.579,0.334,0.034,-0.267,0.587,0.04,-0.217,0.594,0.419,0.13,0.268,0.137,-0.102,0.364,0.128,-0.255,0.464,0.132,-0.228,0.445,0.38,-0.235,0.282,0.038,-0.156,0.567,0.298,0.18,0.363,0.366,0.164,0.323,0.501,0.348,0.114,0.097,0.151,0.407,0.175,0.068,0.319,0.248,-0.527,0.327,0.536,-0.561,-0.139,0.095,-0.284,0.458,0.058,-0.307,0.465,0.196,-0.526,0.342,0.176,-0.523,0.332,0.398,0.204,0.299,0.127,-0.28,0.435,0.211,0.182,0.393,0.22,0.228,0.4,0.281,0.459,0.298,0.447,0.277,0.217,0.244,0.344,0.361,0.457,0.16,0.226,0.509,0.202,0.127,0.054,-0.474,0.458,0.101,-0.482,0.432,0.138,-0.495,0.399,0.083,-0.296,0.452,0.185,-0.525,0.34,0.164,-0.537,0.361,0.172,-0.521,0.322,0.076,-0.262,0.52,0.117,-0.501,0.367,0.082,-0.498,0.393,0.043,-0.498,0.41,0.061,-0.666,0.398,0.056,-0.602,0.435,0.053,-0.574,0.44,0.05,-0.554,0.435,0.046,-0.54,0.426,0.123,-0.532,0.379,0.129,-0.537,0.384,0.138,-0.548,0.387,0.147,-0.565,0.385,0.189,-0.427,0.388,0.602,-0.263,-0.194,0.146,-0.53,0.351,0.154,-0.531,0.359,0.048,-0.34,0.468,0.112,-0.316,0.418,0.053,-0.325,0.468,0.187,-0.134,0.343,0.266,-0.171,0.328,0.138,-0.253,0.421,0.41,0.418,0.212,0.362,0.325,0.294,0.318,0.228,0.356,0.173,-0.614,0.355,0.111,0.221,0.424,0.129,0.347,0.393,0.151,0.478,0.341,0.335,-0.001,0.269,0.458,-0.067,0.194,0.148,0.009,0.307,0.398,0.066,0.246,0.104,-0.066,0.386,0.104,-0.233,0.512,0.516,-0.105,0.135,0.42,-0.104,0.237,0.354,-0.122,0.281,0.263,-0.111,0.309,0.194,-0.089,0.322,0.145,-0.062,0.337,0.045,0.005,0.444,0.506,-0.222,0.15,0.446,0.077,0.214,0.019,-0.296,0.564,0.129,-0.152,0.391,0.618,0.009,-0.16,0.111,-0.032,0.355,0.142,-0.258,0.387,0.373,0.033,0.246,0.106,-0.202,0.486,0.58,-0.41,-0.18,0.148,0.027,0.3,0.074,-0.174,0.532,0.399,-0.669,0.151,0.406,-0.752,0.057,0.571,-0.244,-0.006,0.466,-0.598,0.074,0.546,0.113,0.058,0.193,-0.838,0.329,0.014,-0.314,0.524,0.168,-0.193,0.364,0.511,-0.001,0.124,0.293,0.009,0.29,0.254,0.004,0.301,0.175,-0.546,0.357,0.497,-0.335,0.133,0.103,-0.921,0.327,0.256,-0.86,0.224,0.325,-0.817,0.154,0.217,0.005,0.301,0.183,0.012,0.295,0.159,0.02,0.294,0.489,0.092,0.163,0.183,0.051,0.301,0.217,0.057,0.309,0.254,0.057,0.309,0.293,0.054,0.297,0.321,0.049,0.278,0.603,0.148,-0.079,0.321,0.019,0.275,0.142,-0.394,0.416,0.098,-0.274,0.475,0.058,-0.382,0.464,0.33,-0.738,0.213,0.264,-0.791,0.27,0.105,-0.869,0.375,0.474,-0.676,-0.05,0.159,0.04,0.299,0.072,-0.081,0.459,0.184,-0.895,0.288,0.555,-0.374,-0.011,0.088,-0.535,0.409,0.094,-0.545,0.414,0.1,-0.561,0.418,0.106,-0.587,0.415,0.123,-0.644,0.38,0.156,-0.513,0.354,0.169,-0.509,0.363,0.182,-0.503,0.366,0.227,-0.472,0.358,0.421,-0.358,0.228,0.075,-0.027,0.415,0.105,0.068,0.338,0.142,0.049,0.31,0.147,-0.506,0.339,0.434,-0.501,0.168,0.061,0.074,0.388,0.155,-0.707,0.361,0.041,-0.053,0.491,0.1,-0.161,0.453,0.08,-0.732,0.397,0.262,-0.609,0.303,0.184,-0.304,0.366,0.214,-0.667,0.327,0.306,-0.302,0.33,0.236,-0.361,0.354,0.35,-0.394,0.291,0.097,-0.804,0.397,0.123,-0.19,0.415,0.309,-0.661,0.264,0.246,-0.723,0.304,0.299,-0.539,0.297,0.486,-0.435,0.118,0.366,-0.557,0.238,0.525,-0.494,0.006,0.279,-0.434,0.33,0.1,-0.115,0.423,0.09,-0.254,0.522,0.115,-0.271,0.471,0.074,-0.222,0.559,0.14,0.102,0.345,0.21,0.117,0.348,0.27,0.118,0.344,0.325,0.114,0.325,0.369,0.098,0.291,0.413,0.023,0.213,0.582,-0.118,-0.004,0.376,-0.048,0.248,0.325,-0.062,0.277,0.261,-0.062,0.298,0.202,-0.05,0.308,0.157,-0.031,0.316,0.126,-0.012,0.326,0.612,-0.126,-0.194,0.112,-0.286,0.449,0.071,-0.127,0.497,0.061,-0.257,0.565,0.037,-0.286,0.542,0.06,-0.265,0.542,0.099,-0.306,0.437,0.031,-0.292,0.555,0.025,-0.308,0.519,0.131,0.025,0.308,0.1,0.017,0.335,0.082,0.011,0.368,0.339,0.042,0.265,0.361,0.053,0.267'.split(',').map(Number), out = [];
  for (let i = 0; i < a.length; i += 3) out.push({ x: a[i], y: a[i + 1], z: a[i + 2] });
  return out;
})();
// зеркальная пара каждой точки (по среднему лицу)
const MIRROR = (() => {
  const m = new Int16Array(MEAN.length);
  for (let i = 0; i < MEAN.length; i++) {
    const p = MEAN[i];
    if (Math.abs(p.x) < 1e-3) { m[i] = i; continue; }
    let best = i, bd = Infinity;
    for (let j = 0; j < MEAN.length; j++) {
      const q = MEAN[j], d = (p.x + q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    m[i] = best;
  }
  return m;
})();

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LIPS_OUT = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const LIPS_IN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
// брови: от внутреннего конца к внешнему; +X = левая сторона персонажа (справа на фото)
const BROWS = [
  { sg: 1, up: [336, 296, 334, 293, 300], lo: [285, 295, 282, 283, 276] },
  { sg: -1, up: [107, 66, 105, 63, 70], lo: [55, 65, 52, 53, 46] },
];
const EYE_RINGS = [
  [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
];
const EYES = [
  { sg: 1, outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 },
  { sg: -1, outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
];

// ------------------------------------------------------------------ MediaPipe

let _tasks = null, _tasksKey = '';
async function loadTasks(A) {
  const key = A.module + A.face + A.hair;
  if (_tasks && _tasksKey === key) return _tasks;
  _tasksKey = key;
  _tasks = (async () => {
    const V = await import(/* @vite-ignore */ A.module);
    const fs = await V.FilesetResolver.forVisionTasks(A.wasm);
    const make = async (Cls, opts) => {
      try { return await Cls.createFromOptions(fs, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }); }
      catch (e) { return Cls.createFromOptions(fs, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
    };
    const [face, hair] = await Promise.all([
      make(V.FaceLandmarker, { baseOptions: { modelAssetPath: A.face }, runningMode: 'IMAGE', numFaces: 1, outputFaceBlendshapes: true }),
      A.hair ? make(V.ImageSegmenter, { baseOptions: { modelAssetPath: A.hair }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false }).catch(() => null) : null,
    ]);
    return { face, hair };
  })();
  _tasks.catch(() => { _tasks = null; });
  return _tasks;
}

function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function ub64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

async function toCanvas(src, max = 1280) {
  let img = src;
  if (typeof src === 'string') img = await createImageBitmap(await (await fetch(src)).blob());
  else if (src instanceof Blob) img = await createImageBitmap(src);
  else if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement && !src.complete) await src.decode();
  const w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
  if (!w || !h) throw new Error('Не удалось прочитать изображение');
  const k = Math.min(1, max / Math.max(w, h));
  const c = makeCanvas(Math.round(w * k), Math.round(h * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * Распознать портрет. Возвращает Portrait: .fit({caricature, texture, gender}) → overrides для ProceduralHead.
 * @param {File|Blob|string|HTMLImageElement|HTMLCanvasElement|ImageBitmap} src
 * @param {object} [o] { assets, onProgress(text) }
 */
export async function analyzePortrait(src, o = {}) {
  const A = { ...PHOTO_ASSETS, ...(o.assets || {}) };
  const say = o.onProgress || (() => {});
  say('Загружаю модели распознавания…');
  const T = await loadTasks(A);
  const img = await toCanvas(src);
  say('Ищу лицо…');
  const r = T.face.detect(img);
  const L = r.faceLandmarks?.[0];
  if (!L) throw new Error('Лицо не найдено. Нужен портрет анфас: лицо крупно, хорошо освещено, без тёмных очков.');
  const bs = {};
  for (const c of r.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
  let hair = null;
  if (T.hair) {
    try {
      const res = T.hair.segment(img), m = res.categoryMask;
      hair = { data: m.getAsUint8Array().slice(), w: m.width, h: m.height };
      res.close?.();
    } catch (e) { /* без маски волос: цвет и длина по умолчанию */ }
  }
  say('Строю голову…');
  return new Portrait(img, L, bs, hair);
}

/** Точки лица на произвольном изображении (для метрики сходства): { L, bs } или null. */
export async function detectFace(src, o = {}) {
  const T = await loadTasks({ ...PHOTO_ASSETS, ...(o.assets || {}) });   // те же задачи, что у analyzePortrait (кэш)
  const img = src instanceof HTMLCanvasElement ? src : await toCanvas(src);
  const r = T.face.detect(img), L = r.faceLandmarks?.[0];
  if (!L) return null;
  const bs = {};
  for (const c of r.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
  return { L, bs, w: img.width, h: img.height };
}

// ------------------------------------------------------------------ метрика сходства

const NOSE = [1, 2, 4, 5, 6, 19, 94, 98, 327, 129, 358, 168, 197, 195];
const REGIONS = {
  oval: OVAL.filter((i) => ![10, 338, 109, 297, 67].includes(i)),   // верх лба часто под волосами
  eyes: EYE_RINGS.flat(), brows: BROWS.flatMap((b) => [...b.up, ...b.lo]), nose: NOSE, lips: [...LIPS_OUT, ...LIPS_IN],
};
// размерные меры сравниваются в долях среднего, положения и углы — в абсолютных единицах головы
const POS_MEAS = new Set(['browY', 'browArch', 'browTail', 'noseTip', 'chin', 'browX0', 'browX1', 'tilt', 'eyeCX']);
const MEAS_SCALE = (k) => (POS_MEAS.has(k) ? 0.05 : Math.abs(MEAN_M[k]) || 1);

/** Нормированные точки (координаты головы, симметризованные) для найденного лица. */
function normalizedFace(det) {
  const p = Object.create(Portrait.prototype);
  p.px = det.L.map((q) => ({ x: q.x * det.w, y: q.y * det.h, z: q.z * det.w }));
  p._initFrame();
  return p;
}

/**
 * Сравнение лица на фото с отрендеренной головой.
 * @param {Portrait} portrait     анализ фото
 * @param {object} render         detectFace() по рендеру текущей головы
 * @param {object} [base]         detectFace() по рендеру той же головы без шаржа (caricature = 0) — для «направления»
 * @returns {object} { rms, regions, direction, gain, measures }
 */
export function likenessReport(portrait, render, base = null) {
  const R = normalizedFace(render), B = base ? normalizedFace(base) : null;
  const unit = 100 / (EY - MY);                                    // в % расстояния глаза–рот
  const rmsOf = (A, idx) => Math.sqrt(idx.reduce((s, i) => s + (A.sym[i].x - portrait.sym[i].x) ** 2 + (A.sym[i].y - portrait.sym[i].y) ** 2, 0) / idx.length) * unit;
  const regions = {};
  for (const k in REGIONS) regions[k] = +rmsOf(R, REGIONS[k]).toFixed(2);
  const all = Object.values(REGIONS).flat();
  const out = { rms: +rmsOf(R, all).toFixed(2), regions, direction: null, gain: null, measures: {} };
  const Q = portrait.meas, MR = measure(R.sym), MB = B ? measure(B.sym) : null;
  let ab = 0, aa = 0, bb = 0;
  for (const k of Object.keys(MEAN_M)) {
    if (typeof Q[k] !== 'number') continue;
    const sc = MEAS_SCALE(k), a = (Q[k] - MEAN_M[k]) / sc;
    const row = { photo: +Q[k].toFixed(4), render: +MR[k].toFixed(4), mean: +MEAN_M[k].toFixed(4) };
    if (MB) {
      const b = (MR[k] - MB[k]) / sc;
      row.base = +MB[k].toFixed(4); row.photoDev = +a.toFixed(3); row.renderDev = +b.toFixed(3);
      ab += a * b; aa += a * a; bb += b * b;
    }
    out.measures[k] = row;
  }
  if (MB && aa > 0 && bb > 0) {
    out.direction = +(ab / Math.sqrt(aa * bb)).toFixed(3);         // косинус: шарж «тянет» в сторону отличий человека (1 — идеально)
    out.gain = +(ab / aa).toFixed(3);                              // во сколько раз отличия усилены (≈ caricature при честной передаче)
  }
  return out;
}

// ------------------------------------------------------------------ измерения

/** Полуширина овала лица на высоте y (по многоугольнику OVAL). */
function ovalHalfWidth(P, y) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < OVAL.length; i++) {
    const a = P[OVAL[i]], b = P[OVAL[(i + 1) % OVAL.length]];
    if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
    const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return hi > lo ? (hi - lo) / 2 : null;
}

const WIDTH_YS = [0.5, 0.25, 0, -0.25, -0.5, -0.75];          // = PRESETS.gx[2..7]

/** Скалярные меры лица (P — симметризованные точки в координатах головы). */
function measure(P) {
  const browC = (j) => mid(P[BROWS[0].up[j]], P[BROWS[0].lo[j]]);
  const b0 = browC(0), b2 = browC(2), b4 = browC(4);
  return {
    eyeCX: (P[263].x + P[362].x) / 2,
    eyeW: P[263].x - P[362].x,
    eyeH: Math.max(0.005, P[386].y - P[374].y),
    tilt: Math.atan2(P[263].y - P[362].y, P[263].x - P[362].x),
    browY: b0.y, browArch: b2.y - b0.y, browTail: b4.y - b0.y, browX0: b0.x, browX1: b4.x,
    browTh: [1, 2, 3].reduce((s, j) => s + P[BROWS[0].up[j]].y - P[BROWS[0].lo[j]].y, 0) / 3,
    noseTip: P[4].y, noseW: P[358].x,
    noseProj: Math.max(0.02, P[4].z - (P[362].z + P[263].z) / 2),
    mouthHW: P[291].x, lipU: Math.max(0.005, P[0].y - P[13].y), lipL: Math.max(0.005, P[14].y - P[17].y),
    chin: P[152].y,
  };
}
const CANON_M = measure(MEAN);
// Калибровка «среднего» по реальным фото (canonical model MediaPipe — не среднее фото: глаза у неё прищурены,
// овал шире видимого и т.д.). Множители к мерам canonical; tilt — абсолютное значение (рад).
const CALIB = { eyeH: 1.65, eyeCX: 0.93, noseTip: 1.15, noseW: 1.13, noseProj: 0.95, mouthHW: 0.97, lipU: 0.8, lipL: 1.09,
  chin: 0.885, browY: 0.81, browArch: 1.85, browTail: 0.6, browTh: 0.83 };
const MEAN_M = { ...CANON_M };
for (const k in CALIB) MEAN_M[k] = CANON_M[k] * CALIB[k];
MEAN_M.tilt = 0.09;
const POP_W = [null, 0.515, 0.548, 0.532, 0.47, 0.289];        // медиана видимой полуширины овала по калибровочным фото
// Стилизованная голова шире настоящей (большой череп, широко посаженные крупные глаза, короткий подбородок).
// В фото-режиме основа сдвигается к реальным пропорциям (o.realism), и уже от неё строится шарж.
// множители gx при realism = 1: силуэт → 1.1 × средний видимый овал (верх черепа оставляем крупнее — стиль и объём волос)
const REAL_GX = {
  female: [0.86, 0.83, 0.78, 0.76, 0.8, 0.83, 0.88, 0.79, 0.79],
  male: [0.85, 0.81, 0.76, 0.74, 0.77, 0.78, 0.78, 0.68, 0.68],
};
const REAL = { eyeX: 0.234, eyeW: 0.207, chinScale: 1 };
const BOW_MEAN = { x: 0.29, rc: 0.866 };    // «лук Купидона» по калибровочным фото: пики на 0.29 полуширины рта, центр/пик = 0.87

// ------------------------------------------------------------------ обработка изображения

function boxBlur(src, W, H, r, out = new Float32Array(src.length)) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(src.length);
  const pass = (a, b, n, m, stride, step) => {          // n линий длины m
    for (let l = 0; l < n; l++) {
      const o = l * stride;
      let acc = 0, cnt = 0;
      for (let i = -r; i <= r; i++) { const j = clamp(i, 0, m - 1); acc += a[o + j * step]; cnt++; }
      for (let i = 0; i < m; i++) {
        b[o + i * step] = acc / cnt;
        const add = Math.min(m - 1, i + r + 1), rem = Math.max(0, i - r);
        acc += a[o + add * step] - a[o + rem * step];
      }
    }
  };
  let a = src;
  for (let it = 0; it < 3; it++) {                       // 3 прохода box ≈ гаусс
    pass(a, tmp, H, W, W, 1);
    pass(tmp, out, W, H, 1, W);
    a = out;
  }
  return out;
}

/** Заполнение дыр «push-pull»: значения там, где w≈0, берутся из сглаженной пирамиды. */
function pushPull(ch, w, W, H) {
  const levels = [{ ch, w, W, H }];
  while (levels.at(-1).W > 1 || levels.at(-1).H > 1) {
    const f = levels.at(-1), NW = Math.ceil(f.W / 2), NH = Math.ceil(f.H / 2);
    const nc = ch.map(() => new Float32Array(NW * NH)), nw = new Float32Array(NW * NH);
    for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
      let sw = 0; const acc = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const fx = Math.min(f.W - 1, 2 * x + dx), fy = Math.min(f.H - 1, 2 * y + dy), k = fy * f.W + fx, ww = f.w[k];
        sw += ww; for (let c = 0; c < 3; c++) acc[c] += f.ch[c][k] * ww;
      }
      const k = y * NW + x;
      for (let c = 0; c < 3; c++) nc[c][k] = sw > 1e-6 ? acc[c] / sw : 0;
      nw[k] = Math.min(1, sw);
    }
    levels.push({ ch: nc, w: nw, W: NW, H: NH });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
      const k = y * f.W + x, ww = f.w[k];
      if (ww >= 0.999) continue;
      // билинейно из грубого уровня
      const gx = clamp((x + 0.5) / 2 - 0.5, 0, c.W - 1), gy = clamp((y + 0.5) / 2 - 0.5, 0, c.H - 1);
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(c.W - 1, x0 + 1), y1 = Math.min(c.H - 1, y0 + 1), tx = gx - x0, ty = gy - y0;
      for (let ci = 0; ci < 3; ci++) {
        const C = c.ch[ci];
        const v = lerp(lerp(C[y0 * c.W + x0], C[y0 * c.W + x1], tx), lerp(C[y1 * c.W + x0], C[y1 * c.W + x1], tx), ty);
        f.ch[ci][k] = f.ch[ci][k] * ww + v * (1 - ww);
      }
      f.w[k] = 1;
    }
  }
  return ch;
}

/** Тонкопластинчатый сплайн R² → R²: src[i] ↦ dst[i]. */
function thinPlate(src, dst, lambda = 1e-5) {
  const n = src.length, N = n + 3;
  const A = Array.from({ length: N }, () => new Float64Array(N + 2));
  const U = (r2) => (r2 > 1e-12 ? r2 * Math.log(r2) : 0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U((src[i].x - src[j].x) ** 2 + (src[i].y - src[j].y) ** 2) + (i === j ? lambda : 0);
    A[i][n] = 1; A[i][n + 1] = src[i].x; A[i][n + 2] = src[i].y;
    A[n][i] = 1; A[n + 1][i] = src[i].x; A[n + 2][i] = src[i].y;
    A[i][N] = dst[i].x; A[i][N + 1] = dst[i].y;
  }
  // Гаусс с выбором главного элемента, две правые части
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k < N + 2; k++) A[r][k] -= f * A[c][k];
    }
  }
  const wx = new Float64Array(N), wy = new Float64Array(N);
  for (let i = 0; i < N; i++) { wx[i] = A[i][N] / A[i][i]; wy[i] = A[i][N + 1] / A[i][i]; }
  const sx = Float64Array.from(src, (p) => p.x), sy = Float64Array.from(src, (p) => p.y);
  return (x, y, out) => {
    let u = wx[n] + wx[n + 1] * x + wx[n + 2] * y, v = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const k = U((x - sx[i]) ** 2 + (y - sy[i]) ** 2);
      u += wx[i] * k; v += wy[i] * k;
    }
    out.x = u; out.y = v;
    return out;
  };
}

/** Робастный цвет: среднее средних 50% по яркости. */
function robustColor(samples) {
  if (samples.length < 3) return null;
  samples.sort((a, b) => lum(...a) - lum(...b));
  const a = Math.floor(samples.length * 0.25), b = Math.max(a + 1, Math.floor(samples.length * 0.75));
  const c = [0, 0, 0];
  for (let i = a; i < b; i++) for (let k = 0; k < 3; k++) c[k] += samples[i][k];
  return c.map((v) => v / (b - a));
}

// ------------------------------------------------------------------ портрет

export class Portrait {
  constructor(img, L, bs, hair) {
    this.isPortrait = true;
    this.img = img;
    this.bs = bs;
    this.hairMask = hair;
    const W = img.width, H = img.height;
    this.pix = img.getContext('2d').getImageData(0, 0, W, H).data;
    this.px = L.map((p) => ({ x: p.x * W, y: p.y * H, z: p.z * W }));
    this._initFrame();
    this.warnings = [];
    if (Math.abs(this.yaw) > 0.12) this.warnings.push('Лицо заметно повёрнуто — сходство будет хуже. Лучше фото анфас.');

    this._measure();
    this._colors();
    this._hair();
    this._texture();
    this._fits = new Map();
  }

  /** Система координат головы по точкам this.px (общая для анализа и импорта). */
  _initFrame() {
    const px = this.px;
    // система координат головы: середина глаз → (0, EY), рот → y = MY, наклон головы снят
    const eR = mid(px[33], px[133]), eL = mid(px[362], px[263]);
    const c = mid(eR, eL), roll = Math.atan2(eL.y - eR.y, eL.x - eR.x);
    const cs = Math.cos(-roll), sn = Math.sin(-roll), m = mid(px[13], px[14]);
    const my = (m.x - c.x) * sn + (m.y - c.y) * cs;
    this.frame = { c, roll, s: (EY - MY) / my };
    this.head = px.map((p) => this.toHead(p));
    const P = this.head;
    this.sym = P.map((p, i) => {
      const j = MIRROR[i] ?? i, q = P[j];
      return j === i ? { x: 0, y: p.y, z: p.z } : { x: (p.x - q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 };
    });

    // поворот лица (по асимметрии): сильный поворот портит сходство
    const dl = Math.hypot(P[263].x - P[4].x, P[263].y - P[4].y), dr = Math.hypot(P[33].x - P[4].x, P[33].y - P[4].y);
    this.yaw = (dl - dr) / (dl + dr);
  }

  toHead(p) {
    const { c, roll, s } = this.frame, cs = Math.cos(-roll), sn = Math.sin(-roll);
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: (dx * cs - dy * sn) * s, y: EY - (dx * sn + dy * cs) * s, z: -(p.z || 0) * s };
  }
  fromHead(x, y) {
    const { c, roll, s } = this.frame, rx = x / s, ry = (EY - y) / s;
    return { x: c.x + rx * Math.cos(roll) - ry * Math.sin(roll), y: c.y + rx * Math.sin(roll) + ry * Math.cos(roll) };
  }
  _rgb(x, y) {
    const W = this.img.width, H = this.img.height;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const k = (y * W + x) * 4, d = this.pix;
    return [d[k] / 255, d[k + 1] / 255, d[k + 2] / 255];
  }

  /** Меры лица с поправкой на выражение на снимке. */
  _measure() {
    const b = this.bs, g = (k) => b[k] || 0;
    const M = measure(this.sym);
    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2, stretch = (g('mouthStretchLeft') + g('mouthStretchRight')) / 2;
    const squint = (g('eyeSquintLeft') + g('eyeSquintRight')) / 2 + 0.3 * (g('cheekSquintLeft') + g('cheekSquintRight')) / 2;
    const blink = (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2;
    M.mouthHW /= 1 + 0.45 * smile + 0.15 * stretch;
    M.noseW /= 1 + 0.22 * smile;
    M.lipU /= 1 + 0.1 * smile; M.lipL /= 1 + 0.05 * smile;
    M.eyeH /= clamp(1 - 0.35 * squint - 0.7 * blink, 0.45, 1);
    const gap = Math.max(0, this.sym[13].y - this.sym[14].y - 0.006);          // открытый рот опускает подбородок
    M.chin += gap * 0.9;
    M.browY -= 0.03 * g('browInnerUp') + 0.015 * (g('browOuterUpLeft') + g('browOuterUpRight')) / 2;
    M.browTail -= 0.02 * (g('browOuterUpLeft') + g('browOuterUpRight')) / 2;
    // ширина овала на высотах эталонной головы (ниже рта — пропорционально длине подбородка)
    // абсолютная полуширина овала на высотах эталонной головы (ниже рта — пропорционально длине подбородка)
    M.widthsAbs = WIDTH_YS.map((y) => ovalHalfWidth(this.head, y >= MY ? y : MY + ((y - MY) * (M.chin - MY)) / (MEAN_M.chin - MY)));
    M.widths = M.widthsAbs.map((w, i) => (w && POP_W[i] ? w / POP_W[i] : 1));
    // «лук Купидона»: положение пиков (доля полуширины рта) и толщина губы в центре относительно пиков
    {
      const S = this.sym, ax = (i) => Math.abs(S[i].x), inner = [13, 312, 311, 310, 415, 308];
      const xp = ax(267), hw = Math.max(1e-3, ax(291));
      let yIn = S[13].y;
      for (let j = 0; j < inner.length - 1; j++) {
        const a = inner[j], b = inner[j + 1];
        if (xp >= ax(a) && xp <= ax(b)) { yIn = lerp(S[a].y, S[b].y, (xp - ax(a)) / Math.max(1e-4, ax(b) - ax(a))); break; }
      }
      M.bowX = xp / hw;
      M.bowRC = (S[0].y - S[13].y) / Math.max(0.004, S[267].y - yIn);
    }
    this.meas = M;
    this.expression = { smile, squint, blink, mouthOpen: gap };
  }

  _colors() {
    const P = this.px, s = this.frame.s, r = 0.022 / s;
    const disk = (p, rad, out, filter) => {
      for (let y = -rad; y <= rad; y += Math.max(1, rad / 6)) for (let x = -rad; x <= rad; x += Math.max(1, rad / 6)) {
        if (x * x + y * y > rad * rad) continue;
        const c = this._rgb(p.x + x, p.y + y);
        if (c && (!filter || filter(c))) out.push(c);
      }
      return out;
    };
    // кожа: щёки, лоб, подбородок
    const skin = [];
    for (const i of [50, 280, 101, 330, 205, 425, 151, 108, 337, 199]) disk(P[i], r, skin);
    this.skinPhoto = robustColor(skin) || [0.85, 0.68, 0.58];

    // полигоны (проверка точки в многоугольнике через Path2D)
    const ctx = makeCanvas(1, 1).getContext('2d');
    const poly = (idx) => { const p = new Path2D(); idx.forEach((i, j) => (j ? p.lineTo(P[i].x, P[i].y) : p.moveTo(P[i].x, P[i].y))); p.closePath(); return p; };
    const inPoly = (idx, test) => {
      const path = poly(idx), xs = idx.map((i) => P[i].x), ys = idx.map((i) => P[i].y), out = [];
      const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
      const st = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 60));
      for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
        if (!ctx.isPointInPath(path, x, y) || (test && !test(x, y))) continue;
        const c = this._rgb(x, y); if (c) out.push(c);
      }
      return out;
    };
    const inner = poly(LIPS_IN);
    this.lipColor = robustColor(inPoly(LIPS_OUT, (x, y) => !ctx.isPointInPath(inner, x, y)));
    const brow = [];
    for (const B of BROWS) brow.push(...inPoly([...B.up, ...B.lo.slice().reverse()]));
    brow.sort((a, b) => lum(...a) - lum(...b));
    this.browColor = robustColor(brow.slice(0, Math.max(3, brow.length >> 1)));

    // радужка: кольцо между зрачком и лимбом, без бликов
    const iris = [];
    if (this.px.length > 473 && (this.bs.eyeBlinkLeft || 0) < 0.5) {
      for (const E of EYES) {
        const c = P[E.iris], rad = [1, 2, 3, 4].reduce((a, k) => a + Math.hypot(P[E.iris + k].x - c.x, P[E.iris + k].y - c.y), 0) / 4;
        for (let y = -rad; y <= rad; y += Math.max(0.5, rad / 10)) for (let x = -rad; x <= rad; x += Math.max(0.5, rad / 10)) {
          const d = Math.hypot(x, y) / rad;
          if (d < 0.4 || d > 0.85) continue;
          const col = this._rgb(c.x + x, c.y + y);
          if (col && lum(...col) < 0.75 && lum(...col) > 0.04) iris.push(col);
        }
      }
    }
    this.irisColor = robustColor(iris);

    // борода: подбородок и зона усов заметно темнее щёк
    const L = (idx) => { const a = []; for (const i of idx) disk(P[i], r * 0.8, a); const c = robustColor(a); return c ? lum(...c) : null; };
    const cheeks = L([50, 280, 101, 330]), chin = L([199, 175, 171, 396]), stache = L([164, 167, 393]);
    this.beard = cheeks && chin && stache ? clamp(((cheeks - Math.min(chin, (chin + stache) / 2)) / cheeks - 0.12) * 1.6, 0, 1) : 0;
    // веко относительно кожи (тени/макияж)
    const lid = [];
    for (const [a, b] of [[159, 52], [386, 282]]) disk(mid(P[a], mid(P[a], P[b])), r * 0.6, lid);
    const lc = robustColor(lid);
    this.lidTint = lc ? lc.map((v, k) => clamp(v / Math.max(0.05, this.skinPhoto[k]), 0.78, 1.03)) : null;

    // одежда: полоса ниже подбородка, без пикселей цвета кожи
    const cloth = [], sk = this.skinPhoto;
    for (let y = -1.75; y <= -1.35; y += 0.04) for (let x = -0.7; x <= 0.7; x += 0.05) {
      const p = this.fromHead(x, y), col = this._rgb(p.x, p.y);
      if (col && Math.hypot(col[0] - sk[0], col[1] - sk[1], col[2] - sk[2]) > 0.18) cloth.push(col);
    }
    this.clothColor = cloth.length > 40 ? robustColor(cloth) : null;
  }

  _hair() {
    const M = this.hairMask;
    this.hairStyle = null; this.hairColor = null; this.hairlineY = null;
    if (!M) return;
    const W = this.img.width, H = this.img.height;
    const isHair = (x, y) => {
      const p = this.fromHead(x, y);
      if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return null;
      return M.data[Math.floor((p.y / H) * M.h) * M.w + Math.floor((p.x / W) * M.w)] > 0;
    };
    const frac = (x0, x1, y0, y1) => {
      let n = 0, h = 0;
      for (let y = y0; y <= y1; y += 0.03) for (let x = x0; x <= x1; x += 0.03) { const v = isHair(x, y); if (v === null) continue; n++; if (v) h++; }
      return n ? h / n : null;
    };
    const top = frac(-0.45, 0.45, 0.75, 1.05);
    // нижний край волос по бокам лица: спускаемся, пока полоса заметно занята волосами
    let bottom = null;
    for (let y = 0; y > -1.9; y -= 0.05) {
      const f = Math.max(frac(-1.2, -0.62, y - 0.05, y) ?? 0, frac(0.62, 1.2, y - 0.05, y) ?? 0);
      if (f > 0.22) bottom = y - 0.05; else if (bottom !== null && y < bottom - 0.1) break;
    }
    this.hairBottom = bottom;
    this.hairStyle = top !== null && top < 0.12 ? 'none' : bottom !== null && bottom < -0.6 ? 'long' : 'short';
    // линия роста: первый пиксель волос вверх по средней линии от лба
    for (let y = Math.max(0.25, this.head[10].y - 0.15); y < 1.25; y += 0.01) if (isHair(0, y)) { this.hairlineY = y; break; }
    const cols = [], Wm = M.w, Hm = M.h;
    for (let y = 0; y < Hm; y += 2) for (let x = 0; x < Wm; x += 2) {
      if (!M.data[y * Wm + x]) continue;
      const c = this._rgb(((x + 0.5) / Wm) * W, ((y + 0.5) / Hm) * H);
      if (c) cols.push(c);
    }
    if (cols.length > 50) {                       // воспринимаемый цвет — светлая половина (без теней у корней)
      cols.sort((a, b) => lum(...a) - lum(...b));
      this.hairColor = robustColor(cols.slice(Math.floor(cols.length * 0.45), Math.floor(cols.length * 0.95)));
    }
  }

  /** Текстура кожи: кадр лица, освещение снято, брови/губы/волосы закрашены, края уходят в общий тон. */
  _texture() {
    const P = this.px, img = this.img;
    const xs = OVAL.map((i) => P[i].x), ys = OVAL.map((i) => P[i].y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 0.15 * (x1 - x0);
    x0 = Math.max(0, x0 - pad); x1 = Math.min(img.width, x1 + pad); y0 = Math.max(0, y0 - pad); y1 = Math.min(img.height, y1 + pad);
    const k = Math.min(1.5, 768 / Math.max(x1 - x0, y1 - y0));
    const TW = Math.max(16, Math.round((x1 - x0) * k)), TH = Math.max(16, Math.round((y1 - y0) * k));
    this.crop = { x0, y0, k, TW, TH };
    const T = (p) => ({ x: (p.x - x0) * k, y: (p.y - y0) * k });
    const c = makeCanvas(TW, TH), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, TW, TH);
    const src = g.getImageData(0, 0, TW, TH).data, n = TW * TH;
    const faceW = (Math.max(...xs) - Math.min(...xs)) * k;

    const mask = (draw) => {
      const m = makeCanvas(TW, TH), mg = m.getContext('2d', { willReadFrequently: true });
      mg.fillStyle = mg.strokeStyle = '#fff'; mg.lineJoin = mg.lineCap = 'round';
      draw(mg);
      const d = mg.getImageData(0, 0, TW, TH).data, out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = d[i * 4 + 3] / 255;
      return out;
    };
    const path = (mg, idx, scale = 1, cen = null) => {
      mg.beginPath();
      idx.forEach((i, j) => {
        let p = T(P[i]);
        if (cen) p = { x: cen.x + (p.x - cen.x) * scale, y: cen.y + (p.y - cen.y) * scale };
        j ? mg.lineTo(p.x, p.y) : mg.moveTo(p.x, p.y);
      });
      mg.closePath();
    };
    const cen = T(P[4]);
    const face = mask((mg) => { path(mg, OVAL, 0.97, cen); mg.fill(); });
    const fade = boxBlur(mask((mg) => { path(mg, OVAL, 0.9, cen); mg.fill(); }), TW, TH, faceW * 0.025);
    const holes = mask((mg) => {
      mg.lineWidth = faceW * 0.04;
      for (const B of BROWS) { path(mg, [...B.up, ...B.lo.slice().reverse()]); mg.fill(); mg.stroke(); }
      // губы с запасом: на улыбающихся фото — и тень под нижней губой, и складки в уголках
      const smile = this.expression?.smile || 0, mc = T(mid(P[13], P[14]));
      mg.lineWidth = faceW * 0.04;
      path(mg, LIPS_OUT, 1.12 + 0.3 * smile, mc); mg.fill(); mg.stroke();
      // глаза рисует 3D-модель (яблоко, веки, ресницы) — глаза со снимка убираем
      mg.lineWidth = faceW * 0.035;
      for (const ring of EYE_RINGS) { path(mg, ring); mg.fill(); mg.stroke(); }
    });
    // волосы на лбу (чёлка) — тоже дыра; ниже бровей маску волос не трогаем (борода остаётся в текстуре)
    const hairHole = new Float32Array(n);
    if (this.hairMask) {
      const M = this.hairMask, browY = T(mid(P[105], P[334])).y;
      for (let y = 0; y < TH; y++) {
        if (y > browY) break;
        for (let x = 0; x < TW; x++) {
          const ix = x / k + x0, iy = y / k + y0;
          if (M.data[Math.floor((iy / img.height) * M.h) * M.w + Math.floor((ix / img.width) * M.w)]) hairHole[y * TW + x] = 1;
        }
      }
    }
    const hb = boxBlur(hairHole, TW, TH, faceW * 0.012);
    const valid = new Float32Array(n);
    const holesSoft = boxBlur(holes, TW, TH, faceW * 0.018);      // мягкий край закраски — без контура «второго рта»
    for (let i = 0; i < n; i++) valid[i] = face[i] * (1 - Math.max(holes[i], clamp(holesSoft[i] * 1.6, 0, 1))) * clamp(1 - 2 * hb[i], 0, 1);

    // Освещение: гладкая квадратичная модель яркости по коже лица (МНК), делим на неё.
    // В отличие от локального размытия, борода, брови, макияж и родинки не «высветляются».
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = src[i * 4] / 255; G[i] = src[i * 4 + 1] / 255; B[i] = src[i * 4 + 2] / 255; }
    const fitLight = () => {
      const A = Array.from({ length: 6 }, () => new Float64Array(7));
      const cx = cen.x, cy = cen.y, sc = 1 / faceW;
      let sl = 0, sw = 0;
      for (let y = 0; y < TH; y += 3) for (let x = 0; x < TW; x += 3) {
        const i = y * TW + x;
        if (valid[i] < 0.95) continue;
        const u = (x - cx) * sc, v = (y - cy) * sc, l = lum(R[i], G[i], B[i]), f = [1, u, v, u * u, v * v, u * v];
        for (let a = 0; a < 6; a++) { for (let b = 0; b < 6; b++) A[a][b] += f[a] * f[b]; A[a][6] += f[a] * l; }
        sl += l; sw++;
      }
      for (let a = 0; a < 6; a++) A[a][a] += 1e-3;
      for (let c = 0; c < 6; c++) {                       // Гаусс 6×6
        let p = c; for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        [A[c], A[p]] = [A[p], A[c]];
        for (let r = 0; r < 6; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 7; k++) A[r][k] -= f * A[c][k]; }
      }
      const w = A.map((row, i) => row[6] / row[i]);
      return { mean: sl / Math.max(1, sw), at: (x, y) => { const u = (x - cx) * sc, v = (y - cy) * sc; return w[0] + w[1] * u + w[2] * v + w[3] * u * u + w[4] * v * v + w[5] * u * v; } };
    };
    const light = fitLight();
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const i = y * TW + x, gain = clamp(Math.pow(light.mean / Math.max(0.03, light.at(x, y)), 0.8), 0.6, 1.8);
      R[i] *= gain; G[i] *= gain; B[i] *= gain;
    }
    // чёрно-белое фото: раскрашиваем в тон кожи по умолчанию, светотень сохраняется
    let sat = 0, ns = 0;
    for (let i = 0; i < n; i += 11) if (valid[i] > 0.95) { sat += Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i]); ns++; }
    this.grayscale = ns > 0 && sat / ns < 0.025;
    if (this.grayscale) {
      const tone = [0.87, 0.66, 0.55];
      let ml = 0, nl = 0;
      for (let i = 0; i < n; i += 5) if (valid[i] > 0.95) { ml += lum(R[i], G[i], B[i]); nl++; }
      ml = ml / Math.max(1, nl) || 0.5;
      for (let i = 0; i < n; i++) { const l = lum(R[i], G[i], B[i]) / ml; R[i] = tone[0] * l; G[i] = tone[1] * l; B[i] = tone[2] * l; }
    }
    // общий тон кожи = робастное среднее по валидной коже после выравнивания
    const samples = [];
    for (let i = 0; i < n; i += 7) if (valid[i] > 0.95) samples.push([R[i], G[i], B[i]]);
    const S = robustColor(samples) || this.skinPhoto;
    // дыры и всё вне лица — заливка push-pull по соседней коже
    const w = Float32Array.from(valid, (v) => (v > 0.98 ? 1 : v * v * v));
    const filled = pushPull([Float32Array.from(R), Float32Array.from(G), Float32Array.from(B)], w, TW, TH);
    // смягчаем средние частоты (складки от улыбки, морщины): стилизованной голове они старят и «режут» лицо
    for (const C of filled) {
      const low = boxBlur(C, TW, TH, faceW * 0.03);
      for (let i = 0; i < n; i++) C[i] = low[i] + (C[i] - low[i]) * 0.55;
    }
    const out = [R, G, B];
    for (let ci = 0; ci < 3; ci++) {
      const F = filled[ci], O = out[ci];
      for (let i = 0; i < n; i++) O[i] = lerp(S[ci], F[i], fade[i]);
    }
    // рамка в 2 px = общий тон (туда смотрят UV затылка)
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      if (x > 1 && y > 1 && x < TW - 2 && y < TH - 2) continue;
      const i = y * TW + x; R[i] = S[0]; G[i] = S[1]; B[i] = S[2];
    }
    this.tex = { R, G, B, S };
    this.skinTex = S;
    // цвет век = кожа текстуры вокруг глаз (под и над глазом), иначе веко светлеет «полумесяцем»
    const lid = [0, 0, 0];
    let ln = 0;
    for (const [a, b2] of [[145, 0.35], [374, 0.35], [159, -0.35], [386, -0.35]]) {
      const e = T(P[a]), up = T(P[a === 145 || a === 159 ? 159 : 386]), lo = T(P[a === 145 || a === 159 ? 145 : 374]);
      const h = Math.max(2, Math.abs(lo.y - up.y)), cx = Math.round(e.x), cy = Math.round(e.y + h * b2 * 2.2);
      for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 3; x++) {
        if (x < 0 || y < 0 || x >= TW || y >= TH) continue;
        const i = y * TW + x; lid[0] += R[i]; lid[1] += G[i]; lid[2] += B[i]; ln++;
      }
    }
    this.lidTex = ln ? lid.map((v, k) => clamp(v / ln / Math.max(0.05, S[k]), 0.6, 1.05) * 0.94) : null;
  }

  /** Холст текстуры с силой фото t (0 — ровный тон кожи, 1 — полностью фото). */
  _textureCanvas(t) {
    const { TW, TH } = this.crop, { R, G, B, S } = this.tex;
    const c = makeCanvas(TW, TH), g = c.getContext('2d'), im = g.createImageData(TW, TH), d = im.data;
    for (let i = 0; i < TW * TH; i++) {
      d[i * 4] = clamp(lerp(S[0], R[i], t) * TEX_GAIN, 0, 1) * 255;
      d[i * 4 + 1] = clamp(lerp(S[1], G[i], t) * TEX_GAIN, 0, 1) * 255;
      d[i * 4 + 2] = clamp(lerp(S[2], B[i], t) * TEX_GAIN, 0, 1) * 255;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  /**
   * Параметры процедурной головы по фото.
   * @param {object} o { caricature=1.5 (0 — без шаржа, 1 — пропорции как на фото, >1 — усиление), texture=0.9, gender }
   * @returns {object} overrides для ProceduralHead
   */
  fit(o = {}) {
    const k = o.caricature ?? 1.5, tex = clamp(o.texture ?? 0.9, 0, 1), gender = o.gender === 'male' ? 'male' : 'female';
    const re = clamp(o.realism ?? 0.65, 0, 1);
    const key = `${k}|${tex}|${gender}|${re}`;
    if (this._fits.has(key)) return this._fits.get(key);
    const Q = this.meas, Mn = MEAN_M;
    // основа: пресет пола, сдвинутый к реальным пропорциям
    const d0 = PRESETS[gender];
    const baseEyeX = lerp(0.3, REAL.eyeX, re);
    const d = {
      ...d0,
      gx: d0.gx.map((v, i) => v * lerp(1, REAL_GX[gender][i], re)),
      eyeR: lerp(d0.eyeR, REAL.eyeW / (2 * 0.97 * 1.08), re),
      brow: { ...d0.brow, x0: 0.085 + (baseEyeX - 0.3) * 0.5, x1: 0.45 + (baseEyeX - 0.3) * 0.8 },
    };
    const baseChin = lerp(1, REAL.chinScale, re);
    const car = (f) => Mn[f] + k * (Q[f] - Mn[f]);
    const ratio = (f) => car(f) / Mn[f];

    const eyeX = clamp(baseEyeX + car('eyeCX') - Mn.eyeCX, 0.21, 0.36);
    const eyeR = Math.min(clamp(d.eyeR * ratio('eyeW'), 0.085, 0.145), (eyeX - 0.1) / 1.08);
    const openR = clamp(car('eyeH') / car('eyeW') / (Mn.eyeH / Mn.eyeW), 0.55, 1.7) ** 0.8;
    const upperOpen = clamp(d.upperOpen * openR, 12, 36), lowerOpen = clamp(d.lowerOpen * openR, -34, -12);
    const eyeTop = EY + eyeR * 1.08 * Math.sin((upperOpen * Math.PI) / 180);
    const brow = {
      ...d.brow,
      y: clamp(d.brow.y + car('browY') - Mn.browY, eyeTop + 0.06, 0.34),
      arch: clamp(d.brow.arch + car('browArch') - Mn.browArch, -0.01, 0.1),
      tail: clamp(-0.025 + car('browTail') - Mn.browTail, -0.12, 0.05),
      x0: clamp(d.brow.x0 + car('browX0') - Mn.browX0, 0.03, 0.16),
      x1: clamp(d.brow.x1 + car('browX1') - Mn.browX1, 0.32, 0.56),
      thick: clamp(d.brow.thick * ratio('browTh'), 0.01, 0.042),
    };
    if (this.browColor) brow.color = hex(this.browColor.map((v) => v * 0.85));
    const gx = d.gx.slice();
    const wr = Q.widths.map((r) => clamp(1 + k * (r - 1), 0.8, 1.25));
    for (let i = 0; i < 6; i++) gx[i + 2] = d.gx[i + 2] * wr[i];
    gx[0] = d.gx[0] * lerp(1, wr[0], 0.5); gx[1] = d.gx[1] * lerp(1, wr[0], 0.8); gx[8] = d.gx[8] * wr[5];

    const ov = {
      gx, eyeX, eyeR, upperOpen, lowerOpen,
      eyeTilt: clamp(d.eyeTilt + car('tilt') - Mn.tilt, -0.12, 0.28),
      brow,
      noseTipY: clamp(-0.21 + car('noseTip') - Mn.noseTip, -0.3, -0.13),
      noseW: clamp(0.07 * ratio('noseW'), 0.05, 0.1),
      nose: clamp(d.nose * ratio('noseProj') ** 0.6, 0.08, 0.24),
      mouthHW: clamp(d.mouthHW * ratio('mouthHW'), 0.13, 0.25),
      lipU: clamp(d.lipU * ratio('lipU'), 0.018, 0.085),
      lipL: clamp(d.lipL * ratio('lipL'), 0.022, 0.1),
      chinScale: clamp(baseChin * (car('chin') - MY) / (Mn.chin - MY), 0.8, 1.5),
      ...(Q.bowX ? {
        bowX: clamp(lerp(0.2, BOW_MEAN.x, re) + k * (Q.bowX - BOW_MEAN.x), 0.12, 0.36),
        bowDip: clamp(0.2 + k * 1.09 * (BOW_MEAN.rc - Q.bowRC), 0.02, 0.45),
      } : {}),
      skin: hex(this.skinTex.map((v) => v * TEX_GAIN)),
      blush: d.blush * 0.15, stubble: 0,
    };
    if (this.lipColor && !this.grayscale) ov.lip = hex(this.lipColor);
    if (this.irisColor && !this.grayscale) ov.iris = [hex(this.irisColor.map((v) => v * 1.25)), hex(this.irisColor.map((v) => v * 0.55))];
    if (this.lidTex && tex > 0) ov.lidTint = this.lidTex.map((v) => lerp(1, v, tex));
    if (this.beard > 0.05) ov.stubble = this.beard * 2.2;      // борода/щетина: затемнение челюсти и усов поверх текстуры
    if (this.hairColor) ov.hair = hex(this.hairColor.map((v) => v * 1.05));
    if (this.clothColor) ov.cloth = hex(this.clothColor);
    if (this.hairStyle) {
      ov.hairStyle = this.hairStyle;
      if (this.hairStyle === 'long' && this.hairBottom !== null) ov.hairBottom = clamp(this.hairBottom, -1.7, -0.75);
      ov.ears = this.hairStyle !== 'long';
      if (this.hairlineY !== null) ov.hairline = clamp(this.hairlineY - (this.hairStyle === 'long' ? 0.6 : 0.64), -0.2, 0.22);
    }
    if (tex > 0 && this.tex) ov.photo = this._photoMapping(ov, this._textureCanvas(tex));
    this._fits.set(key, ov);
    return ov;
  }

  /** Отображение вершин головы → UV снимка (TPS по опорным точкам), строится при сборке головы. */
  _photoMapping(ov, canvas) {
    const portrait = this, { x0, y0, k: ck, TW, TH } = this.crop;
    let warp = null;
    const tmp = { x: 0, y: 0 };
    return {
      canvas,
      prepare({ pos, hm, eye, P }) {
        // силуэт головы спереди: max |x| по высоте
        const sil = new Float32Array(260);
        for (let i = 0; i < pos.length; i += 3) {
          const b = Math.round((pos[i + 1] + 1.4) * 100);
          if (b >= 0 && b < 260) sil[b] = Math.max(sil[b], Math.abs(pos[i]));
        }
        const silW = (y) => sil[clamp(Math.round((y + 1.4) * 100), 0, 259)];
        // низ подбородка: где передняя поверхность по средней линии уходит назад
        const zc = hm.get(0, -0.75);
        let menton = -0.95;
        for (let y = -0.7; y > -1.3; y -= 0.005) if (hm.get(0, y) < zc - 0.1) { menton = y; break; }

        const ph = portrait.px, hs = portrait.head, Q = portrait.meas;
        const S = [], D = [];
        const add = (x, y, i) => { S.push({ x, y }); D.push(typeof i === 'number' ? ph[i] : i); };
        // глаза: уголки и середины век
        const T = P.eyeTilt, cT = Math.cos(T), sT = Math.sin(T), c = eye.rs * 0.97;
        const hU = eye.rs * Math.sin((P.upperOpen * Math.PI) / 180), hL = eye.rl * Math.sin((P.lowerOpen * Math.PI) / 180);
        for (const E of EYES) {
          const sg = E.sg, ex = sg * eye.x;
          add(ex + sg * c * cT, EY + c * sT, E.outer);
          add(ex - sg * c * cT, EY - c * sT, E.inner);
          add(ex - sg * sT * hU, EY + cT * hU, E.top);
          add(ex - sg * sT * hL, EY + cT * hL, E.bottom);
        }
        // брови (в покое — та же формула, что в _updateBrows)
        const B = P.brow;
        for (const BR of BROWS) for (let j = 0; j < 5; j++) {
          const s = j / 4;
          const x = lerp(B.x0 ?? 0.085, B.x1 ?? 0.45, s);
          const y = B.y + B.arch * Math.sin(Math.PI * Math.min(1, s * 1.12)) ** 0.9 + (B.tail ?? -0.025) * s * s;
          add(BR.sg * x, y, mid(ph[BR.up[j]], ph[BR.lo[j]]));
        }
        // нос
        const tipY = P.noseTipY ?? -0.21, nInv = (yn) => EY + ((yn - EY) * (EY - tipY)) / 0.24, nw = P.noseW ?? 0.07;
        add(0, tipY, 4);
        add(0, nInv(-0.29), 2);
        add(nw * 1.9, nInv(-0.25), 358); add(-nw * 1.9, nInv(-0.25), 129);
        // рот: уголки, «лук Купидона», центр нижней губы, внутренний контур
        const hw = P.mouthHW;
        add(hw, MY, 291); add(-hw, MY, 61);
        add(0, MY + P.lipU * upperLipProfile(0, P), 0);
        const tb = P.bowX ?? clamp(Math.abs(hs[267].x - hs[37].x) / Math.abs(hs[291].x - hs[61].x), 0.1, 0.5);
        const peakY = MY + P.lipU * upperLipProfile(tb, P);
        add(tb * hw, peakY, 267); add(-tb * hw, peakY, 37);
        add(0, MY - P.lipL, 17);
        add(0, MY + 0.002, 13); add(0, MY - 0.002, 14);
        // подбородок и овал (по силуэту собранной головы)
        add(0, menton, 152);
        const chinP = hs[152].y;
        for (const i of OVAL) {
          if (i === 152) continue;
          const p = hs[i];
          let y = p.y < MY ? MY + ((p.y - MY) * (menton - MY)) / (chinP - MY) : p.y;
          if (i === 10) { add(0, y, i); continue; }
          add(Math.sign(p.x) * silW(y) * 0.94, y, i);     // овал лица чуть уже силуэта черепа
        }
        // дальние якоря — подобие, чтобы сплайн не «улетал» за пределами лица
        for (const [x, y] of [[-1.5, 1.5], [1.5, 1.5], [-1.5, -1.8], [1.5, -1.8], [0, 1.7], [0, -2], [-1.8, -0.2], [1.8, -0.2]]) add(x, y, portrait.fromHead(x * 0.8, y));
        warp = thinPlate(S, D);
        portrait._lastControl = { S, D };
      },
      uv(x, y, z, out) {
        if (z < 0.02 || !warp) { out[0] = 0.5 / TW; out[1] = 1 - 0.5 / TH; return; }
        warp(x, y, tmp);
        out[0] = clamp(((tmp.x - x0) * ck) / TW, 0, 1);
        out[1] = 1 - clamp(((tmp.y - y0) * ck) / TH, 0, 1);
      },
    };
  }

  /**
   * Компактный слепок анализа: точки лица, меры, цвета и текстура кожи (WebP/JPEG).
   * Самого фото в нём нет — только то, из чего собирается голова. Восстановление — Portrait.fromData (без MediaPipe).
   * @param {object} [o] { size=320 — макс. сторона текстуры, px (0 — без текстуры); quality=0.8 }
   */
  async toData(o = {}) {
    const size = o.size ?? 320, quality = o.quality ?? 0.8;
    const r4 = (v) => (v === null || v === undefined ? null : Math.round(v * 1e4) / 1e4);
    const rc = (c) => (c ? c.map(r4) : null);
    // точки: int16, 1/8 пикселя, относительно центра глаз
    const c = this.frame.c, lm = new Int16Array(this.px.length * 3);
    this.px.forEach((p, i) => { lm[i * 3] = Math.round((p.x - c.x) * 8); lm[i * 3 + 1] = Math.round((p.y - c.y) * 8); lm[i * 3 + 2] = Math.round(p.z * 8); });
    const meas = {};
    for (const [k, v] of Object.entries(this.meas)) meas[k] = Array.isArray(v) ? v.map(r4) : r4(v);
    const d = {
      format: 'anima-portrait', v: 1,
      origin: [r4(c.x), r4(c.y)], lm: b64(new Uint8Array(lm.buffer)),
      meas, warnings: this.warnings, expression: Object.fromEntries(Object.entries(this.expression).map(([k, v]) => [k, r4(v)])),
      colors: { skinPhoto: rc(this.skinPhoto), skin: rc(this.skinTex), lip: rc(this.lipColor), brow: rc(this.browColor), iris: rc(this.irisColor), hair: rc(this.hairColor), cloth: rc(this.clothColor) },
      lidTex: rc(this.lidTex), beard: r4(this.beard), grayscale: !!this.grayscale,
      hair: { style: this.hairStyle, bottom: r4(this.hairBottom), line: r4(this.hairlineY) },
      tex: null,
    };
    if (size > 0 && this.tex) {
      const { x0, y0, k, TW, TH } = this.crop, { R, G, B } = this.tex;
      const full = makeCanvas(TW, TH), g = full.getContext('2d'), im = g.createImageData(TW, TH), px = im.data;
      for (let i = 0; i < TW * TH; i++) {           // значения после выравнивания света бывают > 1: храним /TEX_MAX
        px[i * 4] = clamp(R[i] / TEX_MAX, 0, 1) * 255; px[i * 4 + 1] = clamp(G[i] / TEX_MAX, 0, 1) * 255;
        px[i * 4 + 2] = clamp(B[i] / TEX_MAX, 0, 1) * 255; px[i * 4 + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const s = Math.min(1, size / Math.max(TW, TH)), w = Math.max(8, Math.round(TW * s)), h = Math.max(8, Math.round(TH * s));
      const small = makeCanvas(w, h), sg = small.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(full, 0, 0, w, h);
      let url = small.toDataURL('image/webp', quality);
      if (!url.startsWith('data:image/webp')) url = small.toDataURL('image/jpeg', quality);   // Safari < 14
      d.tex = { x0: r4(x0), y0: r4(y0), k: r4((k * w) / TW), w, h, S: rc(this.tex.S), img: url };
    }
    return d;
  }

  /** Восстановить портрет из toData() без распознавания. */
  static async fromData(d) {
    if (typeof d === 'string') d = JSON.parse(d);
    if (!d || d.format !== 'anima-portrait') throw new Error('Не похоже на слепок аватара (format anima-portrait)');
    if (d.v > 1) throw new Error(`Слепок новой версии (v${d.v}), обновите библиотеку`);
    const p = Object.create(Portrait.prototype);
    p.isPortrait = true;
    const raw = ub64(d.lm), lm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1), [ox, oy] = d.origin;
    p.px = [];
    for (let i = 0; i < lm.length; i += 3) p.px.push({ x: ox + lm[i] / 8, y: oy + lm[i + 1] / 8, z: lm[i + 2] / 8 });
    p._initFrame();
    p.meas = d.meas; p.warnings = d.warnings || []; p.expression = d.expression || {};
    const C = d.colors || {};
    p.skinPhoto = C.skinPhoto || C.skin || [0.85, 0.68, 0.58]; p.skinTex = C.skin || p.skinPhoto;
    p.lipColor = C.lip; p.browColor = C.brow; p.irisColor = C.iris; p.hairColor = C.hair; p.clothColor = C.cloth;
    p.lidTex = d.lidTex; p.beard = d.beard || 0; p.grayscale = !!d.grayscale;
    p.hairStyle = d.hair?.style ?? null; p.hairBottom = d.hair?.bottom ?? null; p.hairlineY = d.hair?.line ?? null;
    p.tex = null;
    if (d.tex?.img) {
      const t = d.tex, bmp = await createImageBitmap(await (await fetch(t.img)).blob());
      const c = makeCanvas(t.w, t.h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, t.w, t.h);
      const px = g.getImageData(0, 0, t.w, t.h).data, n = t.w * t.h;
      const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0; i < n; i++) { R[i] = (px[i * 4] / 255) * TEX_MAX; G[i] = (px[i * 4 + 1] / 255) * TEX_MAX; B[i] = (px[i * 4 + 2] / 255) * TEX_MAX; }
      p.crop = { x0: t.x0, y0: t.y0, k: t.k, TW: t.w, TH: t.h };
      p.tex = { R, G, B, S: t.S || p.skinTex };
    }
    p._fits = new Map();
    return p;
  }

  /** Сводка для UI/отладки. */
  get report() {
    const hx = (c) => (c ? hex(c) : null);
    return {
      warnings: this.warnings, yaw: +this.yaw.toFixed(3), expression: this.expression,
      hairStyle: this.hairStyle, colors: { skin: hx(this.skinTex), lip: hx(this.lipColor), brow: hx(this.browColor), iris: hx(this.irisColor), hair: hx(this.hairColor), cloth: hx(this.clothColor) },
      measures: Object.fromEntries(Object.entries(this.meas).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, +(v / MEAN_M[k]).toFixed(3)])),
      widths: this.meas.widths.map((v) => +v.toFixed(3)),
      widthsAbs: this.meas.widthsAbs.map((v) => (v ? +v.toFixed(4) : null)),
    };
  }
}
