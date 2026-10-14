/**
 * head-model.js — процедурная стилизованная голова (male / female) без внешних ассетов.
 *
 * Что внутри:
 *  - Череп/лицо: сфера, деформированная профильными кривыми + гауссовыми "мышцами" (нос, скулы, подбородок),
 *    глазницы подогнаны под глазное яблоко. Morph targets (настоящие blendshapes) для челюсти, щёк, носа, лба.
 *  - Глаза: глазное яблоко с процедурной радужкой, веки-оболочки (вращаются вокруг центра глаза), ресницы,
 *    мягкая тень от верхнего века.
 *  - Брови и губы: параметрические поверхности, перестраиваются каждый кадр из тех же ARKit-каналов
 *    (это даёт точную асимметрию и форму, которой трудно добиться морфами на низкополигональной сфере).
 *  - Рот: полость + зубы + язык через stencil (видны только внутри ротового отверстия).
 *
 * Интерфейс "рига" (такой же у GLTFHead, см. gltf-head.js):
 *    rig.object3D           — корневой Object3D
 *    rig.update(ch, pose)   — ch: {channel: 0..1}, pose: {pitch,yaw,roll, eyeYaw,eyePitch, breath, focus}
 *    rig.dispose()
 */
import * as THREE from 'three';

// ------------------------------------------------------------------ утилиты
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const G = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2) * 0.5);
const DEG = Math.PI / 180;

/** Catmull-Rom по 9 равномерным отсчётам y = 1, .75, ... -1 */
function prof(arr, y) {
  const u = clamp((1 - y) / 0.25, 0, arr.length - 1);
  const i = Math.min(Math.floor(u), arr.length - 2), t = u - i;
  const p0 = arr[Math.max(i - 1, 0)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(i + 2, arr.length - 1)];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

// ------------------------------------------------------------------ параметры полов
export const PRESETS = {
  female: {
    gx: [0.70, 0.75, 0.77, 0.77, 0.755, 0.725, 0.68, 0.6, 0.5],
    gzF: [0.80, 0.84, 0.88, 0.90, 0.89, 0.91, 0.98, 1.08, 1.12],
    gzB: [0.80, 0.92, 1.00, 1.03, 1.00, 0.90, 0.72, 0.58, 0.50],
    nose: 0.14, browRidge: 0.025, chin: 0.05, chinSX: 0.1, cheek: 0.05, hollow: 0.0,
    eyeR: 0.116, eyeTilt: 0.09, upperOpen: 25, lowerOpen: -23, lidTint: [0.97, 0.93, 0.93],
    lipU: 0.048, lipL: 0.062, mouthHW: 0.185,
    brow: { y: 0.205, arch: 0.05, thick: 0.02, color: '#3a2318' },
    skin: '#eab9a0', lip: '#b9535b', hair: '#4a2616', iris: ['#5b7a3e', '#2f4a22'], lash: 0.0075,
    neckR: 0.28, cloth: '#5b1f33', hairStyle: 'long', blush: 0.38, stubble: 0,
  },
  male: {
    gx: [0.72, 0.77, 0.79, 0.79, 0.785, 0.775, 0.765, 0.72, 0.62],
    gzF: [0.80, 0.84, 0.89, 0.91, 0.90, 0.92, 0.99, 1.10, 1.16],
    gzB: [0.80, 0.92, 1.00, 1.03, 1.00, 0.90, 0.72, 0.58, 0.50],
    nose: 0.165, browRidge: 0.05, chin: 0.065, chinSX: 0.15, cheek: 0.04, hollow: 0.02,
    eyeR: 0.11, eyeTilt: 0.04, upperOpen: 22, lowerOpen: -22, lidTint: [0.97, 0.96, 0.96],
    lipU: 0.04, lipL: 0.056, mouthHW: 0.19,
    brow: { y: 0.19, arch: 0.022, thick: 0.028, color: '#231812' },
    skin: '#d9a487', lip: '#a8645c', hair: '#1f1712', iris: ['#5a4632', '#2a1f14'], lash: 0.005,
    neckR: 0.39, cloth: '#1e2633', hairStyle: 'short', blush: 0.2, stubble: 0.55,
  },
};

export const LAYOUT = { eyeX: 0.3, eyeY: 0.03, mouthY: -0.52, pivot: new THREE.Vector3(0, -0.72, -0.1) };
const JAW_THETA = 0.24;                       // угол раскрытия челюсти при jawOpen = 1
const JAW_PIVOT = { y: -0.12, z: -0.05 };

// ------------------------------------------------------------------ форма черепа

/** Точка единичной сферы → точка головы (без глазниц). */
function shapeHead(px, py, pz, P, out) {
  const s = smoothstep(-0.3, 0.3, pz);
  const x = px * prof(P.gx, py);
  const y = py;
  let z = pz * lerp(prof(P.gzB, py), prof(P.gzF, py), s);
  const F = smoothstep(0.15, 0.55, pz);
  if (F > 0) z += F * featureDz(x, y, P);
  // длина подбородка: всё ниже линии рта растягивается/сжимается (рот остаётся на месте)
  const cs = P.chinScale ?? 1, yM = LAYOUT.mouthY;
  out[0] = x; out[1] = y < yM ? yM + (y - yM) * cs : y; out[2] = z;
  return out;
}

/** Нос по вертикали: y головы → y "эталонного" носа (кончик на -0.21). */
const noseY = (y, P) => LAYOUT.eyeY + (y - LAYOUT.eyeY) * (0.24 / (LAYOUT.eyeY - (P.noseTipY ?? -0.21)));

function featureDz(x, y, P) {
  const ax = Math.abs(x), ex = P.eyeX ?? LAYOUT.eyeX, nw = (P.noseW ?? 0.07) / 0.07;
  let dz = 0;
  dz -= 0.05 * G(ax, y, ex, 0.02, 0.13, 0.1);                       // мягкая глазница
  dz += P.browRidge * G(ax, y, ex - 0.03, 0.2, 0.16, 0.05);         // надбровье
  const yn = noseY(y, P);
  const ny = smoothstep(0.2, -0.23, yn);                             // спинка носа растёт к кончику
  const below = yn < -0.26 ? Math.exp(-(((yn + 0.26) / 0.03) ** 2)) : 1;
  const nsx = (0.036 + 0.03 * smoothstep(0.1, -0.26, yn)) * lerp(1, nw, smoothstep(0.05, -0.2, yn));
  dz += P.nose * ny * below * Math.exp(-(x * x) / (2 * nsx * nsx));
  dz += 0.025 * G(ax, yn, 0, 0.12, 0.05, 0.08);                      // переносица
  dz += 0.035 * G(x, yn, 0, -0.21, 0.05 * nw, 0.05);                 // кончик носа
  dz += 0.042 * G(ax, yn, 0.07 * nw, -0.245, 0.032 * nw, 0.028);     // крылья носа
  dz += 0.05 * G(x, y, 0, -0.5, 0.2, 0.14);                          // зона рта
  dz -= 0.02 * G(x, y, 0, -0.635, 0.12, 0.025);                      // ямка под губой
  dz += P.chin * G(x, y, 0, -0.78, P.chinSX, 0.07);                  // подбородок
  dz += P.cheek * G(ax, y, 0.44, -0.05, 0.1, 0.08);                  // скулы
  dz -= P.hollow * G(ax, y, 0.46, -0.32, 0.1, 0.1);                  // впалые щёки (м)
  return dz;
}

/** Сетка "сферы" с плотностью, смещённой к лицу; без шва (столбцы замкнуты по индексу). */
function sphereGrid(W, H, fn, a = 0.42, b = 0.72) {
  const pos = new Float32Array((H + 1) * W * 3);
  const uv = new Float32Array((H + 1) * W * 2);
  const tmp = [0, 0, 0];
  for (let i = 0; i <= H; i++) {
    const v = 1 - (2 * i) / H;                                       // 1..-1
    const lat = (Math.PI / 2) * v * (b + (1 - b) * v * v);
    for (let j = 0; j < W; j++) {
      const w = (2 * j) / W - 1;                                     // -1..1, 0 = лицо
      const lon = Math.PI * w * (a + (1 - a) * w * w);
      const px = Math.cos(lat) * Math.sin(lon), py = Math.sin(lat), pz = Math.cos(lat) * Math.cos(lon);
      fn(px, py, pz, tmp, lon, lat);
      const k = (i * W + j) * 3;
      pos[k] = tmp[0]; pos[k + 1] = tmp[1]; pos[k + 2] = tmp[2];
      uv[(i * W + j) * 2] = j / W; uv[(i * W + j) * 2 + 1] = 1 - i / H;
    }
  }
  const idx = [];
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const a = i * W + j, b = i * W + ((j + 1) % W), c = (i + 1) * W + j, d = (i + 1) * W + ((j + 1) % W);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Карта высот фронтальной поверхности z(x, y) — растеризация треугольников. Нужна для бровей, губ, рта. */
class HeightMap {
  constructor(geo, x0 = -0.85, x1 = 0.85, y0 = -1.05, y1 = 0.9, step = 0.01) {
    Object.assign(this, { x0, y0, step });
    this.nx = Math.ceil((x1 - x0) / step) + 1;
    this.ny = Math.ceil((y1 - y0) / step) + 1;
    this.z = new Float32Array(this.nx * this.ny).fill(-10);
    const p = geo.attributes.position.array, id = geo.index.array;
    for (let t = 0; t < id.length; t += 3) {
      const a = id[t] * 3, b = id[t + 1] * 3, c = id[t + 2] * 3;
      if (p[a + 2] < 0.05 || p[b + 2] < 0.05 || p[c + 2] < 0.05) continue;
      const ax = (p[a] - x0) / step, ay = (p[a + 1] - y0) / step;
      const bx = (p[b] - x0) / step, by = (p[b + 1] - y0) / step;
      const cx = (p[c] - x0) / step, cy = (p[c + 1] - y0) / step;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-12) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(this.nx - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(this.ny - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
        const l1 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / den;
        const l2 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
        const z = l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2];
        const k = gy * this.nx + gx;
        if (z > this.z[k]) this.z[k] = z;
      }
    }
  }
  get(x, y) {
    const fx = clamp((x - this.x0) / this.step, 0, this.nx - 1.001), fy = clamp((y - this.y0) / this.step, 0, this.ny - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const k = iy * this.nx + ix, z = this.z;
    return lerp(lerp(z[k], z[k + 1], tx), lerp(z[k + this.nx], z[k + this.nx + 1], tx), ty);
  }
}

// ------------------------------------------------------------------ челюсть (общая для морфа и для губ/зубов)

/** Вес "принадлежности к нижней челюсти" для точки кожи. */
function jawWeight(x, y, z) {
  const line = LAYOUT.mouthY + 0.004 + Math.max(0, Math.abs(x) - 0.17) * 1.15;
  return smoothstep(line, line - 0.05, y) * smoothstep(-0.35, 0.05, z);
}
/** Смещение точки при jawOpen = 1 (линеаризованный поворот вокруг оси ВНЧС). */
function jawOpenDelta(y, z, out) {
  const ry = y - JAW_PIVOT.y, rz = z - JAW_PIVOT.z, c = Math.cos(JAW_THETA), s = Math.sin(JAW_THETA);
  out[0] = 0; out[1] = ry * c - rz * s - ry; out[2] = ry * s + rz * c - rz;
  return out;
}

// ------------------------------------------------------------------ morph targets кожи
// Каждая функция: (x, y, z, σ) → [dx, dy, dz]. σ = +1 для Left (персонажа = +X), -1 для Right.
const MORPHS = {
  jawOpen: (x, y, z, o) => { const w = jawWeight(x, y, z); jawOpenDelta(y, z, o); o[1] *= w; o[2] *= w; return o; },
  jawForward: (x, y, z, o) => { const w = jawWeight(x, y, z); o[0] = 0; o[1] = 0; o[2] = 0.045 * w; return o; },
  jawLeft: (x, y, z, o) => { const w = jawWeight(x, y, z); o[0] = 0.04 * w; o[1] = 0; o[2] = 0; return o; },
  jawRight: (x, y, z, o) => { const w = jawWeight(x, y, z); o[0] = -0.04 * w; o[1] = 0; o[2] = 0; return o; },
  mouthSmile: (x, y, z, o, sg) => {
    const g1 = G(sg * x, y, 0.27, -0.41, 0.085, 0.08), g2 = G(sg * x, y, 0.36, -0.28, 0.12, 0.12);
    o[0] = sg * 0.015 * g1; o[1] = 0.035 * g1 + 0.015 * g2; o[2] = 0.03 * g1 + 0.01 * g2; return o;
  },
  cheekSquint: (x, y, z, o, sg) => { const g = G(sg * x, y, 0.32, -0.11, 0.1, 0.06); o[0] = 0; o[1] = 0.03 * g; o[2] = 0.015 * g; return o; },
  noseSneer: (x, y, z, o, sg) => {
    const g = G(sg * x, y, 0.06, -0.14, 0.04, 0.06), g2 = G(sg * x, y, 0.07, -0.245, 0.035, 0.03);
    o[0] = sg * 0.004 * g2; o[1] = 0.02 * g + 0.018 * g2; o[2] = 0.006 * g; return o;
  },
  browDown: (x, y, z, o, sg) => {
    const g = G(sg * x, y, 0.18, 0.25, 0.1, 0.06), g2 = G(x, y, 0, 0.27, 0.05, 0.05) * 0.5;
    o[0] = -sg * 0.01 * g; o[1] = -0.02 * g; o[2] = 0.008 * g + 0.012 * g2; return o;
  },
  browOuterUp: (x, y, z, o, sg) => { const g = G(sg * x, y, 0.38, 0.3, 0.12, 0.09); o[0] = 0; o[1] = 0.025 * g; o[2] = 0; return o; },
  browInnerUp: (x, y, z, o) => { const g = G(Math.abs(x), y, 0.14, 0.3, 0.12, 0.1); o[0] = 0; o[1] = 0.022 * g; o[2] = 0.003 * g; return o; },
  cheekPuff: (x, y, z, o) => { const g = G(Math.abs(x), y, 0.3, -0.45, 0.1, 0.1); o[0] = Math.sign(x) * 0.05 * g; o[1] = 0; o[2] = 0.03 * g; return o; },
  mouthPucker: (x, y, z, o) => { const g = G(x, y, 0, -0.52, 0.16, 0.1); o[0] = -x * 0.15 * g; o[1] = 0; o[2] = 0.035 * g; return o; },
  mouthFunnel: (x, y, z, o) => { const g = G(x, y, 0, -0.52, 0.16, 0.1); o[0] = 0; o[1] = 0; o[2] = 0.02 * g; return o; },
  mouthFrown: (x, y, z, o, sg) => { const g = G(sg * x, y, 0.24, -0.6, 0.06, 0.06); o[0] = 0; o[1] = -0.015 * g; o[2] = 0; return o; },
  mouthStretch: (x, y, z, o, sg) => { const g = G(sg * x, y, 0.26, -0.56, 0.06, 0.07); o[0] = sg * 0.01 * g; o[1] = -0.01 * g; o[2] = 0; return o; },
  mouthDimple: (x, y, z, o, sg) => { const g = G(sg * x, y, 0.235, -0.52, 0.03, 0.04); o[0] = 0; o[1] = 0; o[2] = -0.012 * g; return o; },
  mouthShrugLower: (x, y, z, o) => { const g = G(x, y, 0, -0.7, 0.12, 0.08); o[0] = 0; o[1] = 0.02 * g; o[2] = 0.01 * g; return o; },
};
const SIDED = new Set(['mouthSmile', 'cheekSquint', 'noseSneer', 'browDown', 'browOuterUp', 'mouthFrown', 'mouthStretch', 'mouthDimple']);
/** Плоский список морфов кожи: { name, fn, sg }. Челюстные морфы губы/зубы считают сами (с явным весом). */
const MORPH_LIST = [];
for (const m in MORPHS) {
  if (SIDED.has(m)) { MORPH_LIST.push({ name: m + 'Left', fn: MORPHS[m], sg: 1 }, { name: m + 'Right', fn: MORPHS[m], sg: -1 }); }
  else MORPH_LIST.push({ name: m, fn: MORPHS[m], sg: 1, jaw: m.startsWith('jaw') });
}

// ------------------------------------------------------------------ текстуры (canvas, без файлов)

function eyeTexture(P) {
  const W = 512, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
  const ci = new THREE.Color(P.iris[0]), co = new THREE.Color(P.iris[1]);
  const pupil = 0.19, iris = 0.53, limbus = 0.6;
  const rnd = [];
  for (let j = 0; j < W; j++) rnd.push(Math.random());
  for (let y = 0; y < H; y++) {
    const a = (y / H) * Math.PI;                                    // угол от полюса (центра зрачка)
    for (let x = 0; x < W; x++) {
      let r, g, b;
      if (a < pupil) { r = g = b = 6; }
      else if (a < iris) {
        const t = (a - pupil) / (iris - pupil);
        const streak = 0.75 + 0.5 * (rnd[x] * 0.6 + 0.4 * rnd[(x * 7) % W]) * Math.sin(t * 9 + rnd[x] * 6) ** 2;
        const col = t < 0.25 ? 1.25 : 1;                              // светлое "ожерелье" у зрачка
        const k = lerp(1, 0.55, t ** 2) * streak * col;
        r = lerp(ci.r, co.r, t) * 255 * k * 1.6; g = lerp(ci.g, co.g, t) * 255 * k * 1.6; b = lerp(ci.b, co.b, t) * 255 * k * 1.6;
      } else if (a < limbus) {
        const t = (a - iris) / (limbus - iris);
        r = lerp(30, 236, t * t); g = lerp(26, 228, t * t); b = lerp(24, 222, t * t);
      } else {
        const t = smoothstep(1.0, 1.7, a);
        r = lerp(240, 225, t); g = lerp(234, 196, t); b = lerp(228, 190, t);
        if (rnd[x] > 0.985 && a > 1.1) { g -= 40 * t; b -= 40 * t; }   // намёк на сосуды
      }
      const k = (y * W + x) * 4;
      d[k] = clamp(r, 0, 255); d[k + 1] = clamp(g, 0, 255); d[k + 2] = clamp(b, 0, 255); d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function teethTexture() {
  const W = 512, H = 128, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b4545a'; ctx.fillRect(0, 0, W, H);              // дёсны
  const n = 12;
  for (let i = 0; i < n; i++) {
    const cx = ((i + 0.5) / n) * W, dist = Math.abs(i + 0.5 - n / 2) / (n / 2);
    const w = (W / n) * (dist < 0.2 ? 1.1 : dist < 0.4 ? 0.95 : 0.85);
    const g = ctx.createLinearGradient(0, 20, 0, H);
    g.addColorStop(0, '#d8cbb4'); g.addColorStop(0.5, '#f4efe4'); g.addColorStop(1, '#e9e2d4');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2 + 2, 24, w - 4, H - 26, [6, 6, 14, 14]);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hairTexture(color) {
  const W = 256, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(color);
  ctx.fillStyle = '#' + base.getHexString(); ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * W, l = 0.6 + Math.random() * 0.9;
    const col = base.clone().multiplyScalar(l);
    ctx.strokeStyle = `rgba(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0},0.5)`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (Math.random() - 0.5) * 20, H * 0.33, x + (Math.random() - 0.5) * 20, H * 0.66, x + (Math.random() - 0.5) * 10, H);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  return tex;
}

// ------------------------------------------------------------------ динамические геометрии

/** Сетка (cols+1)×(rows+1) с перезаписываемыми позициями — для губ, полости рта, зубов. */
function dynamicGrid(cols, rows, withColor = false) {
  const g = new THREE.BufferGeometry();
  const n = (cols + 1) * (rows + 1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * 2);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) { const k = r * (cols + 1) + c; uv[k * 2] = c / cols; uv[k * 2 + 1] = 1 - r / rows; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (withColor) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  const idx = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  g.setIndex(idx);
  g.userData = { cols, rows };
  return g;
}

/** Сужающаяся трубка с эллиптическим сечением (брови). */
class TaperedTube {
  constructor(segments = 28, radial = 8) {
    this.seg = segments; this.rad = radial;
    this.geo = dynamicGrid(radial, segments);
    const id = this.geo.index.array;                 // обратный порядок обхода — наружу
    for (let i = 0; i < id.length; i += 3) { const t = id[i + 1]; id[i + 1] = id[i + 2]; id[i + 2] = t; }
    this.curve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
    this._t = new THREE.Vector3(); this._v = new THREE.Vector3(); this._n = new THREE.Vector3(); this._p = new THREE.Vector3();
  }
  update(points, radiusFn, normalHint, flat = 0.45) {
    this.curve.points = points;
    const pos = this.geo.attributes.position.array;
    for (let i = 0; i <= this.seg; i++) {
      const s = i / this.seg;
      this.curve.getPoint(s, this._p);              // без arc-length: кэш длин не нужен, точки меняются каждый кадр
      this.curve.getTangent(s, this._t);
      this._v.crossVectors(normalHint, this._t).normalize();
      this._n.crossVectors(this._t, this._v).normalize();
      const r = radiusFn(s);
      for (let j = 0; j <= this.rad; j++) {
        const a = (j / this.rad) * Math.PI * 2;
        const k = (i * (this.rad + 1) + j) * 3;
        const cv = Math.cos(a) * r, sn = Math.sin(a) * r * flat;
        pos[k] = this._p.x + this._v.x * cv + this._n.x * sn;
        pos[k + 1] = this._p.y + this._v.y * cv + this._n.y * sn;
        pos[k + 2] = this._p.z + this._v.z * cv + this._n.z * sn;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
}

// ------------------------------------------------------------------ голова

export class ProceduralHead {
  /**
   * @param {object} o
   * @param {'female'|'male'} o.gender
   * @param {boolean} o.shadows
   * @param {object} o.overrides  — переопределить параметры пресета (skin, hair, iris, cloth, ...)
   */
  constructor({ gender = 'female', shadows = true, overrides = {} } = {}) {
    this.gender = gender;
    this.shadows = shadows;
    this.P = { ...PRESETS[gender] || PRESETS.female, ...overrides };
    this.object3D = new THREE.Group();
    this.object3D.name = 'ProceduralHead';
    this._disposables = [];
    this._v3 = [0, 0, 0];
    this._build();
  }

  _track(x) { this._disposables.push(x); return x; }

  _build() {
    const P = this.P;
    const root = this.object3D;

    // --- материалы
    this.mat = {
      skin: this._track(new THREE.MeshPhysicalMaterial({
        color: P.skin, roughness: 0.55, metalness: 0, vertexColors: true,
        sheen: 0.45, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ff9a80'),
        clearcoat: 0.06, clearcoatRoughness: 0.5, envMapIntensity: 0.6,
      })),
      lid: null,
      lip: this._track(new THREE.MeshPhysicalMaterial({ color: P.lip, roughness: 0.38, vertexColors: true, clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.3, sheenColor: new THREE.Color('#ff8080'), side: THREE.DoubleSide, envMapIntensity: 0.6, depthTest: false })),
      brow: this._track(new THREE.MeshStandardMaterial({ color: P.brow.color, roughness: 0.9 })),
      lash: this._track(new THREE.MeshStandardMaterial({ color: '#120c0a', roughness: 0.8 })),
      hair: this._track(new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: this._track(hairTexture(P.hair)), roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(P.hair).multiplyScalar(2.2), sheenRoughness: 0.35, vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.5 })),
      cloth: this._track(new THREE.MeshStandardMaterial({ color: P.cloth, roughness: 0.85 })),
      eye: this._track(new THREE.MeshPhysicalMaterial({ map: this._track(eyeTexture(P)), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.3 })),
    };
    this.mat.lid = this._track(this.mat.skin.clone());
    this.mat.lid.vertexColors = true;
    this.mat.lid.side = THREE.DoubleSide;
    this.mat.lid.color = new THREE.Color(P.skin).multiply(new THREE.Color(...P.lidTint));
    this.mat.neck = this._track(this.mat.skin.clone());
    this.mat.neck.vertexColors = false;
    this.mat.neck.color = new THREE.Color(P.skin).multiplyScalar(0.92);

    // --- иерархия: root → body; root → headPivot → headRoot → части лица
    this.body = new THREE.Group();
    root.add(this.body);
    this.headPivot = new THREE.Group();
    this.headPivot.position.copy(LAYOUT.pivot);
    this.headPivot.rotation.order = 'YXZ';
    root.add(this.headPivot);
    this.headRoot = new THREE.Group();
    this.headRoot.position.copy(LAYOUT.pivot).negate();
    this.headPivot.add(this.headRoot);

    this._buildSkin();
    this._buildEyes();
    this._buildBrows();
    this._buildMouth();
    this._buildHair();
    this._buildEars();
    this._buildBody();

    root.traverse((o) => {
      if (o.isMesh && this.shadows && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  // ---------------- кожа + morph targets
  _buildSkin() {
    const P = this.P;
    const geo = this._track(sphereGrid(240, 200, (px, py, pz, out) => shapeHead(px, py, pz, P, out), 0.36, 0.6));
    // проход 2: глазницы облегают глазное яблоко
    const hm0 = new HeightMap(geo);
    const eyeR = P.eyeR, rs = eyeR * 1.08;
    const ex = P.eyeX ?? LAYOUT.eyeX;
    this.eye = { r: eyeR, rs, rl: eyeR * 1.03, x: ex, y: LAYOUT.eyeY, z: hm0.get(ex, LAYOUT.eyeY) - 0.078 };
    const E = this.eye;
    const pos = geo.attributes.position.array;
    this._eyeRing = new Float32Array(pos.length / 3);
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (z < 0.35) continue;
      const dx = (Math.abs(x) - E.x) / rs, dy = (y - E.y) / rs;
      const dist = Math.hypot(dx, dy) * rs;
      // нижнее веко плотнее облегает яблоко (меньше "мешков"), верхнее — объёмнее
      const rr = lerp(rs, E.rl, smoothstep(0, -0.35, dy));
      const rho = dist / rr;
      if (rho > 1.9) continue;
      // зона максимального раскрытия глаза: здесь кожа уходит ЗА глазное яблоко
      const eo = Math.hypot(dx / 0.97, dy > 0 ? dy / 0.74 : dy / 0.5);
      const inner = E.z + Math.sqrt(Math.max(0, (0.93 * E.r) ** 2 - dist * dist));
      // вокруг — кожа вровень с оболочкой века (веко как бы вырастает из кожи, без "ямы")
      const flush = E.z + Math.sqrt(Math.max(0, rr * rr - Math.min(dist, rr * 0.999) ** 2)) - 0.006;
      let T = lerp(inner, flush, smoothstep(0.92, 1.03, eo));
      // за гладким силуэтом оболочки века кожа поднимается к естественной поверхности (складка века)
      if (rho >= 1) T = E.z - 0.006 + rr * 4.6 * Math.pow(rho - 1, 1.1);
      const m = 1 - smoothstep(1.25, 1.8, rho);
      pos[k + 2] = lerp(z, Math.min(z, T), m);
      // затенение глазницы: мягкий градиент по всей стенке, а не светлое кольцо
      this._eyeRing[k / 3] = (rho < 1 ? smoothstep(0.85, 1.0, rho) : 1 - smoothstep(1.0, 1.5, rho)) * m * (dy > 0 ? 1 : 0.9);
    }
    geo.computeVertexNormals();
    this.hm = new HeightMap(geo);

    // morph targets (относительные) + нормали морфов
    const names = [];
    const morphPos = [];
    const o = [0, 0, 0];
    const addMorph = (name, fn, sg) => {
      const d = new Float32Array(pos.length);
      for (let k = 0; k < pos.length; k += 3) {
        const x = pos[k], y = pos[k + 1], z = pos[k + 2];
        const front = smoothstep(-0.1, 0.3, z);
        o[0] = o[1] = o[2] = 0;
        fn(x, y, z, o, sg);
        d[k] = o[0] * front; d[k + 1] = o[1] * front; d[k + 2] = o[2] * front;
      }
      // (морф-нормали не храним: деформации мягкие, а это вдвое меньше видеопамяти)
      morphPos.push(new THREE.BufferAttribute(d, 3));
      names.push(name);
    };
    for (const m in MORPHS) {
      if (SIDED.has(m)) { addMorph(m + 'Left', MORPHS[m], 1); addMorph(m + 'Right', MORPHS[m], -1); }
      else addMorph(m, MORPHS[m], 1);
    }
    geo.morphAttributes.position = morphPos;
    geo.morphTargetsRelative = true;

    // vertex colors: AO, румянец, щетина
    const col = new Float32Array(pos.length);
    const blush = [1, 0.74, 0.74];
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2], ax = Math.abs(x);
      const yn = noseY(y, P), nw = (P.noseW ?? 0.07) / 0.07;
      let r = 1, g = 1, b = 1;
      if (z > 0) {
        let ao = 0;
        ao += 0.22 * G(ax, y, E.x - E.r * 0.95, 0.03, 0.03, 0.035);          // внутренний угол глаза
        ao += 0.26 * this._eyeRing[k / 3];                                     // глазница / складка века
        ao += 0.65 * G(ax, yn, 0.05 * nw, -0.272, 0.017 * nw, 0.011);         // ноздри
        ao += 0.16 * G(x, yn, 0, -0.285, 0.07 * nw, 0.016);                    // под носом
        ao += 0.3 * G(ax, y, 0.205, -0.52, 0.022, 0.02);                       // уголки рта
        ao += 0.12 * G(x, y, 0, -0.63, 0.1, 0.02);                             // под губой
        ao += 0.25 * smoothstep(-0.82, -0.98, y);                              // под подбородком
        ao += 0.1 * G(ax, y, 0.14, -0.36, 0.035, 0.08);                        // носогубка
        r *= 1 - ao; g *= 1 - ao * 1.1; b *= 1 - ao * 1.1;
        const bl = P.blush * (G(ax, y, 0.4, -0.2, 0.11, 0.1) + 0.4 * G(x, yn, 0, -0.21, 0.05, 0.04) + 0.25 * G(x, y, 0, -0.78, 0.1, 0.06));
        r = lerp(r, r * blush[0], bl); g = lerp(g, g * blush[1], bl); b = lerp(b, b * blush[2], bl);
        if (P.stubble) {
          const line = -0.3 + 0.28 * smoothstep(0.3, 0.72, ax);
          let m = smoothstep(line, line - 0.12, y) * smoothstep(-0.2, 0.2, z);
          m = Math.max(m, G(x, y, 0, -0.42, 0.16, 0.045));                    // усы
          m *= 1 - 0.85 * G(ax, y, 0.38, -0.32, 0.1, 0.09);                    // чистые щёки
          const s = P.stubble * m;
          r *= Math.max(0.2, 1 - 0.3 * s); g *= Math.max(0.2, 1 - 0.3 * s); b *= Math.max(0.22, 1 - 0.24 * s);
        }
      }
      col[k] = r; col[k + 1] = g; col[k + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    // текстура кожи с фотографии (photo-avatar.js): UV = проекция лица на снимок
    if (P.photo) {
      P.photo.prepare?.({ pos, hm: this.hm, eye: this.eye, P });
      const uv = geo.attributes.uv.array, t = [0, 0];
      for (let k = 0, i = 0; k < pos.length; k += 3, i += 2) {
        P.photo.uv(pos[k], pos[k + 1], pos[k + 2], t);
        uv[i] = t[0]; uv[i + 1] = t[1];
      }
      geo.attributes.uv.needsUpdate = true;
      const tex = this._track(new THREE.CanvasTexture(P.photo.canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.mat.skin.map = tex;
      this.mat.skin.color.set('#ffffff');
      this.mat.skin.sheenColor = new THREE.Color(P.skin).multiplyScalar(0.8);
      this.mat.skin.needsUpdate = true;
    }

    const mesh = new THREE.Mesh(geo, this.mat.skin);
    mesh.name = 'skin';
    mesh.morphTargetDictionary = {};
    names.forEach((n, i) => { mesh.morphTargetDictionary[n] = i; });
    mesh.morphTargetInfluences = new Array(names.length).fill(0);
    mesh.frustumCulled = false;
    this.skin = mesh;
    this.headRoot.add(mesh);
  }

  // ---------------- глаза и веки
  _buildEyes() {
    const P = this.P, E = this.eye;
    const ballGeo = this._track(new THREE.SphereGeometry(E.r, 48, 32));
    ballGeo.rotateX(Math.PI / 2);                     // полюс (зрачок) → +Z
    const phiS = Math.PI / 2 - 1.75, phiL = 3.5;
    const upGeo = this._track(new THREE.SphereGeometry(E.rs, 56, 14, phiS, phiL, 0, Math.PI / 2));
    const loGeo = this._track(new THREE.SphereGeometry(E.rl, 56, 10, phiS, phiL, Math.PI / 2, Math.PI / 2));
    // веко темнеет к складке (как кожа глазницы), светлое — только у кромки
    const shadeLid = (geo, upper) => {
      const p = geo.attributes.position, c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const el = Math.asin(clamp(p.getY(i) / geo.parameters.radius, -1, 1));       // угол возвышения точки
        const fromEdge = upper ? el : -el;                                             // 0 у кромки → π/2 у полюса
        const v = lerp(1.0, 0.7, smoothstep(0.35, 1.25, fromEdge)) * (fromEdge < 0.12 ? lerp(0.86, 1, fromEdge / 0.12) : 1);
        c.set([v, v * 0.97, v * 0.97], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    };
    shadeLid(upGeo, true); shadeLid(loGeo, false);
    const lashGeo = this._track(new THREE.TorusGeometry(E.rs * 1.004, P.lash, 5, 40, Math.PI));
    lashGeo.rotateX(Math.PI / 2);
    const lashLoGeo = this._track(new THREE.TorusGeometry(E.rl * 1.004, P.lash * 0.28, 4, 32, Math.PI * 0.8));
    lashLoGeo.rotateX(Math.PI / 2);
    lashLoGeo.rotateY(-Math.PI * 0.1);
    // мягкая тень от верхнего века: полоса с альфа-градиентом прямо под кромкой
    const shGeo = this._track(new THREE.SphereGeometry(E.r * 1.012, 48, 6, phiS + 0.2, phiL - 0.4, Math.PI / 2, 0.42));
    const shPos = shGeo.attributes.position, shCol = new Float32Array(shPos.count * 4);
    for (let i = 0; i < shPos.count; i++) {
      const y = shPos.getY(i) / (E.r * 1.012);        // 0 на кромке, отрицательный ниже
      const a = smoothstep(-0.4, 0.0, y) * 0.55;
      shCol.set([0.05, 0.02, 0.02, a], i * 4);
    }
    shGeo.setAttribute('color', new THREE.BufferAttribute(shCol, 4));
    const shMat = this._track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));

    this.eyes = [];
    for (const sg of [1, -1]) {                         // 1 = левый глаз персонажа (+X)
      const g = new THREE.Group();
      g.position.set(sg * E.x, E.y, E.z);
      const ball = new THREE.Mesh(ballGeo, this.mat.eye);
      ball.rotation.order = 'YXZ';
      ball.userData.noShadow = false;
      g.add(ball);
      const lids = new THREE.Group();
      lids.rotation.z = sg * P.eyeTilt;
      g.add(lids);
      const up = new THREE.Mesh(upGeo, this.mat.lid);
      const lo = new THREE.Mesh(loGeo, this.mat.lid);
      const lash = new THREE.Mesh(lashGeo, this.mat.lash);
      const lashLo = new THREE.Mesh(lashLoGeo, this.mat.lash);
      const sh = new THREE.Mesh(shGeo, shMat);
      sh.userData.noShadow = true;
      sh.renderOrder = 1;
      lash.userData.noShadow = true; lashLo.userData.noShadow = true;
      up.add(lash, sh);
      lo.add(lashLo);
      lids.add(up, lo);
      this.headRoot.add(g);
      this.eyes.push({ sg, group: g, ball, up, lo });
    }
  }

  // ---------------- брови
  _buildBrows() {
    this.brows = [];
    for (const sg of [1, -1]) {
      const tube = new TaperedTube(28, 8);
      this._track(tube.geo);
      const mesh = new THREE.Mesh(tube.geo, this.mat.brow);
      mesh.frustumCulled = false;
      this.headRoot.add(mesh);
      const pts = [0, 1, 2, 3, 4].map(() => new THREE.Vector3());
      this.brows.push({ sg, tube, mesh, pts, normal: new THREE.Vector3(sg * 0.45, 0.2, 1).normalize() });
    }
  }

  _updateBrows(ch) {
    const P = this.P, B = P.brow, hm = this.hm;
    for (const b of this.brows) {
      const S = b.sg > 0 ? 'Left' : 'Right';
      const inner = ch.browInnerUp || 0, down = ch['browDown' + S] || 0, outer = ch['browOuterUp' + S] || 0;
      for (let i = 0; i < 5; i++) {
        const s = i / 4;
        let x = lerp(B.x0 ?? 0.085, B.x1 ?? 0.45, s);
        let y = B.y + B.arch * Math.sin(Math.PI * Math.min(1, s * 1.12)) ** 0.9 + (B.tail ?? -0.025) * s * s;
        y += inner * (0.06 * (1 - s) ** 1.3 + 0.012) - inner * 0.014 * s * (1 - outer);
        y += outer * 0.055 * s ** 1.1;
        y -= down * (0.068 * (1 - s) ** 1.2 + 0.012);       // "V": внутренние концы вниз сильнее
        x -= down * 0.032 * (1 - s);
        x *= b.sg;
        const z = hm.get(x, y) + 0.006 + down * 0.012 * (1 - s);
        b.pts[i].set(x, y, z);
      }
      const t0 = B.thick;
      b.tube.update(b.pts, (s) => t0 * Math.min(1, 0.55 + s * 5) * (1 - 0.72 * s ** 1.4), b.normal, 0.42);
    }
  }

  // ---------------- рот: полость, зубы, язык (stencil), губы
  _buildMouth() {
    const P = this.P;
    const stencilWrite = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilFail: THREE.ReplaceStencilOp };
    const stencilTest = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp };
    // Рот рисуется поверх кожи без теста глубины (порядок: полость → язык → зубы → губы).
    // Так деформированная кожа никогда не "протыкает" губы; рот фронтальный, при поворотах до ±20° это незаметно.
    const cavMat = this._track(new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, ...stencilWrite }));
    const teethMat = this._track(new THREE.MeshStandardMaterial({ map: this._track(teethTexture()), roughness: 0.35, vertexColors: true, depthTest: false, depthWrite: false, ...stencilTest }));
    const tongueMat = this._track(new THREE.MeshStandardMaterial({ color: '#b5525a', roughness: 0.5, vertexColors: true, depthTest: false, depthWrite: false, ...stencilTest }));

    this.mouth = {};
    const M = this.mouth;
    M.N = 36;
    M.cav = new THREE.Mesh(this._track(dynamicGrid(M.N, 8, true)), cavMat);
    M.tongue = new THREE.Mesh(this._track(dynamicGrid(16, 6, true)), tongueMat);
    M.teethL = new THREE.Mesh(this._track(dynamicGrid(24, 2, true)), teethMat);
    M.teethU = new THREE.Mesh(this._track(dynamicGrid(24, 2, true)), teethMat);
    M.lipU = new THREE.Mesh(this._track(dynamicGrid(M.N, 7, true)), this.mat.lip);
    M.lipL = new THREE.Mesh(this._track(dynamicGrid(M.N, 7, true)), this.mat.lip);
    let order = 10;
    for (const k of ['cav', 'tongue', 'teethL', 'teethU', 'lipU', 'lipL']) {
      const m = M[k];
      m.renderOrder = order++;
      m.frustumCulled = false;
      if (k !== 'lipU' && k !== 'lipL') m.userData.noShadow = true;
      this.headRoot.add(m);
    }
    // постоянные цвета: зубы темнеют к краям (тень во рту), губы темнеют к внутренней кромке
    const shadeTeeth = (geo) => {
      const { cols, rows } = geo.userData, c = geo.attributes.color.array;
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const t = (i / cols) * 2 - 1, k = (r * (cols + 1) + i) * 3, v = lerp(0.95, 0.35, Math.abs(t) ** 1.6);
        c[k] = c[k + 1] = c[k + 2] = v;
      }
    };
    shadeTeeth(M.teethU.geometry); shadeTeeth(M.teethL.geometry);
    const shadeLip = (geo) => {
      const { cols, rows } = geo.userData, c = geo.attributes.color.array;
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const s = r / rows, t = (i / cols) * 2 - 1, k = (r * (cols + 1) + i) * 3;
        const v = lerp(0.55, 1, smoothstep(0, 0.35, s)) * lerp(1, 0.75, Math.abs(t) ** 4);
        c[k] = v; c[k + 1] = v * 0.97; c[k + 2] = v * 0.97;
      }
    };
    shadeLip(M.lipU.geometry); shadeLip(M.lipL.geometry);
    const cc = M.cav.geometry.attributes.color.array, cr = 8;
    for (let r = 0; r <= cr; r++) for (let i = 0; i <= M.N; i++) {
      const t = (i / M.N) * 2 - 1, s = r / cr, k = (r * (M.N + 1) + i) * 3;
      const edge = Math.max(Math.abs(t) ** 2, Math.abs(s - 0.5) * 2) ** 2;
      cc[k] = lerp(0.045, 0.22, edge); cc[k + 1] = lerp(0.01, 0.055, edge); cc[k + 2] = lerp(0.014, 0.06, edge);
    }
    const tc = M.tongue.geometry.attributes.color.array;
    for (let r = 0; r <= 6; r++) for (let i = 0; i <= 16; i++) {
      const k = (r * 17 + i) * 3, v = lerp(0.4, 1, (1 - Math.abs(i / 16 * 2 - 1) ** 2) * (r / 6));
      tc[k] = tc[k + 1] = tc[k + 2] = v;
    }
    M.tongue.geometry.attributes.color.needsUpdate = true;
  }

  /** Точка рта: (x, y) в покое + вес челюсти w → мировая (локальная головы) позиция. */
  _mouthPoint(x, y, zOff, w, J, out, k) {
    const z0 = this.hm.get(x, y), z = z0 + zOff;
    const d = this._v3;
    // губы/полость/зубы "едут" вместе с деформированной кожей (улыбка, ямочки, трубочка...), иначе кожа их перекроет
    let mx = 0, my = 0, mz = 0;
    for (const a of this._activeMorphs) {
      d[0] = d[1] = d[2] = 0;
      a.fn(x, y, z0, d, a.sg);
      mx += d[0] * a.w; my += d[1] * a.w; mz += d[2] * a.w;
    }
    jawOpenDelta(y, z, d);
    out[k] = x + mx + w * (J.left * 0.04 - J.right * 0.04);
    out[k + 1] = y + my + w * J.open * d[1];
    out[k + 2] = z + mz + w * (J.open * d[2] + J.fwd * 0.045);
  }

  _updateMouth(ch) {
    const P = this.P, M = this.mouth, N = M.N, MY = LAYOUT.mouthY;
    const g = (k) => ch[k] || 0;
    const smL = g('mouthSmileLeft'), smR = g('mouthSmileRight'), frL = g('mouthFrownLeft'), frR = g('mouthFrownRight');
    const stL = g('mouthStretchLeft'), stR = g('mouthStretchRight'), dmL = g('mouthDimpleLeft'), dmR = g('mouthDimpleRight');
    const prL = g('mouthPressLeft'), prR = g('mouthPressRight'), puck = g('mouthPucker'), fun = g('mouthFunnel');
    const rollU = g('mouthRollUpper'), rollL = g('mouthRollLower'), shU = g('mouthShrugUpper'), shL = g('mouthShrugLower');
    const close = g('mouthClose'), shift = g('mouthLeft') - g('mouthRight');
    const upL = g('mouthUpperUpLeft'), upR = g('mouthUpperUpRight'), ldL = g('mouthLowerDownLeft'), ldR = g('mouthLowerDownRight');
    const J = { open: g('jawOpen'), fwd: g('jawForward'), left: g('jawLeft'), right: g('jawRight') };
    const press = (prL + prR) / 2, smile = (smL + smR) / 2, stretch = (stL + stR) / 2;
    const round = clamp(puck + fun, 0, 1);

    const corner = (sg, sm, fr, st, dm, pr) => ({
      x: sg * P.mouthHW * (1 + 0.17 * sm + 0.3 * st + 0.1 * dm - 0.4 * puck - 0.28 * fun - 0.06 * pr) + 0.07 * shift,
      y: 0.072 * sm - 0.065 * fr - 0.012 * st + 0.018 * dm - 0.008 * pr,
      z: -0.02 * sm - 0.015 * dm + 0.02 * puck,
    });
    const cL = corner(1, smL, frL, stL, dmL, prL), cR = corner(-1, smR, frR, stR, dmR, prR);
    const pw = lerp(0.9, 0.5, round);
    const lowerJawW = 1 - 0.85 * close;            // mouthClose держит губы сомкнутыми при открытой челюсти
    const thU0 = Math.max(0.014, P.lipU * (1 - 0.35 * press - 0.55 * rollU - 0.22 * smile - 0.1 * stretch + 0.35 * puck + 0.15 * fun + 0.15 * shU));
    const thL0 = Math.max(0.016, P.lipL * (1 - 0.35 * press - 0.62 * rollL - 0.18 * smile + 0.35 * puck + 0.1 * fun + 0.2 * shL));

    // контуры (в покое, до челюсти)
    const C = M.contour || (M.contour = { x: new Float32Array(N + 1), cy: new Float32Array(N + 1), cz: new Float32Array(N + 1), u: new Float32Array(N + 1), l: new Float32Array(N + 1), thU: new Float32Array(N + 1), thL: new Float32Array(N + 1), wU: new Float32Array(N + 1), wL: new Float32Array(N + 1), zl: new Float32Array(N + 1) });
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 - 1, f = (1 + t) / 2, at = Math.abs(t);
      const bell = Math.pow(Math.max(0, 1 - t * t), pw);
      C.x[i] = lerp(cR.x, cL.x, f);
      C.cy[i] = MY + lerp(cR.y, cL.y, f) * at ** 1.7;          // центр рта на месте, уголки поднимаются/опускаются
      C.cz[i] = lerp(cR.z, cL.z, f) * at ** 2;
      const U = 0.034 * lerp(upR, upL, f) + 0.022 * fun + 0.008 * shU + 0.006 * puck;
      const D = 0.03 * lerp(ldR, ldL, f) + 0.03 * fun + 0.012 * stretch + 0.004 * puck;
      C.u[i] = C.cy[i] + U * bell + 0.012 * shU - 0.004 * rollU;
      C.l[i] = C.cy[i] - D * bell + 0.012 * shL + 0.012 * rollL;
      const bow = 1 - 0.2 * Math.exp(-((t / 0.09) ** 2)) + 0.12 * Math.exp(-(((at - 0.2) / 0.1) ** 2));
      C.thU[i] = thU0 * Math.pow(Math.max(0, 1 - at ** 2.4), 0.55) * bow;
      C.thL[i] = thL0 * Math.pow(Math.max(0, 1 - at ** 2.2), 0.5);
      const cw = 0.5 * at ** 4;                     // в уголках губы делят движение челюсти пополам
      C.wU[i] = cw * lowerJawW;
      C.wL[i] = (1 - cw) * lowerJawW;
      C.zl[i] = (0.03 * puck + 0.02 * fun) * (1 - t * t) - 0.008 * press + C.cz[i];
    }

    // губы
    const lip = (mesh, upper) => {
      const geo = mesh.geometry, rows = geo.userData.rows, pos = geo.attributes.position.array;
      const roll = upper ? rollU : rollL;
      for (let r = 0; r <= rows; r++) {
        const s = r / rows;
        for (let i = 0; i <= N; i++) {
          const th = upper ? C.thU[i] : C.thL[i];
          const inner = upper ? C.u[i] : C.l[i];
          const y = upper ? inner + th * s : inner - th * s;
          const bulge = th * 0.55 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * s)), 0.65) * (1 - 0.3 * s);
          const curl = -0.012 * (1 - s) ** 3 - roll * 0.015 * (1 - s);
          const w = upper ? C.wU[i] : C.wL[i];
          this._mouthPoint(C.x[i], y, 0.004 + bulge + curl + C.zl[i], w, J, pos, (r * (N + 1) + i) * 3);
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    };
    lip(M.lipU, true);
    lip(M.lipL, false);

    // полость рта (немного шире внутреннего контура, чтобы не было щелей под губами)
    {
      const geo = M.cav.geometry, rows = geo.userData.rows, pos = geo.attributes.position.array;
      for (let r = 0; r <= rows; r++) {
        const s = r / rows;
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * 2 - 1, e = 1 - t * t;
          const y = lerp(C.u[i] + 0.012 * e, C.l[i] - 0.012 * e, s);
          const x = C.x[i] * 1.005;
          const w = lerp(C.wU[i], C.wL[i], s);
          this._mouthPoint(x, y, 0.002 + C.zl[i] * 0.8, w, J, pos, (r * (N + 1) + i) * 3);
        }
      }
      geo.attributes.position.needsUpdate = true;
    }

    // зубы: верхние на черепе, нижние на челюсти; дуга уходит назад к краям
    const teeth = (mesh, yTop, yBot, w) => {
      const geo = mesh.geometry, { cols, rows } = geo.userData, pos = geo.attributes.position.array;
      const hw = P.mouthHW * 0.95;
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const t = (i / cols) * 2 - 1, x = t * hw;
        const y = lerp(yTop, yBot, r / rows);
        this._mouthPoint(x, y, -0.006 - 0.05 * t * t + C.zl[N >> 1] * 0.5, w, J, pos, (r * (cols + 1) + i) * 3);
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    };
    teeth(M.teethU, MY + 0.03, MY - 0.032, 0);
    teeth(M.teethL, MY + 0.004, MY - 0.06, lowerJawW);

    // язык
    {
      const geo = M.tongue.geometry, { cols, rows } = geo.userData, pos = geo.attributes.position.array;
      const out = g('tongueOut');
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const t = (i / cols) * 2 - 1, s = r / rows;
        const x = t * P.mouthHW * 0.75 * Math.sqrt(1 - 0.6 * s * s);
        const y = MY - 0.075 + s * (0.05 + 0.05 * out) * (1 - 0.5 * t * t);
        this._mouthPoint(x, y, -0.03 + 0.04 * out * s - 0.03 * t * t, lowerJawW, J, pos, (r * (cols + 1) + i) * 3);
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  // ---------------- волосы
  _buildHair() {
    const P = this.P;
    if (P.hairStyle === 'none') return;
    const long = P.hairStyle === 'long';
    // линия роста волос как функция долготы (0 = лоб, π = затылок)
    const lineF = (long ? [0.6, 0.52, 0.34, 0.16, 0.0, -0.3, -0.5, -0.55] : [0.64, 0.57, 0.4, 0.24, 0.08, -0.2, -0.36, -0.4])
      .map((v, i) => v + (P.hairline || 0) * Math.max(0, 1 - i / 4));   // сдвиг линии у лба (по фото)
    const hairline = (a) => {
      const u = clamp(Math.abs(a) / Math.PI * (lineF.length - 1), 0, lineF.length - 1.001);
      const i = Math.floor(u);
      return lerp(lineF[i], lineF[i + 1], smoothstep(0, 1, u - i));
    };
    const tmp = [0, 0, 0];
    const geo = this._track(sphereGrid(220, 160, (px, py, pz, out) => {
      shapeHead(px, py, pz, P, tmp);
      const a = Math.atan2(tmp[0], tmp[2]);
      let yh = hairline(a);
      if (long) yh -= 0.1 * G(a, 0, -0.45, 0, 0.3, 1);                     // чёлка набок
      let H = long ? 0.06 + 0.06 * smoothstep(0.2, 0.9, tmp[1]) + 0.05 * G(a, tmp[1], -0.5, 0.45, 0.4, 0.18) : 0.032 + 0.018 * smoothstep(0.3, 0.9, tmp[1]);
      if (!long) H += 0.012 * G(a, tmp[1], 0, 0.6, 0.5, 0.1);               // лёгкий объём надо лбом
      // у линии роста волосы сходят на нет, ниже неё поверхность уходит глубоко под кожу
      const off = H * (0.3 + 0.7 * smoothstep(yh, yh + 0.16, tmp[1])) - (0.25 + 0.3 * H) * (1 - smoothstep(yh - 0.1, yh, tmp[1]));
      const nx = px / prof(P.gx, py), ny = py, nz = pz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      out[0] = tmp[0] + (nx / nl) * off; out[1] = tmp[1] + (ny / nl) * off; out[2] = tmp[2] + (nz / nl) * off;
    }));
    geo.computeVertexNormals();
    // цвет: корни темнее, верх с бликом
    const p = geo.attributes.position.array, col = new Float32Array(p.length);
    for (let k = 0; k < p.length; k += 3) { const v = lerp(0.6, 1.05, smoothstep(-0.4, 0.9, p[k + 1])); col[k] = col[k + 1] = col[k + 2] = v; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const cap = new THREE.Mesh(geo, this.mat.hair);
    cap.name = 'hair';
    this.headRoot.add(cap);

    if (long) {
      // "занавес" длинных волос сзади и по бокам
      const cols = 64, rows = 30, a0 = 1.0, wk = prof(P.gx, 0) / 0.755;   // занавес по ширине головы
      const g = this._track(dynamicGrid(cols, rows, true));
      const pos = g.attributes.position.array, c = g.attributes.color.array;
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const a = a0 + (i / cols) * (Math.PI * 2 - 2 * a0);
        const bottom = (P.hairBottom ?? -1.55) + 0.07 * Math.sin(a * 5) + 0.05 * Math.sin(a * 13);
        const y = lerp(0.42, bottom, r / rows);
        const flare = smoothstep(-0.2, -1.5, y);
        const front = Math.cos(a) > 0 ? Math.cos(a) : 0;
        const jaw = smoothstep(0.1, -0.7, y) * (1 - smoothstep(-0.9, -1.3, y)) * front;   // у лица пряди ближе к щекам
        const rx = (0.84 + 0.1 * flare + 0.012 * Math.sin(a * 9 + y * 3) - 0.1 * jaw) * wk;
        const rz = 0.86 + 0.06 * flare + 0.012 * Math.sin(a * 7 - y * 2) - 0.12 * jaw;
        const k = (r * (cols + 1) + i) * 3;
        pos[k] = rx * Math.sin(a); pos[k + 1] = y; pos[k + 2] = -0.08 + rz * Math.cos(a);
        const v = lerp(0.95, 0.55, r / rows) * (0.9 + 0.1 * Math.sin(i * 1.7));
        c[k] = c[k + 1] = c[k + 2] = v;
      }
      g.computeVertexNormals();
      const curtain = new THREE.Mesh(g, this.mat.hair);
      curtain.name = 'hairLong';
      this.headRoot.add(curtain);
    }
  }

  _buildEars() {
    if (this.P.hairStyle === 'long' && !this.P.ears) return;
    const geo = this._track(new THREE.SphereGeometry(1, 24, 16));
    const inGeo = this._track(new THREE.SphereGeometry(1, 16, 12));
    const inMat = this._track(this.mat.neck.clone());
    inMat.color = new THREE.Color(this.P.skin).multiplyScalar(0.6);
    const w = prof(this.P.gx, -0.06) * 0.998, es = clamp(w / 0.785, 0.85, 1.1);   // уши на силуэте головы
    for (const sg of [1, -1]) {
      const ear = new THREE.Mesh(geo, this.mat.neck);
      ear.position.set(sg * (w + 0.02), -0.06, -0.06);
      ear.scale.set(0.06 * es, 0.17 * es, 0.11 * es);
      ear.rotation.y = sg * -0.35;
      const inner = new THREE.Mesh(inGeo, inMat);
      inner.position.set(sg * 0.25, -0.05, 0.1);
      inner.scale.set(0.5, 0.6, 0.6);
      ear.add(inner);
      this.headRoot.add(ear);
    }
  }

  _buildBody() {
    const P = this.P;
    const r = P.neckR;
    const neckPts = [[r, -0.45], [r * 0.97, -0.9], [r * 1.05, -1.25], [r * 1.5, -1.5], [r * 2.6, -1.72], [r * 3.6, -1.92]].map(([x, y]) => new THREE.Vector2(x, y));
    const neckGeo = this._track(new THREE.LatheGeometry(neckPts, 48));
    neckGeo.scale(1, 1, 0.6);
    const neck = new THREE.Mesh(neckGeo, this.mat.neck);
    neck.position.set(0, 0, -0.15);
    this.body.add(neck);
    const top = P.hairStyle === 'long' ? -1.56 : -1.38;
    const topR = P.hairStyle === 'long' ? r * 2.05 : r * 1.45;
    const clothPts = [[topR * 0.97, top + 0.02], [topR, top], [topR * 1.02, top - 0.03], [1.05, -1.74], [1.36, -1.9], [1.55, -2.15], [1.64, -2.6], [1.66, -3.4]].map(([x, y]) => new THREE.Vector2(x, y));
    const clothGeo = this._track(new THREE.LatheGeometry(clothPts, 64));
    clothGeo.scale(1, 1, 0.6);
    this.torso = new THREE.Mesh(clothGeo, this.mat.cloth);
    this.torso.position.set(0, 0, -0.15);
    this.body.add(this.torso);
  }

  // ------------------------------------------------------------------ кадр
  /**
   * @param {Object<string,number>} ch  ARKit-каналы 0..1
   * @param {object} pose  { pitch, yaw, roll, eyeYaw, eyePitch, breath, focus }
   */
  update(ch, pose) {
    // morph targets
    const inf = this.skin.morphTargetInfluences, dict = this.skin.morphTargetDictionary;
    for (const name in dict) inf[dict[name]] = ch[name] || 0;

    // голова
    this.headPivot.rotation.set(pose.pitch, pose.yaw, pose.roll);
    const br = pose.breath || 0;
    this.body.position.y = br * 0.012;
    this.body.scale.set(1 + br * 0.006, 1, 1 + br * 0.01);
    this.headPivot.position.y = LAYOUT.pivot.y + br * 0.01;

    // глаза: сходимость на точку фокуса + веки следуют за взглядом
    const E = this.eye, focus = pose.focus || 6;
    const tx = Math.tan(pose.eyeYaw) * focus, ty = Math.tan(pose.eyePitch) * focus;
    const pitchDeg = pose.eyePitch / DEG;
    const P = this.P;
    for (const e of this.eyes) {
      const S = e.sg > 0 ? 'Left' : 'Right';
      const yaw = Math.atan2(tx - e.sg * E.x, focus);
      const pitch = Math.atan2(ty, focus);
      e.ball.rotation.set(-pitch, yaw, 0);
      const blink = ch['eyeBlink' + S] || 0, sq = ch['eyeSquint' + S] || 0, wide = ch['eyeWide' + S] || 0;
      const chs = ch['cheekSquint' + S] || 0, sm = ch['mouthSmile' + S] || 0;
      const bd = ch['browDown' + S] || 0, bu = Math.max(ch.browInnerUp || 0, ch['browOuterUp' + S] || 0);
      const lower = P.lowerOpen + 13 * sq + 9 * chs + 3 * sm - 4 * wide + pitchDeg * 0.25;
      const open = P.upperOpen + 18 * wide - 7 * sq - 5 * bd + 3 * bu + pitchDeg * 0.65;
      const upper = Math.max(lower + 1.2, lerp(open, lower + 1.5, clamp(blink, 0, 1)));
      e.up.rotation.x = -upper * DEG;
      e.lo.rotation.x = -lower * DEG;
    }

    this._activeMorphs = [];
    for (const m of MORPH_LIST) {
      const w = ch[m.name] || 0;
      if (!m.jaw && w > 0.002) this._activeMorphs.push({ fn: m.fn, sg: m.sg, w });
    }
    this._updateBrows(ch);
    this._updateMouth(ch);
  }

  dispose() {
    this.object3D.removeFromParent();
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
  }
}
