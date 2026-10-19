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
import { PRESETS, LAYOUT, upperLipProfile, prof } from './head-model.js';
import { thinPlate } from './tps.js';

const MP = '0.10.14';
export const PHOTO_ASSETS = {
  module: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/vision_bundle.mjs`,
  wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`,
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hair: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite',
  // классы: фон, волосы, кожа тела, кожа лица, одежда, прочее (очки, украшения). 16 МБ — грузится только при accessories: true
  multi: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;
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
 * @param {object} [o] { assets, onProgress(text), detail: 'full' (= accessories: true) — очки и головные уборы, +16 МБ модель }
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
  let multi = null;
  if (o.accessories || o.detail === 'full') {
    say('Ищу очки и аксессуары…');
    try {
      const seg = await loadMulti(A), res = seg.segment(img), m = res.categoryMask;
      multi = { data: m.getAsUint8Array().slice(), w: m.width, h: m.height };
      res.close?.();
    } catch (e) { /* без аксессуаров */ }
  }
  say('Строю голову…');
  return new Portrait(img, L, bs, hair, multi);
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
// меры, которые рендер передаёт ненадёжно (MediaPipe на стилизованной голове): в «направление» не входят
const NO_DIR = new Set(['upS', 'upF', 'loS', 'loF', 'noseProj']);
const MEAS_SCALE = (k) => (POS_MEAS.has(k) ? 0.05 : Math.abs(MEAN_M[k]) || 1);

/** Нормированные точки (координаты головы, симметризованные) для найденного лица. */
export function normalizedFace(det) {
  const p = Object.create(Portrait.prototype);
  p.px = det.L.map((q) => ({ x: q.x * det.w, y: q.y * det.h, z: q.z * det.w }));
  p._initFrame();
  return p;
}

/** Меры лица на рендере (те же, что у фото, плюс ширины овала в долях POP_W). */
export function measureFace(det) {
  const F = normalizedFace(det), M = measure(F.sym);
  M.widths = WIDTH_YS.map((y, i) => {
    const w = ovalHalfWidth(F.sym, y >= MY ? y : MY + ((y - MY) * (M.chin - MY)) / (MEAN_M.chin - MY));
    return w && POP_W[i] ? w / POP_W[i] : 1;
  });
  return M;
}

/**
 * Один шаг уточнения: поправки мер, чтобы рендер (R) пришёл к цели D = B + k·(Q − M),
 * где B — рендер той же головы без шаржа, Q — лицо на фото, M — среднее лицо.
 * @param {object} corr { meas, widths } — изменяется на месте
 * @param {object} [target] своя цель вместо D (для калибровки основы): { meas, widths }
 */
export function refineStep(portrait, corr, R, B, k, o = {}) {
  const a = o.alpha ?? 0.8, Q = portrait.meas, err = {};
  corr.meas ||= {}; corr.widths ||= [0, 0, 0, 0, 0, 0];
  for (const f of o.meas || REFINE_MEAS) {
    const D = o.target ? o.target.meas[f] : B[f] + k * (Q[f] - MEAN_M[f]);
    const e = D - R[f];
    corr.meas[f] = (corr.meas[f] || 0) + a * e;
    err[f] = e / MEAS_SCALE(f);
  }
  for (let i = 0; i < 6 && o.widths !== false; i++) {
    const D = o.target ? o.target.widths[i] : B.widths[i] * (1 + k * (Q.widths[i] - 1));
    const e = (D - R.widths[i]) / Math.max(0.3, (B || R).widths[i]);
    if (i > 0) corr.widths[i] += a * e;                            // widths[0] (лоб) часто под волосами — не трогаем
  }
  const v = Object.values(err);
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);    // ошибка до шага (нормированная)
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
    if (typeof Q[k] !== 'number' || NO_DIR.has(k)) continue;
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

// ------------------------------------------------------------------ деформация по точкам (refineShape)

// ведущие точки: овал (без верха лба — он под волосами) и нос; якоря с нулевым смещением — черты с параметрами
const WARP_DRIVE = [...REGIONS.oval, ...NOSE];
const WARP_FIX = [...new Set([...EYE_RINGS.flat(), ...BROWS.flatMap((b) => [...b.up, ...b.lo]), ...LIPS_OUT, 10, 338, 109, 297, 67])];
const WARP_WIN = [0, -0.2, 0.75, 0.78];                       // эллипс по контуру лица: снаружи поле берётся с границы (ProceduralHead._initWarp)
const WARP_MAX = 0.12;

/**
 * Один шаг деформации: смещения ведущих точек, чтобы точки рендера R пришли к цели
 * D = lerp(B, M, realism) + k·(Q − M): B — рендер без шаржа, Q — фото, M — среднее лицо.
 * realism = 1 — цель «как на фото» (при k = 1), 0 — сохраняется стилизация основы.
 * Источники TPS — положения точек на первом рендере (до деформации); смещения накапливаются в portrait.warp.
 * @returns {number} ошибка ведущих точек до шага, % расстояния глаза–рот
 */
export function shapeStep(portrait, render, base, k, o = {}) {
  const a = o.alpha ?? 0.7, re = base ? clamp(o.realism ?? 0.8, 0, 1) : 1;
  const Q = portrait.sym, R = normalizedFace(render).sym, B = base ? normalizedFace(base).sym : null;
  let W = portrait.warp;
  if (!W) {
    W = portrait.warp = { k, n: WARP_DRIVE.length, win: WARP_WIN, pts: [] };
    for (const i of WARP_DRIVE) W.pts.push([R[i].x, R[i].y, 0, 0]);
    for (const i of WARP_FIX) W.pts.push([R[i].x, R[i].y, 0, 0]);
  }
  let se = 0;
  WARP_DRIVE.forEach((i, j) => {
    const m = MEAN[i], bx = B ? lerp(B[i].x, m.x, re) : m.x, by = B ? lerp(B[i].y, m.y, re) : m.y;
    const ex = bx + k * (Q[i].x - m.x) - R[i].x, ey = by + k * (Q[i].y - m.y) - R[i].y;
    se += ex * ex + ey * ey;
    const p = W.pts[j];
    p[2] = clamp(p[2] + a * ex, -WARP_MAX, WARP_MAX); p[3] = clamp(p[3] + a * ey, -WARP_MAX, WARP_MAX);
  });
  return Math.sqrt(se / WARP_DRIVE.length) * 100 / (EY - MY);
}

let _multi = null, _multiKey = '';
/** Многоклассовый сегментатор (по запросу): маска «прочее» = очки и аксессуары. */
async function loadMulti(A) {
  if (_multi && _multiKey === A.multi) return _multi;
  _multiKey = A.multi;
  _multi = (async () => {
    const V = await import(/* @vite-ignore */ A.module);
    const fs = await V.FilesetResolver.forVisionTasks(A.wasm);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: A.multi, delegate }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
    // CPU: GPU-делегат на тонких оправах даёт другую (худшую) маску; сеть 256×256 запускается один раз — CPU хватает
    return V.ImageSegmenter.createFromOptions(fs, opts('CPU'));
  })();
  _multi.catch(() => { _multi = null; });
  return _multi;
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
    noseTip: P[4].y, noseW: P[358].x, noseBr: (P[351].x + P[419].x) / 2,
    noseProj: Math.max(0.02, P[4].z - (P[362].z + P[263].z) / 2),
    mouthHW: P[291].x, lipU: Math.max(0.005, P[0].y - P[13].y), lipL: Math.max(0.005, P[14].y - P[17].y),
    chin: P[152].y,
    ...lidShape(P),
  };
}

// контур левого глаза персонажа: от внешнего угла (263) к внутреннему (362)
const LID_UP = [263, 466, 388, 387, 386, 385, 384, 398, 362], LID_LO = [263, 249, 390, 373, 374, 380, 381, 382, 362];
/** Форма разреза: перекос (смещение вершины дуги к внешнему углу, u ∈ −1…1) и полнота (высота у краёв / в середине). */
function lidShape(P) {
  const o = P[263], n = P[362], cx = (o.x + n.x) / 2, hw = (o.x - n.x) / 2 || 1e-4;
  const side = (idx, sgn) => {
    let sh = 0, shu = 0, mid = 0, edge = 0, ne = 0;
    for (const i of idx) {
      const u = (P[i].x - cx) / hw, h = sgn * (P[i].y - lerp(n.y, o.y, (u + 1) / 2));
      if (h <= 0) continue;
      sh += h; shu += h * u;
      if (Math.abs(u) < 0.25) mid = Math.max(mid, h);
      else if (Math.abs(u) > 0.45 && Math.abs(u) < 0.85) { edge += h; ne++; }
    }
    return { S: sh ? shu / sh : 0, F: mid ? edge / Math.max(1, ne) / mid : 0.7 };
  };
  const U = side(LID_UP, 1), L = side(LID_LO, -1);
  return { upS: U.S, upF: U.F, loS: L.S, loF: L.F };
}
const CANON_M = measure(MEAN);
// Калибровка «среднего» по реальным фото (canonical model MediaPipe — не среднее фото: глаза у неё прищурены,
// овал шире видимого и т.д.). Множители к мерам canonical; tilt — абсолютное значение (рад).
const CALIB = { eyeH: 1.65, eyeCX: 0.93, noseTip: 1.15, noseW: 1.13, noseProj: 0.95, mouthHW: 0.97, lipU: 0.8, lipL: 1.09,
  chin: 0.885, browY: 0.81, browArch: 1.85, browTail: 0.6, browTh: 0.83 };
export const MEAN_M = { ...CANON_M };
for (const k in CALIB) MEAN_M[k] = CANON_M[k] * CALIB[k];
MEAN_M.tilt = 0.09;
// форма разреза: средние по калибровочным фото (canonical-модель здесь не годится — глаза у неё прищурены)
Object.assign(MEAN_M, { upS: 0.06, upF: 0.643, loS: 0.201, loF: 0.575 });
const POP_W = [null, 0.515, 0.548, 0.532, 0.47, 0.289];        // медиана видимой полуширины овала по калибровочным фото
// Стилизованная голова шире настоящей (большой череп, широко посаженные крупные глаза, короткий подбородок).
// В фото-режиме основа сдвигается к реальным пропорциям (o.realism), и уже от неё строится шарж.
// множители gx при realism = 1: силуэт → 1.1 × средний видимый овал (верх черепа оставляем крупнее — стиль и объём волос)
const REAL_GX = {
  female: [0.86, 0.83, 0.78, 0.76, 0.8, 0.83, 0.88, 0.79, 0.79],
  male: [0.85, 0.81, 0.76, 0.74, 0.77, 0.78, 0.78, 0.68, 0.68],
};
const REAL = { eyeX: 0.234, eyeW: 0.207, chinScale: 1 };
// Калибровка основы через рендер (tests/calibrate.mjs): сдвиг мер при realism = 1, чтобы голова без шаржа
// совпадала со «средним лицом» по положению бровей, носа, губ и т.п. (в единицах мер; widths — доли ширины).
const BASE_CORR = {
  female: { browY: -0.1098, browArch: 0.0183, browTail: 0.0529, browX0: -0.0018, browX1: 0.0196, browTh: -0.002, noseTip: -0.0405, noseW: 0.0299, mouthHW: -0.0154, lipU: -0.0159, lipL: 0.0162, widths: [0, 0.0871, -0.0319, -0.0334, -0.0698, 0.2957] },
  male: { browY: -0.0858, browArch: 0.0281, browTail: 0.0505, browX0: -0.0035, browX1: 0.0092, browTh: -0.0045, noseTip: -0.0419, noseW: 0.0225, mouthHW: -0.017, lipU: -0.0154, lipL: 0.0267, widths: [0, 0.0541, -0.0499, -0.0453, -0.0831, 0.2947] },
};
export const REFINE_MEAS = ['eyeCX', 'eyeW', 'eyeH', 'tilt', 'browY', 'browArch', 'browTail', 'browX0', 'browX1', 'browTh', 'noseTip', 'noseW', 'mouthHW', 'lipU', 'lipL', 'chin'];
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
  constructor(img, L, bs, hair, multi = null) {
    this.isPortrait = true;
    this.multiMask = multi;
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
    this._facialHair();
    this._glasses();
    this._hat();
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

  /**
   * Асимметрия глаз (2.10) по несимметризованным точкам. Система координат головы выравнивает линию глаз по углам,
   * поэтому разница высот меряется относительно средней линии лица (переносица 168 → подбородок 152).
   * open — раскрытие (высота / ширина) каждого глаза, lift — центр щели над линией углов того же глаза,
   * dy — высота глаза (центр углов) относительно другого в системе средней линии.
   */
  _eyeAsym() {
    const P = this.head, avg = (idx) => idx.reduce((s, i) => s + P[i].y, 0) / idx.length;
    const eye = (o, n, up, lo) => {
      const w = Math.hypot(P[o].x - P[n].x, P[o].y - P[n].y), h = avg(up) - avg(lo), cy = (P[o].y + P[n].y) / 2;
      return { open: h / w, lift: ((avg(up) + avg(lo)) / 2 - cy) / w, cx: (P[o].x + P[n].x) / 2, cy, w };
    };
    const L = eye(263, 362, [385, 386, 387], [380, 374, 373]), R = eye(33, 133, [158, 159, 160], [153, 145, 144]);
    const phi = Math.atan2(P[168].x - P[152].x, P[168].y - P[152].y);    // наклон средней линии от вертикали
    const ry = (e) => e.cy * Math.cos(phi) + e.cx * Math.sin(phi);
    this.eyeAsymRaw = { openL: L.open, openR: R.open, liftL: L.lift, liftR: R.lift, dy: (ry(L) - ry(R)) / ((L.w + R.w) / 2), wr: L.w / R.w };
  }

  /**
   * Цвет зубов (3.9), если они видны: пиксели внутри внутреннего контура губ — светлые и малонасыщенные
   * (тёмная полость и красный язык отсеиваются). Желтизна ((r+g)/2 − b)/L сравнивается с белком глаза
   * того же снимка — так снимается цветовой оттенок света и камеры.
   */
  _teeth() {
    this.teethTone = null;
    const px = this.px, W = this.img.width, H = this.img.height;
    const INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
    const EYES = [[33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7], [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]];
    const inside = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = px[poly[i]], b = px[poly[j]]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
    const sample = (poly) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of poly) { x0 = Math.min(x0, px[i].x); x1 = Math.max(x1, px[i].x); y0 = Math.min(y0, px[i].y); y1 = Math.max(y1, px[i].y); }
      const out = [], st = Math.max(1, Math.round((x1 - x0) / 60));
      for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, y1); y += st) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, x1); x += st) if (inside(poly, x, y)) { const c = this._rgb(x, y); if (c) out.push(c); }
      return out;
    };
    const sat = (c) => { const M = Math.max(...c), m = Math.min(...c); return M > 0 ? (M - m) / M : 0; };
    const yel = (c) => ((c[0] + c[1]) / 2 - c[2]) / Math.max(0.05, lum(...c));
    const light = (arr) => { arr.sort((a, b) => lum(...b) - lum(...a)); return arr.slice(0, Math.max(1, Math.floor(arr.length * 0.3))); };
    const mouth = sample(INNER), all = mouth.length;
    const teeth = mouth.filter((c) => lum(...c) > 0.3 && sat(c) < 0.4);
    if (all < 40 || teeth.length < Math.max(25, all * 0.12)) return;
    const scl = light(EYES.flatMap(sample).filter((c) => sat(c) < 0.3));
    if (scl.length < 8) return;
    const t = robustColor(light(teeth.slice()));
    const yT = yel(t), yS = scl.reduce((a, c) => a + yel(c), 0) / scl.length;
    if (sat(t) < 0.01 && Math.abs(yS) < 1e-3) return;                     // чёрно-белый снимок — цвета нет
    this.teethTone = { yT, yS, d: yT - yS, frac: teeth.length / all, color: t };
  }

  /**
   * Асимметрия и форма губ (3.8) по несимметризованным точкам, в системе средней линии лица.
   * Пары точек (правая, левая персонажа): толщина верхней губы — внешний ↔ внутренний контур, нижней — то же.
   */
  _lipAsym() {
    const P = this.head, phi = Math.atan2(P[168].x - P[152].x, P[168].y - P[152].y), c = Math.cos(phi), s = Math.sin(phi);
    const Y = (i) => P[i].y * c + P[i].x * s, X = (i) => P[i].x * c - P[i].y * s;
    const hw = (X(291) - X(61)) / 2;
    const th = (pairs) => pairs.map(([o, n]) => Math.abs(Y(o) - Y(n)));
    const UP = [[37, 82], [267, 312], [39, 81], [269, 311], [40, 80], [270, 310]];
    const LO = [[84, 87], [314, 317], [181, 178], [405, 402], [91, 88], [321, 318]];
    const u = th(UP), l = th(LO), sumR = (a) => a[0] + a[2] + a[4], sumL = (a) => a[1] + a[3] + a[5];
    const lc = Math.abs(Y(17) - Y(14)), lm = (Math.abs(Y(181) - Y(178)) + Math.abs(Y(405) - Y(402))) / 2;
    this.lipAsymRaw = {
      corner: (Y(291) - Y(61)) / hw,                                  // левый уголок выше правого (> 0)
      up: (sumL(u) - sumR(u)) / (sumL(u) + sumR(u)), lo: (sumL(l) - sumR(l)) / (sumL(l) + sumR(l)),
      loFull: lm / Math.max(1e-4, lc), xm: ((X(405) - X(181)) / 2) / hw,  // полнота нижней губы: толщина на ~середине стороны / в центре
      shift: (X(291) + X(61)) / 2 / hw,
    };
  }

  /**
   * Губы → параметры (3.8). Уголки: разница высот минус поправка на поворот (−0.561·yaw, регрессия по 19 портретам;
   * остаток анфас ±0.045 полуширины рта). Полнота нижней губы — отношение толщины на середине стороны к центру
   * (среднее 0.775) → показатель профиля lipLoShape. Разница толщины левой и правой половин (±0.01–0.02) на уровне
   * шума точек — по фото не переносится (только look: lipUAsym, lipLAsym).
   */
  _lipAsymOv(k, mouthHW) {
    const A = this.lipAsymRaw;
    if (!A || !(k > 0)) return {};
    const out = {}, r = (v) => Math.round(v * 10000) / 10000;
    const w = smoothstep(0.15, 0.05, Math.abs(this.yaw)) * k;
    const soft = (v, t) => Math.sign(v) * Math.max(0, Math.abs(v) - t);
    const c = clamp(soft(A.corner + 0.561 * this.yaw - 0.003, 0.03) * w, -0.15, 0.15) * mouthHW;
    if (c) { out.mouthCornerL = r(c / 2); out.mouthCornerR = r(-c / 2); }
    // профиль (1 − |t|^e)^0.5: на |t| = 0.55 у основы (e = 2.2) отношение 0.855 ↔ среднее фото 0.775
    const tgt = clamp(0.855 * (1 + k * (A.loFull / 0.775 - 1)), 0.72, 0.95);
    out.lipLoShape = r(clamp(Math.log(1 - tgt * tgt) / Math.log(0.55), 1.4, 4));
    return out;
  }

  /**
   * Пол по фото (7.2): логистическая модель по признакам, которые распознавание уже считает — борода и усы, длина
   * волос, насыщенность и краснота губ относительно кожи, «тень щетины» на подбородке и над губой, пропорции лица
   * (брови, глаза, губы, нос, подбородок, ширина низа овала), галстук и открытый вырез. Обучена на 136 размеченных
   * портретах; проверка «по одному»: верно 91 % (всегда «мужской» — 78 %), уверенные ответы (p < 0.3 или > 0.7) —
   * 83 % снимков, из них верно 94 %. Возвращает { gender, p (вероятность женского), confident } или null.
   */
  genderGuess() {
    if (!this.meas || !this.facial) return null;
    const o = this.outfitRaw || {}, bw = !!o.bw, f = this.facial, m = this.meas;
    const sat = (c) => { if (!c) return 0; const M = Math.max(...c), n = Math.min(...c); return M > 0 ? (M - n) / M : 0; };
    const lip = this.lipColor, sk = this.skinPhoto, r = (k) => (typeof m[k] === 'number' && MEAN_M[k] ? m[k] / MEAN_M[k] : 1);
    const x = {
      beard: this.beardStyle?.style && this.beardStyle.style !== 'none' ? 1 : 0, moustache: this.beardStyle?.moustache ? 1 : 0,
      long: this.hairStyle === 'long' ? 1 : 0,
      lipSat: bw ? 0 : sat(lip) - sat(sk), redness: bw || !lip || !sk ? 0 : (lip[0] - lip[1]) - (sk[0] - sk[1]),
      chinTex: Math.log(Math.max(0.3, f.chin?.tex ?? 1)), jawTex: Math.log(Math.max(0.3, f.jaw?.tex ?? 1)), stacheDark: f.stache?.dark ?? 0,
      browY: r('browY'), browTh: r('browTh'), eyeH: r('eyeH'), lipU: r('lipU'), lipL: r('lipL'), noseW: r('noseW'), chin: r('chin'),
      chinSq: typeof m.chinSq === 'number' ? m.chinSq : 0, w4: m.widths?.[4] || 0, w5: m.widths?.[5] || 0,
      tie: o.tie || 0, skinA: bw ? 0 : o.skinA || 0,
    };
    const W = { beard: -0.3373, moustache: -0.6442, long: 1.7952, lipSat: 2.4908, redness: 6.5038, chinTex: -0.5672, jawTex: 0.8693, stacheDark: -1.8026,
      browY: 2.7683, browTh: -7.3379, eyeH: 4.1997, lipU: -0.183, lipL: 1.9179, noseW: 3.4783, chin: -5.5209, chinSq: 2.7622, w4: -1.7348, w5: -0.1847, tie: -1.1836, skinA: 2.6803 };
    let z = -0.042;
    for (const k in W) z += W[k] * x[k];
    const p = 1 / (1 + Math.exp(-z));
    return { gender: p > 0.5 ? 'female' : 'male', p: Math.round(p * 100) / 100, confident: p > 0.7 || p < 0.3 };
  }

  /** Одежда → look (5.11): открытый вырез, пиджак с рубашкой и галстуком, иначе — круглый ворот (как раньше, без outfit). */
  _outfitOv(gender) {
    const o = this.outfitRaw;
    if (!o) return {};
    const hx = (c) => hex(c);
    if (!o.bw && o.skinA > 0.5) return { outfit: o.skinW > 0.5 ? 'scoop' : 'vneck', ...(o.Cs ? { cloth: hx(o.Cs) } : {}) };
    if (o.Cs && o.Csh && o.shirt > 0.25) {
      const tie = gender === 'male' && o.tie > 0.4 && o.Ct ? hx(o.Ct) : false;
      return { outfit: 'blazer', cloth: hx(o.Cs), cloth2: hx(o.Csh.map((v) => Math.min(1, v * 1.08))), tie };
    }
    return {};
  }

  /**
   * Асимметрия глаз → параметры век. Поправки на поворот головы — регрессия по 19 портретам
   * (ln раскрытия: −0.96·yaw, разница высот: −0.345·yaw); остаток на портретах анфас ±0.03–0.05.
   * Мёртвая зона — шум точек; при |yaw| > 0.15 асимметрия не переносится (поворот её искажает).
   * eyeOpenL/R — множители раскрытия, eyeLiftL/R — сдвиг щели вверх, градусы поворота век.
   */
  _eyeAsymOv(k, eyeR) {
    const A = this.eyeAsymRaw;
    if (!A || !(k > 0)) return {};
    const w = smoothstep(0.15, 0.05, Math.abs(this.yaw)) * k;
    if (w <= 0) return {};
    const soft = (v, t) => Math.sign(v) * Math.max(0, Math.abs(v) - t);
    const lo = clamp(soft(Math.log(A.openL / A.openR) + 0.96 * this.yaw + 0.014, 0.03) * w, -0.25, 0.25);
    const dy = clamp(soft(A.dy + 0.345 * this.yaw, 0.015) * w, -0.08, 0.08);     // в ширинах глаза
    const lift = (Math.asin(clamp((dy * 2 * eyeR * 1.05) / 2 / (eyeR * 1.04), -0.5, 0.5)) * 180) / Math.PI;
    const r = (v) => Math.round(v * 1000) / 1000;
    return lo || dy ? { eyeOpenL: r(Math.exp(lo / 2)), eyeOpenR: r(Math.exp(-lo / 2)), eyeLiftL: r(lift), eyeLiftR: r(-lift) } : {};
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
    // квадратность подбородка: ширина овала чуть выше низа подбородка относительно ширины на уровне челюсти;
    // скулы: ширина на высоте скул относительно среднего висков и щёк под скулами
    const wAt = (y) => ovalHalfWidth(this.head, y);
    const c1 = wAt(M.chin + 0.1), c2 = wAt(M.chin + 0.3), k0 = wAt(-0.05), k1 = wAt(0.22), k2 = wAt(-0.35);
    M.chinSq = c1 && c2 ? c1 / c2 : null;
    M.cheekPr = k0 && k1 && k2 ? k0 / ((k1 + k2) / 2) : null;
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
    this._eyeAsym();
    this._lipAsym();
    this._teeth();
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
    this._outfit();
  }

  /**
   * Одежда (5.11) по цветам ниже подбородка: где по центру кончается кожа (вырез) относительно боков,
   * и отличается ли цвет в центре (рубашка, галстук) от цвета по бокам (пиджак).
   */
  _outfit() {
    const sk = this.skinPhoto, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const sat = (c) => { const M = Math.max(...c), m = Math.min(...c); return M > 0 ? (M - m) / M : 0; };
    const chroma = (c) => { const t = c[0] + c[1] + c[2] || 1; return [c[0] / t, c[1] / t]; };
    // ч/б и тонированные (сепия) снимки: цветность почти одна по всему кадру — кожу от ткани по цвету не отличить
    const spread = (() => { const q = []; for (let y = 0.6; y >= -2.2; y -= 0.1) for (let x = -1.4; x <= 1.4; x += 0.1) { const p = this.fromHead(x, y), c = this._rgb(p.x, p.y); if (c && lum(...c) > 0.06) q.push(chroma(c)); }
      const m = [0, 1].map((k) => q.reduce((a, v) => a + v[k], 0) / Math.max(1, q.length)); return Math.sqrt(q.reduce((a, v) => a + (v[0] - m[0]) ** 2 + (v[1] - m[1]) ** 2, 0) / Math.max(1, q.length)); })();
    // концентрация оттенков (1 — все одинаковы): у тонированных снимков ≥ 0.979, у цветных ≤ 0.96. Тёплые цветные
    // (беж, кожа, коричневый фон) тоже дают высокую концентрацию, но разброс цветности у них ≥ 0.069 (у сепии ≤ 0.054).
    // Подобрано на 136 размеченных портретах (npm run test:detect): было 16 ложных «ч/б», стало 0, пропуск 1 из 17.
    const hueR = (() => {
      let cx = 0, cy = 0, n = 0;
      for (let y = 0.6; y >= -2.2; y -= 0.05) for (let x = -1.4; x <= 1.4; x += 0.05) {
        const p = this.fromHead(x, y), c = this._rgb(p.x, p.y);
        if (!c || sat(c) <= 0.15 || lum(...c) <= 0.12) continue;
        const [r, g, b] = c, M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m || 1;
        const h = (M === r ? ((g - b) / d) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4) * Math.PI / 3;
        cx += Math.cos(h); cy += Math.sin(h); n++;
      }
      return n ? Math.hypot(cx, cy) / n : 1;
    })();
    const bw = sat(sk) < 0.04 || spread < 0.03 || (hueR > 0.975 && spread < 0.062);
    this._bwFeat = { spread, hueR, satSkin: sat(sk) };
    const skC = chroma(sk), skL = lum(...sk);
    // кожа — по цветности (шея и грудь в тени темнее лица); на ч/б снимке кожу от ткани не отличить
    const isSkin = (c) => { if (bw) return false; const q = chroma(c), r = lum(...c) / skL; return Math.hypot(q[0] - skC[0], q[1] - skC[1]) < 0.03 && r > 0.3 && r < 1.4 && sat(c) > 0.12; };
    const box = (x0, x1, y0, y1) => { const out = []; for (let y = y0; y >= y1; y -= 0.025) for (let x = x0; x <= x1; x += 0.025) { const p = this.fromHead(x, y), c = this._rgb(p.x, p.y); if (c) out.push(c); } return out; };
    const A = box(-0.12, 0.12, -1.35, -1.75), Aw = [...box(-0.38, -0.26, -1.4, -1.6), ...box(0.26, 0.38, -1.4, -1.6)];
    const S = [...box(-0.95, -0.6, -1.85, -2.25), ...box(0.6, 0.95, -1.85, -2.25)];
    const T = box(-0.03, 0.03, -1.45, -1.9);
    const frac = (arr) => (arr.length ? arr.filter(isSkin).length / arr.length : 0);
    const cl = (arr) => { const a = arr.filter((c) => !isSkin(c)); return a.length > 12 ? robustColor(a) : null; };
    const Cs = cl(S);
    // рубашка под пиджаком: заметно светлее боков (пиджака); галстук — по центру, не кожа, не рубашка, не пиджак
    const shirtPx = Cs ? A.filter((c) => !isSkin(c) && lum(...c) > lum(...Cs) + 0.25 && d(c, Cs) > 0.3) : [];
    const Csh = shirtPx.length > 8 ? robustColor(shirtPx.slice()) : null;
    const tiePx = Csh ? T.filter((c) => !isSkin(c) && d(c, Csh) > 0.18) : [];   // галстук бывает в тон пиджаку — «не рубашка»
    this.outfitRaw = { bw, spread, skinA: frac(A), skinW: frac(Aw), shirt: Cs ? shirtPx.length / A.length : 0, tie: T.length ? tiePx.length / T.length : 0,
      Cs, Csh, Ct: tiePx.length > 5 ? robustColor(tiePx.slice()) : null };
  }

  _hair() {
    const M = this.hairMask;
    this.hairStyle = null; this.hairColor = null; this.hairlineY = null; this.hairR = null; this.bang = null;
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
    const lineAt = (x) => { for (let y = Math.max(0.25, this.head[10].y - 0.15); y < 1.25; y += 0.01) if (isHair(x, y)) return y; return null; };
    this.hairlineY = lineAt(0);
    // чёлка набок: линия роста заметно ниже с одной стороны лба
    const yl = lineAt(-0.25), yr = lineAt(0.25);
    this.bang = yl !== null && yr !== null && Math.abs(yl - yr) > 0.04 ? { side: yl < yr ? -1 : 1, depth: clamp(Math.abs(yl - yr), 0, 0.3) } : null;
    // силуэт причёски: по лучам из (0, 0.15) — внешняя граница маски волос (с допуском разрывов) на углах 0…100°
    this.hairR = [0, 20, 40, 60, 80, 100].map((deg) => {
      const rs = [];
      for (const sg of [1, -1]) {
        const t = sg * deg * Math.PI / 180, dx = Math.sin(t), dy = Math.cos(t);
        let last = null, gap = 0;
        for (let r = 0.45; r < 2.2; r += 0.01) {
          const v = isHair(dx * r, 0.15 + dy * r);
          if (v === null) break;
          if (v) { last = r; gap = 0; } else if (last !== null && (gap += 0.01) > 0.08) break;
        }
        if (last !== null) rs.push(last);
      }
      return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    });
    const cols = [], Wm = M.w, Hm = M.h;
    for (let y = 0; y < Hm; y += 2) for (let x = 0; x < Wm; x += 2) {
      if (!M.data[y * Wm + x]) continue;
      const c = this._rgb(((x + 0.5) / Wm) * W, ((y + 0.5) / Hm) * H);
      if (c) cols.push(c);
    }
    if (cols.length > 50) {                       // воспринимаемый цвет — светлая половина (без теней у корней)
      cols.sort((a, b) => lum(...a) - lum(...b));
      this.hairColor = robustColor(cols.slice(Math.floor(cols.length * 0.45), Math.floor(cols.length * 0.95)));
      this._hairTone(cols);
    }
  }

  /**
   * Седина и ровность цвета волос (1.5). Седые волоски — светлые и ненасыщенные (L > 0.4, S < 0.2): на цветных
   * портретах их доля 0.29–0.42 у седых и ≤ 0.03 у остальных. Мелкий контраст (разброс яркости в окнах ~0.012
   * ед. головы, деленный на среднюю) отличает ровную белую шевелюру (~0.08) от «соли с перцем» (~0.3).
   * На чёрно-белых снимках седину не отличить от светлых волос — там только hairVar.
   * Мелирование по фото не определяется: светлые пряди неотличимы от бликов освещения.
   */
  _hairTone(cols) {
    this.hairGray = 0; this.hairGrayColor = null; this.hairVar = null;
    const sat = (c) => { const M = Math.max(...c), m = Math.min(...c); return M > 0 ? (M - m) / M : 0; };
    const bw = !!this.outfitRaw?.bw || cols.reduce((a, c) => a + sat(c), 0) / cols.length < 0.025;   // общее решение ч/б/сепия (см. _outfit)
    // мелкий контраст по окнам внутри маски (окно целиком в волосах — без края с фоном)
    const M = this.hairMask, W = this.img.width, H = this.img.height, r = Math.max(1, Math.round(0.012 / this.frame.s));
    let cs = 0, cn = 0;
    for (let y = 2; y < M.h - 2; y += 4) for (let x = 2; x < M.w - 2; x += 4) {
      if (!(M.data[y * M.w + x] && M.data[(y - 2) * M.w + x] && M.data[(y + 2) * M.w + x] && M.data[y * M.w + x - 2] && M.data[y * M.w + x + 2])) continue;
      const px = ((x + 0.5) / M.w) * W, py = ((y + 0.5) / M.h) * H;
      let s1 = 0, s2 = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const c = this._rgb(px + dx, py + dy); if (!c) continue; const L = lum(...c); s1 += L; s2 += L * L; n++; }
      if (n < 4) continue;
      const m = s1 / n; cs += Math.sqrt(Math.max(0, s2 / n - m * m)) / Math.max(0.05, m); cn++;
    }
    const fine = cn > 30 ? cs / cn : null;
    if (fine !== null) this.hairVar = clamp(fine / 0.3, 0.3, 1.4);
    if (bw) return;
    const isGray = (c) => lum(...c) > 0.4 && sat(c) < 0.2;
    const gray = cols.filter(isGray), g = gray.length / cols.length;
    if (g < 0.15 || gray.length < 30) return;
    const gc = robustColor(gray.slice()), gl = lum(...gc);
    this.hairGrayColor = gc.map((v) => lerp(v, gl, 0.75));                   // седина почти нейтральна, остаток оттенка — отсвет кожи и фона
    if (fine !== null && fine < 0.15) { this.hairGray = 1; this.hairColor = this.hairGrayColor; return; }   // ровно светлые — полностью седые
    this.hairGray = clamp(g * 1.2, 0, 0.9);                                  // «соль с перцем»: основа — тёмные волоски
    const dark = cols.filter((c) => !isGray(c));
    if (dark.length > 30) { dark.sort((a, b) => lum(...a) - lum(...b)); this.hairColor = robustColor(dark.slice(Math.floor(dark.length * 0.1), Math.floor(dark.length * 0.6))); }
  }

  /**
   * Борода и усы по зонам лица: доля маски волос, контраст яркости и «текстурность» (локальный разброс яркости)
   * относительно чистой щеки. Результат — this.facial { stache, chin, jaw, side, … } и this.beardStyle.
   */
  _facialHair() {
    const W = this.img.width, H = this.img.height, M = this.hairMask, hd = this.head;
    const hw = Math.abs(hd[291].x - hd[61].x) / 2, MYp = (hd[13].y + hd[14].y) / 2, top = hd[0].y, bot = hd[17].y;
    const sample = (x0, x1, y0, y1) => {
      const ls = [], cols = [];
      let n = 0, h = 0, tex = 0;
      for (let y = y0; y <= y1; y += 0.012) for (let x = x0; x <= x1; x += 0.012) for (const sg of [1, -1]) {
        const q = this.fromHead(sg * x, y);
        if (q.x < 1 || q.y < 1 || q.x >= W - 2 || q.y >= H - 2) continue;
        const c = this._rgb(q.x, q.y), c2 = this._rgb(q.x + 2, q.y + 1);
        if (!c || !c2) continue;
        n++; ls.push(lum(...c)); cols.push(c); tex += Math.abs(lum(...c) - lum(...c2));
        if (M && M.data[Math.floor((q.y / H) * M.h) * M.w + Math.floor((q.x / W) * M.w)]) h++;
        if (x === 0) break;                                          // средняя линия — один раз
      }
      ls.sort((a, b) => a - b);
      return { n, hair: n ? h / n : 0, lum: ls.length ? ls[ls.length >> 1] : 0, tex: n ? tex / n : 0, cols };
    };
    const ref = sample(0.3, 0.42, -0.14, -0.02);                     // чистая щека под глазом
    const Z = {
      stache: sample(0, hw * 0.9, top + 0.012, top + 0.07),
      corner: sample(hw * 0.95, hw * 1.25, bot, top),                // сбоку от уголков рта (свисающие усы, борода)
      chin: sample(0, 0.15, -0.84, bot - 0.04),
      jaw: (() => { const ow = ovalHalfWidth(hd, -0.52) || 0.5; return sample(ow * 0.55, ow * 0.78, -0.62, -0.42); })(),   // внутри овала: снаружи — волосы и фон
    };
    // пороги усов и уголков — на 15 портретах; подбородок и челюсть — на 136 размеченных (см. score). Маска волос бороду почти не видит.
    // Белые усы на ч/б фото (Эйнштейн) так не находятся; тени под губой на контрастных снимках — частая ложная «борода».
    const TH = { stache: [0.45, 1.95], corner: [0.3, 2.6], chin: [0.55, 9], jaw: [0.45, 9] };
    const score = (z, k) => {
      const dark = (ref.lum - z.lum) / Math.max(0.05, ref.lum), tex = z.tex / Math.max(0.004, ref.tex);
      const [d0, t0] = TH[k];
      // подбородок и челюсть: борода бывает и светлее щеки (седая, белая), поэтому |затемнение|, а не затемнение;
      // ln(текстура) + 2·|затемнение| > 0.72 — подобрано на 136 размеченных портретах (половина — подбор, половина —
      // проверка: точность 0.71 / 0.77, полнота 0.53 / 0.62; прежние пороги давали полноту 0.06)
      const on = k === 'chin' || k === 'jaw' ? Math.log(Math.max(0.3, tex)) + 2 * Math.abs(dark) > 0.72
        : z.hair > 0.35 || dark > d0 || tex > t0 || (k === 'corner' && dark > d0 && tex > 1.6);
      return { hair: +z.hair.toFixed(2), dark: +dark.toFixed(2), tex: +tex.toFixed(2), on };
    };
    const F = {};
    for (const k in Z) F[k] = score(Z[k], k);
    this.facial = F;
    // стиль
    const st = F.chin.on && F.jaw.on ? 'full' : F.chin.on ? 'goatee' : 'none';
    const ms = F.stache.on ? (F.corner.on && st === 'none' ? 'walrus' : 'regular') : false;
    let style = st;
    if (st === 'full' && !F.stache.on) style = 'chinstrap';
    this.beardStyle = style === 'none' && !ms ? null : { style, moustache: ms, length: 0.35 };
    if (this.beardStyle) {
      const pool = [...(F.chin.on ? Z.chin.cols : []), ...(F.jaw.on ? Z.jaw.cols : []), ...(F.stache.on ? Z.stache.cols : [])];
      pool.sort((a, b) => lum(...a) - lum(...b));
      const c = robustColor(pool.slice(Math.floor(pool.length * 0.3)));   // светлая часть: тени между волосками темнее цвета
      if (c) this.beardStyle.color = hex(c.map((v) => Math.min(1, v * 1.35)));   // волосок светлее среднего по зоне (тени между волосками)
    }
  }

  /**
   * Очки по маске «прочее» многоклассового сегментатора (только при accessories: true): доля пикселей класса
   * вокруг глаз (на калибровочных фото без очков — ровно 0, в очках — 0.014–0.06), размер и форма оправы по
   * их разбросу, цвет — по пикселям снимка. this.glasses = null, если сегментатор не запускали.
   */
  _glasses() {
    this.glasses = null;
    const M = this.multiMask;
    if (!M) return;
    const W = this.img.width, H = this.img.height, hd = this.head;
    const cls = (x, y) => { const q = this.fromHead(x, y); if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) return -1; return M.data[Math.floor((q.y / H) * M.h) * M.w + Math.floor((q.x / W) * M.w)]; };
    // поля и бока головного убора спускаются по вискам: пиксель, от которого вверх до y = 0.6 сплошь «прочее/одежда», — не оправа
    const hatSide = (x, y) => { for (let yy = y + 0.02; yy < 0.6; yy += 0.02) { const v = cls(x, yy); if (v === 2 || v === 3) return false; } return true; };   // до кожи не дошли: убор, фон, волосы
    const eyes = [[263, 362, 1], [33, 133, -1]].map(([o, i, sg]) => ({ c: mid(hd[o], hd[i]), hw: Math.abs(hd[o].x - hd[i].x) / 2, sg }));
    let zone = 0, acc = 0;
    const ext = { out: [], inn: [], top: [], bot: [] }, cols = [];
    for (const e of eyes) for (let a = 0; a < 360; a += 5) for (let f = 0.6; f <= 2.4; f += 0.06) {
      const dx = Math.cos(a * DEG) * e.hw * f, dy = Math.sin(a * DEG) * e.hw * 0.8 * f;
      const v = cls(e.c.x + dx, e.c.y + dy);
      zone++;
      if (v !== 5 || hatSide(e.c.x + dx, e.c.y + dy)) continue;
      acc++;
      const ox = (dx * e.sg) / e.hw, oy = dy / e.hw;                 // в долях полуширины глаза; ox > 0 — к виску
      if (Math.abs(oy) < 0.35) (ox > 0 ? ext.out : ext.inn).push(Math.abs(ox));
      if (Math.abs(ox) < 0.5) (oy > 0 ? ext.top : ext.bot).push(Math.abs(oy));
      const q = this.fromHead(e.c.x + dx, e.c.y + dy), c = this._rgb(q.x, q.y);
      if (c) cols.push(c);
    }
    const frac = acc / Math.max(1, zone), detected = frac > 0.006;
    // тонкая оправа на маске 256×256 — считаные пиксели: при малой выборке размер по умолчанию
    const far = (a, d) => { if (a.length < 8) return d; const b = a.sort((p, q) => p - q); return b[Math.floor(b.length * 0.85)]; };
    if (!detected) { this.glasses = { detected: false, frac: +frac.toFixed(4) }; return; }
    const rx = (far(ext.out, 1.5) + far(ext.inn, 1.3)) / 2, top = far(ext.top, 1.1), bot = far(ext.bot, 1.1);
    const ry = (top + bot) / 2, color = cols.length > 8 ? robustColor(cols) : [0.15, 0.15, 0.15];
    this.glasses = {
      detected: true, frac: +frac.toFixed(4),
      size: +clamp(rx, 1.3, 2.0).toFixed(3), aspect: +clamp(rx / Math.max(0.4, ry), 0.9, 1.5).toFixed(3), dy: +clamp((top - bot) / 2, -0.2, 0.25).toFixed(3),
      color: hex(color.map((v) => v * 0.9)), light: lum(...color) > 0.45,
    };
    this.warnings.push('На фото очки: оправа добавлена к голове и убрана с кожи. Отключить: setLook({ glasses: false }).');
  }

  /**
   * Головной убор по многоклассовому сегментатору (accessories: true): классы «одежда» (4) и «прочее» (5) над лбом.
   * На портретах без убора в полосе y 0.7–1.0 их ровно 0, в шляпах — 30–100 %. Борода сегментатором не видна
   * (размечается как кожа лица), поэтому для неё остаётся эвристика _facialHair.
   * Стиль: поля шире головы → котелок (купол сужается к верху) или федора; без полей → шапка или клош.
   */
  _hat() {
    this.hat = null;
    const M = this.multiMask;
    if (!M) return;
    const W = this.img.width, H = this.img.height;
    const cls = (x, y) => { const q = this.fromHead(x, y); if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) return -1; return M.data[Math.floor((q.y / H) * M.h) * M.w + Math.floor((q.x / W) * M.w)]; };
    const isHat = (v) => v === 4 || v === 5;
    const rows = [];
    for (let y = 0.3; y <= 1.6; y += 0.03) {
      let n = 0, c = 0, wmax = 0;
      for (let x = -1.3; x <= 1.3; x += 0.02) {
        const v = cls(x, y);
        if (v < 0) continue;
        if (Math.abs(x) <= 0.5) { n++; if (isHat(v)) c++; }
        if (isHat(v)) wmax = Math.max(wmax, Math.abs(x));
      }
      rows.push({ y, f: n ? c / n : 0, w: wmax });
    }
    const band = rows.filter((r) => r.y >= 0.7 && r.y <= 1.0), cover = band.reduce((s, r) => s + r.f, 0) / Math.max(1, band.length);
    if (cover < 0.3) return;
    // нижний край: первая снизу строка, с которой убор идёт сплошняком; верх — последняя строка с заметной долей
    let i0 = rows.findIndex((r, i) => r.f > 0.45 && (rows[i + 1]?.f ?? 0) > 0.45);
    if (i0 < 0) i0 = rows.findIndex((r) => r.y >= 0.7);
    let i1 = i0;
    for (let i = i0; i < rows.length; i++) if (rows[i].f > 0.15) i1 = i;
    const y0 = rows[i0].y, top = rows[i1].y;
    const brim = Math.max(...rows.slice(Math.max(0, i0 - 2), i0 + 6).map((r) => r.w));
    const crownLo = rows[Math.min(i1, i0 + 6)]?.w || 0, crownHi = rows[Math.max(i0, i1 - 3)]?.w || 0;
    const sides = [0.05, 0.15, 0.25].reduce((s, y) => s + [0.62, 0.7].reduce((a, x) => a + (isHat(cls(x, y)) ? 1 : 0) + (isHat(cls(-x, y)) ? 1 : 0), 0), 0) / 12;
    let style;
    if (brim > 0.85) style = crownHi < crownLo * 0.8 ? 'bowler' : 'fedora';
    else style = sides > 0.3 ? 'beanie' : 'cloche';
    const cols = [];
    for (const r of rows.slice(i0, i1 + 1)) for (let x = -0.4; x <= 0.4; x += 0.04) {
      if (!isHat(cls(x, r.y))) continue;
      const q = this.fromHead(x, r.y), c = this._rgb(q.x, q.y);
      if (c) cols.push(c);
    }
    const color = robustColor(cols) || [0.2, 0.2, 0.2];
    this.hat = { style, color: hex(color.map((v) => v * 1.1)), y0: +y0.toFixed(3), top: +top.toFixed(3), brim: +brim.toFixed(3), cover: +cover.toFixed(2) };
    this.warnings.push(`На фото головной убор (${style}): добавлен к голове. Отключить: setLook({ hat: null }).`);
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
    // очки и прочие аксессуары на лице (маска сегментатора) — тоже дыры, кожа под ними восстанавливается push-pull
    if (this.multiMask && (this.glasses?.detected || this.hat)) {
      const M = this.multiMask, hat = !!this.hat;
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const ix = x / k + x0, iy = y / k + y0, v = M.data[Math.floor((iy / img.height) * M.h) * M.w + Math.floor((ix / img.width) * M.w)];
        if (v === 5 || (hat && v === 4)) hairHole[y * TW + x] = 1;   // убор: и «одежда» (кожаный шлем, вязаная шапка)
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
    // 7.3: тон низа лица — полоса вдоль линии челюсти и подбородка (внутри овала), только похожие на кожу пиксели
    // (без бороды и теней). Ниже рта заливка вне лица уходит в него, и шея красится им же — без шва «лицо — шея».
    const JAW = [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397], cMouth = T(P[13]), cChin = T(P[152]);
    const chr = (c) => { const t = c[0] + c[1] + c[2] || 1; return [c[0] / t, c[1] / t]; }, sC = chr(S), sL = lum(...S);
    const low = [];
    for (const j of JAW) {
      const q = T(P[j]), cx = q.x + (cMouth.x - q.x) * 0.14, cy = q.y + (cMouth.y - q.y) * 0.14, r = Math.max(2, faceW * 0.035);
      for (let y = Math.round(cy - r); y <= cy + r; y++) for (let x = Math.round(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= TW || y >= TH) continue;
        const i = y * TW + x; if (valid[i] < 0.95) continue;
        const c = [R[i], G[i], B[i]], cc = chr(c), lr = lum(...c) / Math.max(0.05, sL);
        if (Math.hypot(cc[0] - sC[0], cc[1] - sC[1]) < 0.04 && lr > 0.55 && lr < 1.3) low.push(c);
      }
    }
    const SL = low.length > 20 ? robustColor(low) : S.map((v) => v * 0.95);
    const out = [R, G, B];
    for (let ci = 0; ci < 3; ci++) {
      const F = filled[ci], O = out[ci];
      for (let i = 0; i < n; i++) {
        const y = (i / TW) | 0, wl = smoothstep(cMouth.y, cChin.y, y);   // 0 — выше рта, 1 — от подбородка вниз
        O[i] = lerp(lerp(S[ci], SL[ci], wl), F[i], fade[i]);
      }
    }
    this.skinLow = SL;
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
    const re = clamp(o.realism ?? 0.8, 0, 1);
    const key = `${k}|${tex}|${gender}|${re}|${this._corrV || 0}`;
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
    // поправки: глобальная калибровка основы (× realism) и поправки этого лица, найденные через рендер (refine)
    const GC = (!this.noBase && BASE_CORR[gender]) || {}, PC = this.corr?.meas || {};
    const car = (f) => Mn[f] + k * (Q[f] - Mn[f]) + (GC[f] || 0) * re + (PC[f] || 0);
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
    const GW = (!this.noBase && BASE_CORR[gender]?.widths) || [], PW = this.corr?.widths || [];
    const wr = Q.widths.map((r, i) => clamp(1 + k * (r - 1) + (GW[i] || 0) * re + (PW[i] || 0), 0.75, 1.3));
    for (let i = 0; i < 6; i++) gx[i + 2] = d.gx[i + 2] * wr[i];
    gx[0] = d.gx[0] * lerp(1, wr[0], 0.5); gx[1] = d.gx[1] * lerp(1, wr[0], 0.8); gx[8] = d.gx[8] * wr[5];
    // квадратный подбородок — шире низ овала и шире выступ подбородка; скулы — выраженнее «мышца» скулы
    // (средние по калибровочным фото: chinSq 0.671, cheekPr 1.054)
    const sq = typeof Q.chinSq === 'number' ? k * (Q.chinSq - 0.671) / 0.671 : 0;
    gx[8] *= clamp(1 + 1.2 * sq, 0.8, 1.25);
    const chinSX = d.chinSX * clamp(1 + 3 * sq, 0.6, 1.6);
    const cheek = d.cheek * (typeof Q.cheekPr === 'number' ? clamp(1 + 40 * k * (Q.cheekPr - 1.054), 0.3, 2) : 1);

    const ov = {
      gx, eyeX, eyeR, upperOpen, lowerOpen, chinSX, cheek,
      eyeTilt: clamp(d.eyeTilt + car('tilt') - Mn.tilt, -0.12, 0.28),
      brow,
      noseTipY: clamp(-0.21 + car('noseTip') - Mn.noseTip, -0.3, -0.13),
      noseW: clamp(0.07 * ratio('noseW'), 0.05, 0.1),
      ...(typeof Q.noseBr === 'number' ? { noseBridge: clamp(ratio('noseBr') ** 1.5, 0.7, 1.4) } : {}),   // ширина спинки (MediaPipe по светотени — с осторожностью; в старых файлах меры нет)
      nose: clamp(d.nose * ratio('noseProj') ** 0.6, 0.08, 0.24),
      mouthHW: clamp(d.mouthHW * ratio('mouthHW'), 0.13, 0.25),
      lipU: clamp(d.lipU * ratio('lipU'), 0.018, 0.085),
      lipL: clamp(d.lipL * ratio('lipL'), 0.022, 0.1),
      chinScale: clamp(baseChin * (car('chin') - MY) / (Mn.chin - MY), 0.8, 1.5),
      // разрез: перекос и полнота век. Коэффициенты — из геометрии кромки (_shapeLid): 1° перекоса ≈ 0.0164 сдвига
      // вершины дуги, 1° полноты ≈ −0.016 отношения «края/середина». По рендеру не калибруется: MediaPipe почти не видит форму век.
      ...(typeof Q.upS === 'number' ? {
        lidUpSkew: clamp((car('upS') - Mn.upS) / 0.0164, -8, 8),
        lidUpFull: clamp(-(car('upF') - Mn.upF) / 0.016, -8, 8),
        lidLoSkew: clamp((car('loS') - Mn.loS) / 0.0164, -8, 8),
        lidLoFull: clamp(-(car('loF') - Mn.loF) / 0.016, -8, 8),
      } : {}),
      ...(Q.bowX ? {
        bowX: clamp(lerp(0.2, BOW_MEAN.x, re) + k * (Q.bowX - BOW_MEAN.x), 0.12, 0.36),
        bowDip: clamp(0.2 + k * 1.09 * (BOW_MEAN.rc - Q.bowRC), 0.02, 0.45),
      } : {}),
      skin: hex(this.skinTex.map((v) => v * TEX_GAIN)),
      ...(this.skinLow && tex > 0 ? { neckSkin: hex(this.skinTex.map((v, k) => lerp(v, this.skinLow[k], tex) * TEX_GAIN)) } : {}),
      blush: d.blush * 0.15, stubble: 0,
    };
    if (this.lipColor && !this.grayscale) ov.lip = hex(this.lipColor);
    if (this.irisColor && !this.grayscale) ov.iris = [hex(this.irisColor.map((v) => v * 1.25)), hex(this.irisColor.map((v) => v * 0.55))];
    if (this.lidTex && tex > 0) ov.lidTint = this.lidTex.map((v) => lerp(1, v, tex));
    if (this.beard > 0.05) ov.stubble = this.beard * 2.2;      // борода/щетина: затемнение челюсти и усов поверх текстуры
    if (this.hairColor) ov.hair = hex(this.hairColor.map((v) => v * 1.05));
    Object.assign(ov, this._eyeAsymOv(k, eyeR));
    Object.assign(ov, this._lipAsymOv(k, ov.mouthHW));
    // зубы: желтизна относительно белка 0 → белые, 0.1 → жёлтые (на улыбающихся портретах 0.01–0.05)
    if (this.teethTone) { const t = clamp(this.teethTone.d / 0.1, 0, 1); ov.teethColor = hex([0.969, 0.961, 0.941].map((v, i) => lerp(v, [0.902, 0.847, 0.69][i], t))); }
    if (this.hairGray > 0) { ov.hairGray = Math.round(this.hairGray * 100) / 100; ov.hairGrayColor = hex(this.hairGrayColor.map((v) => v * 1.05)); }
    if (this.hairVar !== null) ov.hairVar = Math.round(this.hairVar * 100) / 100;
    if (this.clothColor) ov.cloth = hex(this.clothColor);
    Object.assign(ov, this._outfitOv(gender));
    if (this.hairR && this.hairStyle && this.hairStyle !== 'none') {
      // толщина = граница волос на фото − силуэт нашего черепа на том же луче (силуэт анфас: √(1−y²)·gx(y))
      const skull = (deg) => {
        const t = deg * Math.PI / 180, dx = Math.sin(t), dy = Math.cos(t);
        let lo = 0.3, hi = 1.6;
        for (let it = 0; it < 30; it++) {
          const r = (lo + hi) / 2, x = dx * r, y = 0.15 + dy * r;
          if (y >= 1 || Math.abs(x) > Math.sqrt(Math.max(0, 1 - y * y)) * prof(gx, y)) hi = r; else lo = r;
        }
        return lo;
      };
      ov.hairVol = this.hairR.map((r, i) => (r === null ? 0.04 : clamp(r - skull(i * 20), 0.015, 0.32)));
    }
    // борода/усы с фото — только для мужской основы (на женских портретах тени у рта дают ложные срабатывания)
    if (this.beardStyle && gender === 'male') {
      ov.beard = { ...this.beardStyle };
      if (ov.stubble) ov.stubble = Math.min(ov.stubble, 0.8);
    }
    if (this.glasses?.detected) {
      const g = this.glasses;
      const thin = g.frac < 0.02;                                    // мало пикселей оправы — тонкая (металлическая) оправа
      // у тонкой оправы форма по маске ненадёжна — обычно это круглая/овальная проволочная оправа
      ov.glasses = thin
        ? { style: 'round', color: g.light ? g.color : '#5a5048', size: clamp(g.size, 1.35, 1.6), aspect: 1.1, dy: 0, metal: true, thickness: 0.0045 }
        : { style: g.aspect > 1.2 ? 'rect' : 'round', color: g.color, size: g.size, aspect: g.aspect, dy: g.dy, metal: g.light, thickness: 0.009 };
    }
    if (this.hat) ov.hat = { style: this.hat.style, color: this.hat.color, y0: clamp(this.hat.y0 - 0.15, 0.3, 0.56) };   // край на фото выше нашей линии: наш убор сидит поверх волос
    if (this.bang && this.hairStyle !== 'none') { ov.bangSide = this.bang.side; ov.bangDepth = this.bang.depth; }
    if (this.hairStyle) {
      ov.hairStyle = this.hairStyle;
      if (this.hairStyle === 'long' && this.hairBottom !== null) ov.hairBottom = clamp(this.hairBottom, -1.7, -0.75);
      ov.ears = this.hairStyle !== 'long';
      if (this.hairlineY !== null) ov.hairline = clamp(this.hairlineY - (this.hairStyle === 'long' ? 0.6 : 0.64), -0.2, 0.22);
    }
    if (this.warp && k > 0) ov.warp = { pts: this.warp.pts, win: this.warp.win, scale: k / this.warp.k };
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
        // на грубой сетке (detail: medium/low) часть корзин пуста — заполняем соседями, иначе точки овала падают на x = 0
        for (let it = 0; it < 6; it++) for (let i = 1; i < 259; i++) if (!sil[i] && (sil[i - 1] || sil[i + 1])) sil[i] = Math.max(sil[i - 1], sil[i + 1]);
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
        // середина кромки с учётом полноты разреза (перекос в центре = 0, см. _shapeLid)
        const hU = eye.rs * Math.sin(((P.upperOpen + (P.lidUpFull || 0)) * Math.PI) / 180), hL = eye.rl * Math.sin(((P.lowerOpen - (P.lidLoFull || 0)) * Math.PI) / 180);
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
      colors: { skinPhoto: rc(this.skinPhoto), skin: rc(this.skinTex), skinLow: rc(this.skinLow), lip: rc(this.lipColor), brow: rc(this.browColor), iris: rc(this.irisColor), hair: rc(this.hairColor), cloth: rc(this.clothColor) },
      teeth: this.teethTone ? { d: r4(this.teethTone.d) } : null,
      outfit: this.outfitRaw ? { ...this.outfitRaw, spread: undefined, Cs: rc(this.outfitRaw.Cs), Csh: rc(this.outfitRaw.Csh), Ct: rc(this.outfitRaw.Ct) } : null,
      lidTex: rc(this.lidTex), beard: r4(this.beard), grayscale: !!this.grayscale, glasses: this.glasses || null, beardStyle: this.beardStyle || null, hat: this.hat || null,
      bs: this.bs ? Object.fromEntries(Object.entries(this.bs).filter(([, v]) => v > 0.03).map(([k, v]) => [k, Math.round(v * 100) / 100])) : null,
      hair: { style: this.hairStyle, bottom: r4(this.hairBottom), line: r4(this.hairlineY), r: this.hairR ? this.hairR.map(r4) : null, bang: this.bang ? { side: this.bang.side, depth: r4(this.bang.depth) } : null, gray: r4(this.hairGray || 0), grayColor: rc(this.hairGrayColor), vari: r4(this.hairVar) },
      tex: null,
      corr: this.corr ? JSON.parse(JSON.stringify(this.corr, (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v))) : null,
      warp: this.warp ? { k: this.warp.k, n: this.warp.n, win: this.warp.win, pts: this.warp.pts.map((p) => p.map(r4)) } : null,
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
    p._eyeAsym();
    p._lipAsym();
    p.meas = d.meas; p.warnings = d.warnings || []; p.expression = d.expression || {};
    const C = d.colors || {};
    p.skinPhoto = C.skinPhoto || C.skin || [0.85, 0.68, 0.58]; p.skinTex = C.skin || p.skinPhoto; p.skinLow = C.skinLow || null;
    p.lipColor = C.lip; p.browColor = C.brow; p.irisColor = C.iris; p.hairColor = C.hair; p.clothColor = C.cloth;
    p.lidTex = d.lidTex; p.beard = d.beard || 0; p.grayscale = !!d.grayscale; p.bs = d.bs || null; p.glasses = d.glasses || null; p.beardStyle = d.beardStyle || null; p.hat = d.hat || null;
    p.hairStyle = d.hair?.style ?? null; p.hairBottom = d.hair?.bottom ?? null; p.hairlineY = d.hair?.line ?? null;
    p.hairR = d.hair?.r ?? null; p.bang = d.hair?.bang ?? null;
    p.teethTone = d.teeth ? { d: d.teeth.d } : null;
    p.outfitRaw = d.outfit || null;
    p.hairGray = d.hair?.gray || 0; p.hairGrayColor = d.hair?.grayColor ?? null; p.hairVar = d.hair?.vari ?? null;
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
    p.corr = d.corr || null;
    p.warp = d.warp || null;
    p._fits = new Map();
    return p;
  }

  /** Сводка для UI/отладки. */
  get report() {
    const hx = (c) => (c ? hex(c) : null);
    return {
      warnings: this.warnings, yaw: +this.yaw.toFixed(3), expression: this.expression, glasses: this.glasses, beard: this.beardStyle, hat: this.hat || null, teeth: this.teethTone ? +this.teethTone.d.toFixed(3) : null, outfit: this._outfitOv(this._gender || 'male').outfit || null,
      hairStyle: this.hairStyle, colors: { skin: hx(this.skinTex), lip: hx(this.lipColor), brow: hx(this.browColor), iris: hx(this.irisColor), hair: hx(this.hairColor), hairGray: hx(this.hairGrayColor), cloth: hx(this.clothColor) },
      hairGray: +(this.hairGray || 0).toFixed(2), hairVar: this.hairVar === null || this.hairVar === undefined ? null : +this.hairVar.toFixed(2),
      measures: Object.fromEntries(Object.entries(this.meas).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, +(v / MEAN_M[k]).toFixed(3)])),
      widths: this.meas.widths.map((v) => +v.toFixed(3)),
      widthsAbs: this.meas.widthsAbs.map((v) => (v ? +v.toFixed(4) : null)),
    };
  }
}
