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
import { hasDecals, drawDecals, resolveMakeup, DECAL_BOUNDS } from './skin-decals.js';
import { thinPlate } from './tps.js';

// ------------------------------------------------------------------ утилиты
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const G = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2) * 0.5);
const DEG = Math.PI / 180;

/** Catmull-Rom по 9 равномерным отсчётам y = 1, .75, ... -1 */
export function prof(arr, y) {
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

/**
 * Пресеты тона кожи (светлый → глубокий) с подходящим цветом губ. look: { skin: 'olive', undertone: 'warm' }.
 * Можно и просто цвет: { skin: '#c99a72' }.
 */
export const SKIN_TONES = {
  porcelain: { skin: '#f0ccb6', lip: '#c47a7e' },
  fair: { skin: '#eab9a0', lip: '#b9535b' },
  light: { skin: '#e3b08f', lip: '#b5626a' },
  medium: { skin: '#d9a487', lip: '#a8645c' },
  olive: { skin: '#c99a72', lip: '#a0605a' },
  tan: { skin: '#b07a55', lip: '#8f5048' },
  brown: { skin: '#8d5a3c', lip: '#74413a' },
  deep: { skin: '#5e3a28', lip: '#5a3029' },
};
/** Цвета радужки: [у зрачка, у края]. look: { iris: 'hazel' } или { iris: ['#…', '#…'], irisRight: 'blue' } (гетерохромия). */
export const EYE_COLORS = {
  dark: ['#3a2618', '#160d07'],
  brown: ['#5a3a22', '#2a1a0e'],
  amber: ['#9a6a24', '#4a2c0c'],
  hazel: ['#7a6a35', '#3f3a1c'],
  green: ['#5b7a3e', '#2f4a22'],
  gray: ['#8a96a0', '#4a545c'],
  blue: ['#6a8fb2', '#2e4966'],
  lightblue: ['#8fb6d9', '#4a6f94'],
};
/** Типы разреза глаз (параметры кромки век, см. _shapeLid; eyeTilt — наклон всего разреза). look: { eyeShape: 'round' }. */
export const EYE_SHAPES = {
  almond: { lidUpSkew: 0, lidUpFull: 0, lidLoSkew: 0, lidLoFull: 0 },
  round: { lidUpFull: 7, lidLoFull: 6, lidUpSkew: 0, lidLoSkew: 0 },
  upturned: { lidUpSkew: 2, lidLoSkew: -2, eyeTilt: 0.16 },
  downturned: { lidUpSkew: -5, lidLoSkew: 3, eyeTilt: -0.02 },
  narrow: { lidUpFull: -5, lidLoFull: -4, upperOpen: 19, lowerOpen: -18 },
  wide: { lidUpFull: 4, lidLoFull: 2, upperOpen: 30, lowerOpen: -26 },
  hooded: { hood: 0.8, lidCrease: 0.2, upperOpen: 22 },
  monolid: { hood: 0.55, lidCrease: 0, epicanthus: 0.85, upperOpen: 19, lowerOpen: -19, lidUpFull: -2, eyeTilt: 0.12 },
};
/** Профиль губ (4.5): look: { lipProfile: 'full' }. Свои lipPro/lipDepthU/lipDepthL/philtrum из look важнее. */
export const LIP_PROFILES = {
  flat: { lipPro: -0.6, lipDepthU: -0.3, lipDepthL: -0.4, philtrum: 0.3 },
  average: { lipPro: 0, lipDepthU: 0, lipDepthL: 0, philtrum: 0.5 },
  full: { lipPro: 0.7, lipDepthU: 0.6, lipDepthL: 0.6, philtrum: 0.7 },
  protruding: { lipPro: 1.2, lipDepthU: 0.3, lipDepthL: 1, philtrum: 0.5 },
};
/** Формы носа (featureDz): look: { noseShape: 'roman' }. Свои noseBridge/noseHump/… из look важнее. */
export const NOSE_SHAPES = {
  straight: {},
  roman: { noseHump: 0.7, noseUp: -0.5, noseBridge: 1.05 },
  snub: { noseUp: 0.8, noseHump: -0.35, noseBridge: 0.85, noseBulb: 0.15 },
  button: { noseUp: 0.45, noseBulb: 0.45, noseBridge: 0.8, noseRoot: -0.3 },
  greek: { noseRoot: 1.2, noseHump: 0.1 },
  bulbous: { noseBulb: 1, noseFlare: 0.35, noseBridge: 1.1 },
  wide: { noseFlare: 0.7, noseBridge: 1.3, noseW: 0.085, noseRoot: -0.3 },
  narrow: { noseBridge: 0.72, noseFlare: -0.35, noseW: 0.06 },
};
/**
 * Причёски на базе двух оболочек (short / long): объём по направлениям (hairVol, 0…100° от макушки), толщина,
 * кудри (шум), залысины, хвост или пучок. look: { hairStyle: 'afro' }. Свои параметры из look важнее пресета.
 */
export const HAIR_STYLES = {
  short: { hairStyle: 'short' },
  long: { hairStyle: 'long' },
  none: { hairStyle: 'none' },
  bob: { hairStyle: 'long', hairBottom: -0.9, hairVol: [0.07, 0.08, 0.09, 0.1, 0.12, 0.14], bangDepth: 0.16, bangSide: 0 },
  pixie: { hairStyle: 'short', hairVol: [0.06, 0.06, 0.05, 0.04, 0.03, 0.02], bangSide: -1, bangDepth: 0.14 },
  buzz: { hairStyle: 'short', hairThick: 0.3, hairScalp: 0.5, hairVol: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01] },
  undercut: { hairStyle: 'short', hairVol: [0.16, 0.15, 0.11, 0.03, 0.012, 0.01], hairVolMax: 0.2 },
  receding: { hairStyle: 'short', hairTemples: 0.2, hairline: 0.08, hairVol: [0.03, 0.03, 0.025, 0.02, 0.02, 0.02] },
  afro: { hairStyle: 'short', hairVol: [0.36, 0.36, 0.34, 0.31, 0.26, 0.17], hairVolMax: 0.4, hairCurl: 0.045 },
  curly: { hairStyle: 'long', hairVol: [0.14, 0.15, 0.16, 0.18, 0.2, 0.22], hairCurl: 0.04, hairBottom: -1.15 },
  ponytail: { hairStyle: 'short', hairVol: [0.02, 0.02, 0.02, 0.02, 0.015, 0.012], hairTail: 'ponytail' },
  bun: { hairStyle: 'short', hairVol: [0.02, 0.02, 0.02, 0.02, 0.015, 0.012], hairTail: 'bun' },
};
/** Головные уборы: look.hat = 'beanie' | 'cap' | 'fedora' | 'headband' | { style, color }. Волосы под ним приминаются. */
export const HATS = {
  beanie: { style: 'beanie', color: '#3a4a5a' },
  cap: { style: 'cap', color: '#24324a' },
  fedora: { style: 'fedora', color: '#4a3a2c' },
  bowler: { style: 'bowler', color: '#1e1c1c' },
  cloche: { style: 'cloche', color: '#b8a488' },
  headband: { style: 'headband', color: '#b03a48' },
};
/** Серьги: look.earrings = 'stud' | 'hoop' | 'drop' | { style, color, size }. */
export const EARRINGS = {
  stud: { style: 'stud', color: '#e6c36a', size: 1 },
  hoop: { style: 'hoop', color: '#d9b45a', size: 1 },
  drop: { style: 'drop', color: '#e8e8f0', size: 1 },
};
/** Борода и усы: look.beard = 'full' | 'goatee' | 'chinstrap' | 'moustache' | 'walrus' | 'pencil' | { style, moustache, length, color }. */
export const BEARDS = {
  full: { style: 'full', moustache: 'regular', length: 0.45 },
  short: { style: 'full', moustache: 'regular', length: 0.15 },
  goatee: { style: 'goatee', moustache: 'regular', length: 0.3 },
  chinstrap: { style: 'chinstrap', moustache: false, length: 0.35 },
  moustache: { style: 'none', moustache: 'regular', length: 0.3 },
  walrus: { style: 'none', moustache: 'walrus', length: 0.6 },
  pencil: { style: 'none', moustache: 'pencil', length: 0.1 },
};
/** Очки: look.glasses = 'round' | 'rect' | 'cat' | 'aviator' | 'sun' | true | false | { style, color, tint, size, aspect, thickness, metal, dy }. */
export const GLASSES = {
  round: { style: 'round', color: '#b59a62', metal: true, thickness: 0.0045, size: 1.42, aspect: 1.05 },
  rect: { style: 'rect', color: '#1c1a1a', thickness: 0.009, size: 1.55, aspect: 1.35 },
  cat: { style: 'cat', color: '#2a1416', thickness: 0.009, size: 1.6, aspect: 1.4 },
  aviator: { style: 'aviator', color: '#a8a8a8', metal: true, thickness: 0.005, size: 1.65, aspect: 1.15 },
  sun: { style: 'aviator', color: '#3a3a3a', metal: true, thickness: 0.006, size: 1.7, aspect: 1.15, tint: '#1a1f24' },
};
const UNDERTONE = { warm: [1.02, 1.0, 0.93], cool: [1.0, 0.97, 1.02], olive: [0.98, 1.0, 0.92], neutral: [1, 1, 1] };

/** Имена пресетов в look → цвета. Неизвестные ключи проходят как есть. */
export function resolveLook(look = {}) {
  // разрез — первым: пресет задаёт lid*/eyeTilt/upperOpen, явные значения из look важнее
  // пресеты разреза и причёски — первыми: явные значения из look важнее (иначе строки вроде skin: 'brown' затрут готовый цвет)
  const hs = typeof look.hairStyle === 'string' && HAIR_STYLES[look.hairStyle];
  const o = { ...(typeof look.eyeShape === 'string' && EYE_SHAPES[look.eyeShape] || {}), ...(typeof look.noseShape === 'string' && NOSE_SHAPES[look.noseShape] || {}), ...(typeof look.lipProfile === 'string' && LIP_PROFILES[look.lipProfile] || {}), ...(hs || {}), ...look };
  if (hs) o.hairStyle = hs.hairStyle;
  if (typeof o.skin === 'string' && SKIN_TONES[o.skin]) {
    const t = SKIN_TONES[o.skin];
    o.skin = t.skin;
    if (look.lip === undefined) o.lip = t.lip;
  }
  if (o.undertone && UNDERTONE[o.undertone] && o.skin) {
    const c = new THREE.Color(o.skin), k = UNDERTONE[o.undertone];
    o.skin = '#' + c.setRGB(clamp(c.r * k[0], 0, 1), clamp(c.g * k[1], 0, 1), clamp(c.b * k[2], 0, 1)).getHexString();
  }
  if (typeof o.hat === 'string') o.hat = HATS[o.hat] ? { ...HATS[o.hat] } : null;
  if (typeof o.earrings === 'string') o.earrings = EARRINGS[o.earrings] ? { ...EARRINGS[o.earrings] } : null;
  if (typeof o.headphones === 'string') o.headphones = HEADPHONES[o.headphones] ? { ...HEADPHONES[o.headphones] } : null;
  if (typeof o.mask === 'string') o.mask = MASKS[o.mask] ? { ...MASKS[o.mask] } : null;
  if (typeof o.beard === 'string') o.beard = BEARDS[o.beard] ? { ...BEARDS[o.beard] } : null;
  const mk = resolveMakeup(o.makeup);
  if (mk?.lipstick && look.lip === undefined) o.lip = mk.lipstick;
  if (typeof o.glasses === 'string') o.glasses = GLASSES[o.glasses] ? { ...GLASSES[o.glasses] } : { style: o.glasses };
  else if (o.glasses === true) o.glasses = { ...GLASSES.rect };
  for (const key of ['iris', 'irisRight']) if (typeof o[key] === 'string') o[key] = EYE_COLORS[o[key]] || [o[key], new THREE.Color(o[key]).multiplyScalar(0.45).getStyle()];
  return o;
}

/**
 * Профиль толщины верхней губы по ширине рта (t = -1..1 от уголка до уголка, без учёта мимики):
 * «лук Купидона» — ямка в центре (bowDip) и два пика на ±bowX (bowPeak).
 */
export function upperLipProfile(t, P) {
  const at = Math.abs(t), bx = P.bowX ?? 0.2, dip = P.bowDip ?? 0.2, peak = P.bowPeak ?? 0.12;
  const bow = 1 - dip * Math.exp(-((t / (bx * 0.45)) ** 2)) + peak * Math.exp(-(((at - bx) / (bx * 0.5)) ** 2));
  return Math.pow(Math.max(0, 1 - at ** 2.4), 0.55) * bow;
}

const HAT_LINE = { beanie: 0.4, cap: 0.48, fedora: 0.5, bowler: 0.44, cloche: 0.34, headband: 0.42 };   // нижний край убора (y)

/**
 * Уровни детализации геометрии. high — как было (ПК, ~200 тыс. треугольников); medium — телефоны (~95 тыс.);
 * low — слабые устройства (~55 тыс.). Сетки кожи и волос — основная нагрузка: у кожи 25 морф-целей на вершину
 * (на low — 19, см. MORPH_LIST_LITE, и слабые веса < 0.015 отбрасываются: меньше выборок морф-текстуры).
 */
export const DETAIL = {
  high: { skin: [240, 200], hair: [220, 160], eye: [48, 32], lid: 56, teeth: [12, 10], cards: 1, beard: 1, acc: 1, shadowMap: 1024 },
  medium: { skin: [168, 136], hair: [120, 88], eye: [32, 22], lid: 40, teeth: [10, 8], cards: 0.65, beard: 0.7, acc: 0.65, shadowMap: 1024 },
  low: { skin: [128, 104], hair: [88, 64], eye: [24, 16], lid: 32, teeth: [8, 6], cards: 0.4, beard: 0.5, acc: 0.4, shadowMap: 0, morphs: 'lite' },
};
/** 'auto' → medium на телефонах и планшетах (грубый указатель или мобильный UA), иначе high. */
export function resolveDetail(d) {
  if (DETAIL[d]) return d;
  if (typeof navigator === 'undefined') return 'high';
  const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);
  return mobile ? 'medium' : 'high';
}

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
  // форма носа (4.4): ширина спинки, горбинка, глубина переносицы, вздёрнутость, «картошка», крылья (см. NOSE_SHAPES)
  const br = P.noseBridge ?? 1, hump = P.noseHump || 0, root = P.noseRoot || 0, up = P.noseUp || 0, bulb = P.noseBulb || 0, flare = P.noseFlare || 0;
  const ny = smoothstep(0.2, -0.23, yn);                             // спинка носа растёт к кончику
  const below = yn < -0.26 + 0.012 * up ? Math.exp(-(((yn + 0.26 - 0.012 * up) / 0.03) ** 2)) : 1;
  const nsx = (0.036 + 0.03 * smoothstep(0.1, -0.26, yn)) * lerp(br, nw, smoothstep(0.05, -0.2, yn));
  const ridge = Math.exp(-(x * x) / (2 * nsx * nsx));
  dz += P.nose * ny * below * ridge;
  dz += P.nose * hump * 0.32 * ridge * Math.exp(-(((yn + 0.07) / 0.055) ** 2));   // горбинка (< 0 — вогнутая спинка)
  dz += 0.025 * (1 + root) * G(ax, yn, 0, 0.12, 0.05 * br, 0.08);   // переносица (root > 0 — «греческий» профиль без ямки)
  const tipY = -0.21 + 0.018 * up;
  dz += 0.035 * (1 + 0.9 * bulb) * G(x, yn, 0, tipY, 0.05 * nw * (1 + 0.35 * bulb), 0.05 * (1 + 0.25 * bulb));   // кончик носа
  dz -= 0.03 * Math.max(0, up) * G(x, yn, 0, -0.262, 0.045 * nw, 0.022);           // вздёрнутый: колумелла уходит вверх
  dz += 0.042 * (1 + 0.6 * flare) * G(ax, yn, 0.07 * nw * (1 + 0.15 * flare), -0.245, 0.032 * nw * (1 + 0.2 * flare), 0.028);   // крылья носа
  // губы в 3D (4.5): выступ губ вперёд (lipPro), впадина над верхней губой (lipDepthU), ямка под нижней (lipDepthL),
  // фильтрум — желобок с валиками от носа к «луку Купидона» (philtrum, 0…1)
  const pro = P.lipPro || 0, dU = P.lipDepthU || 0, dL = P.lipDepthL || 0, ph = P.philtrum || 0;
  dz += 0.05 * (1 + 0.6 * pro) * G(x, y, 0, -0.5, 0.2, 0.14);       // зона рта
  if (pro) dz += 0.028 * pro * G(x, y, 0, -0.53, 0.19, 0.07);        // сами губы
  if (dU) dz -= 0.014 * dU * G(x, y, 0, -0.39, 0.11, 0.045);
  if (ph) dz += ph * (0.005 * G(ax, y, 0.03, -0.385, 0.012, 0.055) - 0.004 * G(x, y, 0, -0.385, 0.014, 0.055));
  dz -= 0.02 * (1 + dL) * G(x, y, 0, -0.635, 0.12, 0.025);          // ямка под губой
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
    // носогубная складка: бороздка по отрезку крыло носа (0.1, −0.27) → мимо уголка рта (0.27, −0.56), щека над ней выпирает
    const ax = sg * x, px = ax - 0.1, py = y + 0.27, t = Math.min(1, Math.max(0, (px * 0.17 + py * -0.29) / (0.17 * 0.17 + 0.29 * 0.29)));
    const dx = px - 0.17 * t, dy = py + 0.29 * t, dl = Math.hypot(dx, dy), side = dx * 0.29 + dy * 0.17;   // > 0 — со стороны щеки
    const fold = Math.exp(-((dl / 0.016) ** 2)) * Math.sin(Math.PI * Math.min(1, t * 1.15)), bulge = side > 0 ? Math.exp(-(((dl - 0.03) / 0.03) ** 2)) * Math.sin(Math.PI * t) : 0;
    o[0] = sg * 0.015 * g1; o[1] = 0.035 * g1 + 0.015 * g2; o[2] = 0.03 * g1 + 0.01 * g2 - 0.022 * fold + 0.016 * bulge; return o;
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
/**
 * Урезанный набор для detail: 'low' — 19 целей вместо 25. jawLeft/jawRight — одна цель jawSide со знаковым весом
 * (точно); воронка губ, ямочки и растяжка рта сворачиваются в соседние цели (приближённо, см. foldLite).
 */
const LITE_DROP = new Set(['jawLeft', 'jawRight', 'mouthFunnel', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight']);
const MORPH_LIST_LITE = [{ name: 'jawSide', fn: MORPHS.jawLeft, sg: 1, jaw: true }, ...MORPH_LIST.filter((m) => !LITE_DROP.has(m.name))];
const LITE_MIN = 0.015;
/** Каналы → веса урезанного набора (out переиспользуется). Слабые веса — в ноль: цель не читается шейдером. */
function foldLite(ch, out) {
  const g = (k) => ch[k] || 0;
  for (const m of MORPH_LIST_LITE) out[m.name] = g(m.name);
  out.jawSide = g('jawLeft') - g('jawRight');
  out.mouthPucker = Math.min(1, out.mouthPucker + 0.57 * g('mouthFunnel'));
  for (const S of ['Left', 'Right']) {
    out['mouthSmile' + S] = Math.min(1, out['mouthSmile' + S] + 0.3 * g('mouthDimple' + S));
    out['mouthFrown' + S] = Math.min(1, out['mouthFrown' + S] + 0.6 * g('mouthStretch' + S));
  }
  for (const k in out) if (Math.abs(out[k]) < LITE_MIN) out[k] = 0;
  return out;
}

// ------------------------------------------------------------------ текстуры (canvas, без файлов)

function eyeTexture(P) {
  const W = 512, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
  const ci = new THREE.Color(P.iris[0]), co = new THREE.Color(P.iris[1]);
  const pupil = P.pupil ?? 0.155, iris = IRIS_A, limbus = 0.6;          // роговица увеличивает радужку и зрачок примерно в 1.2 раза
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

const CORNEA_A = 0.6;                          // угловой радиус роговицы (= лимб в eyeTexture), рад
const CORNEA_H = 0.06;                         // выпуклость роговицы над сферой яблока, доля радиуса

/**
 * Глазное яблоко с роговицей: в пределах лимба сфера выпячивается (блик едет как по настоящей роговице),
 * а радужка в шейдере — плоский диск на глубине лимба: луч взгляда преломляется на роговице (n = 1.376)
 * и находит точку радужки. Отсюда параллакс при взгляде сбоку и «линза» над радужкой без лишнего прохода рендера.
 * Нормали — аналитические (у полюса сферы швы и вырожденные треугольники).
 */
function eyeballGeometry(R, ws = 48, hs = 32) {
  const geo = new THREE.SphereGeometry(R, ws, hs);
  geo.rotateX(Math.PI / 2);                                         // полюс (зрачок) → +Z
  const p = geo.attributes.position, n = geo.attributes.normal, A = CORNEA_A, H = CORNEA_H;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.acos(clamp(z / R, -1, 1));
    if (a >= A) continue;
    const u = 1 - (a / A) ** 2, f = u * u, df = (-4 * a * u) / (A * A), rr = 1 + H * f;
    const rxy = Math.hypot(x, y), cx = rxy > 1e-9 ? x / rxy : 1, cy = rxy > 1e-9 ? y / rxy : 0;
    const sa = Math.sin(a), ca = Math.cos(a), k = (H * df) / rr;    // n ∝ r̂ − (r'/r)·â
    const nx = sa * cx - k * ca * cx, ny = sa * cy - k * ca * cy, nz = ca + k * sa, nl = Math.hypot(nx, ny, nz);
    p.setXYZ(i, x * rr, y * rr, z * rr);
    n.setXYZ(i, nx / nl, ny / nl, nz / nl);
  }
  return geo;
}

const IRIS_A = 0.53;                           // угловой радиус радужки в eyeTexture

/**
 * Преломление в роговице для материала глаза (см. eyeballGeometry) и динамика зрачка (2.8): uPupil — масштаб
 * зрачка, радужка между зрачком и краем сжимается/растягивается, как настоящая (узор не «наезжает» на лимб).
 * U — { value: 1 } роговица вкл. (0 — кадры для измерений; без роговицы — всегда 0), pupilU — { value: 1 }.
 */
function corneaShader(mat, R, U, pupilU, pupil0) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uEyeR = { value: R };
    sh.uniforms.uCornea = U;
    sh.uniforms.uPupil = pupilU;
    // uCornea = 0: яблоко без выпуклости (кадры для измерений) — вершины обратно на сферу радиуса R
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uEyeR;\nuniform float uCornea;\nvarying vec3 vEyeP;\nvarying vec3 vEyeN;\nvarying vec3 vEyeCam;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tif ( uCornea < 0.5 ) objectNormal = normalize( position );')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tif ( uCornea < 0.5 ) transformed = position * ( uEyeR / length( position ) );\n\tvEyeP = position; vEyeN = normal; vEyeCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uEyeR;
uniform float uCornea;
uniform float uPupil;
varying vec3 vEyeP;
varying vec3 vEyeN;
varying vec3 vEyeCam;
// угол от центра зрачка на «шкале» с нарисованным зрачком: зрачок масштабируется, радужка ужимается между ним и краем
float pupilRemap( float a ) {
	float p = ${pupil0.toFixed(4)}, ir = ${IRIS_A.toFixed(3)}, p2 = min( p * uPupil, 0.42 );
	if ( a < p2 ) return a * p / p2;
	if ( a < ir ) return p + ( a - p2 ) * ( ir - p ) / ( ir - p2 );
	return a;
}`).replace('#include <map_fragment>', `
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	float eyeA = acos( clamp( vEyeP.z / length( vEyeP ), -1.0, 1.0 ) );
	if ( eyeA < ${IRIS_A.toFixed(3)} && abs( uPupil - 1.0 ) > 1e-3 )
		sampledDiffuseColor = textureGrad( map, vec2( vMapUv.x, 1.0 - pupilRemap( eyeA ) / 3.1415927 ), dFdx( vMapUv ), dFdy( vMapUv ) );
	if ( eyeA < ${CORNEA_A.toFixed(3)} && uCornea > 0.5 ) {
		vec3 rd = refract( normalize( vEyeP - vEyeCam ), normalize( vEyeN ), ${(1 / 1.376).toFixed(4)} );
		if ( rd.z < -1e-3 ) {
			vec3 q = vEyeP + rd * ( ( uEyeR * ${Math.cos(CORNEA_A).toFixed(4)} - vEyeP.z ) / rd.z );   // плоскость радужки
			float th = pupilRemap( asin( clamp( length( q.xy ) / uEyeR, 0.0, 1.0 ) ) );
			float ph = atan( -q.y, -q.x );
			if ( ph < 0.0 ) ph += 6.2831853;
			vec4 ir = textureGrad( map, vec2( ph / 6.2831853, 1.0 - th / 3.1415927 ), dFdx( vMapUv ), dFdy( vMapUv ) );
			sampledDiffuseColor = mix( ir, sampledDiffuseColor, smoothstep( ${(CORNEA_A - 0.05).toFixed(3)}, ${CORNEA_A.toFixed(3)}, eyeA ) );
		}
	}
	diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  mat.customProgramCacheKey = () => 'eye-cornea-' + pupil0;   // pupil0 вшит в шейдер
  mat.needsUpdate = true;
}

/**
 * Зубная дуга: отдельные зубы-суперэллипсоиды (резцы, клыки, премоляры, моляр) на параболе + дёсны.
 * Координаты головы; верхняя дуга неподвижна, нижняя вращается вместе с челюстью (см. _updateMouth).
 * @returns {{teeth: THREE.BufferGeometry, gums: THREE.BufferGeometry}}
 */
function buildDentition(P, zFront, upper, seg = [12, 10]) {
  const MY = LAYOUT.mouthY, sc = (P.mouthHW / 0.185) * 0.92;
  const a = 1.25;                                                  // глубина дуги: z = zFront - a·x²
  const arch = (x) => zFront - a * x * x;
  //            центр. резец, боковой, клык, премоляр 1, 2, моляр
  const W = (upper ? [0.05, 0.04, 0.044, 0.042, 0.042, 0.052] : [0.035, 0.037, 0.042, 0.042, 0.044, 0.052]).map((v) => v * sc);
  const H = (upper ? [0.064, 0.055, 0.064, 0.05, 0.046, 0.042] : [0.05, 0.05, 0.057, 0.046, 0.043, 0.04]).map((v) => v * sc);
  const T = [0.032, 0.032, 0.04, 0.046, 0.048, 0.056].map((v) => v * sc);
  const AO = [1, 0.93, 0.82, 0.66, 0.52, 0.42];                     // задние зубы в тени полости
  const yEdge0 = upper ? MY - 0.026 : MY - 0.017;
  const unit = new THREE.SphereGeometry(1, seg[0], seg[1]), up = unit.attributes.position, un = up.count, uidx = unit.index.array;
  const pos = [], col = [], idx = [], gum = [], brk = [];
  // опции зубов (3.9): щель между верхними резцами, кривизна (детерминированный разброс поворотов и сдвигов)
  const gap = upper ? clamp(P.teethGap ?? 0, 0, 1) * 0.014 * sc : 0, crook = clamp(P.teethCrooked ?? 0, 0, 1);
  const hash = (i, sg, k) => { const v = Math.sin((i + 1) * 12.9898 + sg * 78.233 + k * 37.719 + (upper ? 0 : 5.1)) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
  for (const sg of [1, -1]) {
    let s = 0.0004 * sc + gap / 2;                                 // длина дуги от центра
    for (let i = 0; i < 6; i++) {
      const w = W[i], h = H[i], t = T[i];
      // центр зуба по длине дуги → x (приближённо, дуга пологая)
      let x = s + w / 2;
      for (let k = 0; k < 3; k++) x = (s + w / 2) / Math.sqrt(1 + (2 * a * x) ** 2 * 0.5);
      s += w + 0.0006 * sc;
      x *= sg;
      const ang = Math.atan(2 * a * x);                            // поворот вокруг Y по касательной к дуге
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const yEdge = yEdge0 + (upper ? 1 : -1) * 0.0035 * i * i * 0.5;   // режущий край поднимается к задним зубам
      const base = pos.length / 3, tint = 1 + (((i * 7 + (sg > 0 ? 3 : 0)) % 5) - 2) * 0.012;   // зубы чуть различаются по тону
      // кривизна: передние зубы сильнее — поворот вокруг оси зуба, наклон, сдвиг вперёд/назад
      const cw = crook * (i < 3 ? 1 : 0.35), rY = cw * 0.5 * hash(i, sg, 1), rZ = cw * 0.1 * hash(i, sg, 2), dz = cw * 0.006 * sc * hash(i, sg, 3);
      const cY = Math.cos(rY), sY = Math.sin(rY), cZ = Math.cos(rZ), sZ = Math.sin(rZ), yMid = upper ? yEdge + h / 2 : yEdge - h / 2;
      const place = (lx, ly, lz) => {
        if (cw) {
          const ox = lx, oz = lz + t / 2;                          // вокруг центра зуба
          lx = ox * cY + oz * sY; lz = -ox * sY + oz * cY - t / 2 + dz;
          const rx = lx, ry = ly - yMid;
          lx = rx * cZ - ry * sZ; ly = yMid + rx * sZ + ry * cZ;
        }
        return [x + lx * ca + lz * sa, ly, arch(x) - lx * sa + lz * ca];   // lx — по касательной к дуге, lz — по нормали
      };
      for (let v = 0; v < un; v++) {
        const nx = up.getX(v), ny = up.getY(v), nz = up.getZ(v);
        const ex = Math.sign(nx) * Math.abs(nx) ** 0.45, ey = Math.sign(ny) * Math.abs(ny) ** 0.6, ez = Math.sign(nz) * Math.abs(nz) ** 0.5;
        const vv = (ey + 1) / 2;                                   // 0 — низ, 1 — верх
        const e = upper ? 1 - vv : vv;                             // 1 — режущий край, 0 — шейка у десны
        const wf = lerp(0.86, 1, smoothstep(0, 0.4, e));
        const tf = i < 2 ? lerp(1, 0.32, e ** 1.4) : i === 2 ? lerp(1, 0.55, e) : lerp(1, 0.85, e);
        let lx = ex * (w / 2) * wf;
        let ly = (upper ? yEdge + vv * h : yEdge - (1 - vv) * h);
        if (i === 2) ly += (upper ? -1 : 1) * 0.006 * sc * Math.max(0, 1 - Math.abs(ex)) ** 1.6 * e ** 3;   // клык чуть заострён
        let lz = ez * (t / 2) * tf - t / 2;
        if (ez > 0) lz += 0.004 * sc * (1 - ex * ex);              // выпуклая губная поверхность
        pos.push(...place(lx, ly, lz));
        const ao = AO[i] * lerp(0.72, 1, smoothstep(0, 0.6, e)) * (upper ? 1 : 0.9);
        const trans = smoothstep(0.82, 1, e) * (i < 3 ? 1 : 0.3);  // полупрозрачный режущий край: холоднее
        col.push(ao * tint * (1 - 0.1 * trans), ao * tint * (1 - 0.06 * trans), ao * tint * (1 + 0.02 * trans) * 0.98);
      }
      for (let k = 0; k < uidx.length; k++) idx.push(base + uidx[k]);
      gum.push({ x, w, h, yEdge });
      if (P.braces && i < 5) {
        // брекет — по центру губной поверхности (e = 0.55 от шейки)
        const e = 0.55, tf = i < 2 ? lerp(1, 0.32, e ** 1.4) : i === 2 ? lerp(1, 0.55, e) : lerp(1, 0.85, e);
        const ly = upper ? yEdge + (1 - e) * h : yEdge - (1 - e) * h, lz = (t / 2) * tf - t / 2 + 0.004 * sc;
        brk.push({ c: place(0, ly, lz + 0.0022 * sc), f: place(0, ly, lz + 0.0045 * sc), ang: ang - (cw ? rY : 0), sg, x });
      }
    }
  }
  unit.dispose();
  const teeth = new THREE.BufferGeometry();
  teeth.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  teeth.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  teeth.setIndex(idx);
  teeth.computeVertexNormals();

  // дёсны: полоса над (под) зубами с фестонами — у межзубных промежутков десна опускается к зубам
  const xs = gum.map((g) => g.x).sort((p, q) => p - q), xMax = Math.max(...xs.map(Math.abs)) + 0.03 * sc;
  const line = (x) => {
    let best = null;
    for (const g of gum) { const d = Math.abs(x - g.x) / (g.w / 2); if (!best || d < best.d) best = { d, g }; }
    const g = best.g, pap = smoothstep(0.55, 1.05, best.d);       // межзубный сосочек
    return upper ? g.yEdge + g.h * lerp(0.84, 0.62, pap) : g.yEdge - g.h * lerp(0.84, 0.62, pap);
  };
  const cols = 72, rows = 4, gpos = [], gcol = [], gidx = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const x = lerp(-xMax, xMax, c / cols), s = r / rows, y0 = line(x);
    const y = upper ? y0 + s * 0.06 : y0 - s * 0.06;
    const bulge = 0.006 * Math.sin(Math.PI * Math.min(1, s * 1.6));
    gpos.push(x, y, arch(x) + 0.003 + bulge - 0.004 * (1 - s));
    const ao = lerp(1, 0.45, smoothstep(0.05, 0.22, Math.abs(x))) * lerp(0.85, 1, s);
    gcol.push(ao, ao, ao);
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = r * (cols + 1) + c, q = p + 1, d = p + cols + 1, e = d + 1;
    if (upper) gidx.push(p, q, d, q, e, d); else gidx.push(p, d, q, q, d, e);
  }
  const gums = new THREE.BufferGeometry();
  gums.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3));
  gums.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
  gums.setIndex(gidx);
  gums.computeVertexNormals();
  let braces = null;
  if (brk.length) {
    const parts = [];
    for (const b of brk) {
      const bx = new THREE.BoxGeometry(0.011 * sc, 0.0095 * sc, 0.0044 * sc);
      bx.rotateY(-b.ang); bx.translate(...b.c);
      parts.push(bx);
    }
    // дуга: через лицевые стороны брекетов, от правого к левому
    const pts = brk.slice().sort((p, q) => p.x - q.x).map((b) => new THREE.Vector3(...b.f));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 6, 0.0011 * sc, 5, false));
    braces = mergeGeos(parts);
  }
  return { teeth, gums, braces };
}

/** Склейка геометрий (позиции + нормали + индексы) в одну — меньше draw calls. */
function mergeGeos(list) {
  const pos = [], nor = [], idx = [];
  for (const g of list) {
    const base = pos.length / 3, p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
    if (g.index) for (const v of g.index.array) idx.push(base + v); else for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/** Материал «не рисовать» для исходных мешей после склейки (6.2): узел остаётся костью, дети рисуются как раньше. */
const HIDDEN_MAT = new THREE.MeshBasicMaterial({ visible: false });
/** Наушники (5.12): look.headphones — имя или { style, color }. */
export const HEADPHONES = {
  over: { style: 'over', color: '#26282c' }, headset: { style: 'headset', color: '#2c2f35' }, earbuds: { style: 'earbuds', color: '#f2f2f0' },
};
/** Маска (5.12): look.mask — имя или { style, color }. Рот под маской скрыт, ткань едет за челюстью. */
export const MASKS = {
  medical: { style: 'medical', color: '#bcd8ea' }, cloth: { style: 'cloth', color: '#30343c' }, n95: { style: 'n95', color: '#f0efea' },
};
/** Одежда (5.11): look.outfit; cloth — основной цвет, cloth2 — рубашка под пиджаком / шнурки худи, tie — галстук (цвет или false). */
export const OUTFITS = {
  crew: {}, vneck: {}, scoop: {}, turtleneck: {}, shirt: {}, hoodie: { cloth2: '#eeeeee' }, blazer: { cloth2: '#e9e7e2', tie: true },
};
/** Цвет зубов: look.teethColor — имя пресета или цвет. */
export const TEETH_COLORS = { white: '#f7f5f0', natural: '#efe8da', ivory: '#ece0c4', yellow: '#e6d8b0', gray: '#d4d0c6' };
/** Брекеты: look.braces — true / 'metal' / 'ceramic' / цвет. */
function bracesMaterial(b) {
  const ceramic = b === 'ceramic', col = typeof b === 'string' && b !== 'metal' && !ceramic ? b : ceramic ? '#ebe6dc' : '#c9cdd2';
  return new THREE.MeshPhysicalMaterial({ color: col, metalness: ceramic || col !== '#c9cdd2' ? 0 : 0.9, roughness: ceramic ? 0.35 : 0.28, clearcoat: ceramic ? 0.6 : 0, envMapIntensity: 0.9 });
}

/** Normal-карта губ: вертикальные бороздки (сетка губ: u — по ширине рта, v — от внутренней кромки к внешней). */
function lipNormalTexture() {
  const W = 512, H = 64, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
  const rnd = []; for (let i = 0; i < W; i++) rnd.push(Math.sin(i * 12.9898) * 43758.5453 % 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ph = x / W * 140 + 0.9 * Math.sin(x * 0.07) + rnd[x] * 0.3;
    const fade = Math.sin(Math.PI * Math.min(1, (y + 4) / (H + 4)));         // к кромкам бороздки мельче
    const nx = Math.sin(ph * Math.PI * 2) * 0.55 * fade;
    const k = (y * W + x) * 4;
    d[k] = (nx * 0.5 + 0.5) * 255; d[k + 1] = 128; d[k + 2] = 255; d[k + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/**
 * Окраска прядей (1.5): седина, мелирование, разброс оттенков. P → { base, gray, grayCol, streak, streakCol, vari }.
 * hairGray — доля седых волосков (1 — полностью седые), hairGrayColor; hairStreaks — доля прядей мелирования
 * (пучками), hairStreakColor; hairVar — разброс яркости волосков (1 — по умолчанию, 0.3 — ровный цвет).
 */
export function hairTone(P, color = P.hair, gray = P.hairGray) {
  const base = new THREE.Color(color);
  return {
    base, gray: clamp(gray ?? 0, 0, 1), grayCol: new THREE.Color(P.hairGrayColor || '#c4c2bc'),
    streak: clamp(P.hairStreaks ?? 0, 0, 1), streakCol: new THREE.Color(P.hairStreakColor || '#' + base.clone().lerp(new THREE.Color('#d9c49c'), 0.55).getHexString()),
    vari: clamp(P.hairVar ?? 1, 0, 2),
  };
}
/** Средний видимый цвет волос (для sheen и подложки). */
function hairMean(T) {
  return T.base.clone().lerp(T.streakCol, T.streak * 0.6).lerp(T.grayCol, T.gray);
}
/** Цвет одного волоска: u — случайное 0..1 для выбора седого, inStreak — попал ли в пучок мелирования, l — яркость. */
function strandColor(T, u, inStreak, l) {
  const c = u < T.gray ? T.grayCol.clone() : inStreak ? T.streakCol.clone() : T.base.clone();
  return c.multiplyScalar(l);
}
const rgbOf = (c) => `${Math.min(255, c.r * 255) | 0},${Math.min(255, c.g * 255) | 0},${Math.min(255, c.b * 255) | 0}`;

function hairTexture(T) {
  const W = 256, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const mean = hairMean(T);
  // подложка — между волосками: тот же цвет, что в среднем дают волоски (седина «соль с перцем» — смесь, а не серый слой)
  ctx.fillStyle = '#' + T.base.clone().lerp(mean, 0.7).getHexString(); ctx.fillRect(0, 0, W, H);
  // пучки мелирования: центры по ширине текстуры (она повторяется 4 раза по кругу головы)
  const nS = T.streak > 0 ? Math.round(3 + 5 * T.streak) : 0, cs = Array.from({ length: nS }, (_, i) => (i + 0.3 + 0.4 * Math.random()) * W / nS);
  const wS = 2 + 6 * T.streak;
  const inStreak = (x) => T.streak > 0 && cs.some((cx) => Math.abs(((x - cx + W * 1.5) % W) - W / 2) < wS * (0.6 + 0.4 * Math.random()));
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * W, l = 1.05 + T.vari * (Math.random() - 0.5) * 0.9;
    const col = strandColor(T, T.gray > 0 ? Math.random() : 1, inStreak(x), l);   // лишних Math.random нет — без седины текстура та же, что раньше
    ctx.strokeStyle = `rgba(${rgbOf(col)},0.5)`;
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

/** Альфа-текстура пряди для карточек: тонкие волоски разной длины и яркости, прозрачный фон (детерминированно). */
function hairCardTexture(T) {
  const W = 128, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const sx = T.streak > 0 ? W * (0.25 + 0.5 * rnd()) : -W;             // пучок мелирования на карточке
  // 8.1: волосков больше и они тоньше, разброс яркости меньше, альфа мягче — пряди сливаются в массу, а не лежат пятнами
  for (let i = 0; i < 96; i++) {
    const x = W * (0.08 + 0.84 * rnd()), l = 0.975 + T.vari * (rnd() - 0.5) * 0.16, y0 = H * 0.12 * rnd(), end = H * (0.5 + 0.5 * rnd()), sway = (rnd() - 0.5) * 14;
    const col = strandColor(T, T.gray > 0 ? rnd() : 1, Math.abs(x - sx) < W * 0.25 * T.streak, l), a = 0.35 + 0.35 * rnd();
    const g = ctx.createLinearGradient(0, y0, 0, end);
    const rgb = rgbOf(col);
    g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(0.15, `rgba(${rgb},${a})`); g.addColorStop(0.7, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);   // у корня и к кончику — на нет
    ctx.strokeStyle = g; ctx.lineWidth = 0.6 + 0.8 * rnd();
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.bezierCurveTo(x + sway * 0.3, end * 0.35, x + sway, end * 0.7, x + sway * 1.3, end); ctx.stroke();
  }
  // края карточки растворяются (иначе видна прямоугольная лента)
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[(y * W + x) * 4 + 3] *= smoothstep(0, 0.18, Math.min(x, W - 1 - x) / W);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Раскачка волос в вершинном шейдере: transformed += uHairSwing · hairSw (атрибут; нет атрибута — 0). */
/**
 * Несколько вставок в шейдер одного материала (декали, рассеяние в коже…): складываются, а не перетирают друг друга.
 * Клон материала (Material.clone) вставки не наследует — их добавляют заново.
 */
function addShaderPatch(mat, key, fn, safe = false) {
  let L = mat.userData.patches;
  if (!Array.isArray(L) || L.some((p) => typeof p.fn !== 'function')) L = mat.userData.patches = [];
  const i = L.findIndex((p) => p.key === key);
  if (i >= 0) L[i] = { key, fn, safe }; else L.push({ key, fn, safe });   // safe — только освещение во фрагменте: склейке мешей не мешает
  mat.onBeforeCompile = (sh) => { for (const p of L) p.fn(sh); };
  mat.customProgramCacheKey = () => L.map((p) => p.key).join('|');
  mat.needsUpdate = true;
}

/**
 * Подповерхностное рассеяние кожи (8.2), приближённо: к обычному освещению добавляется «завёрнутый» за терминатор
 * свет (wrap), у красного канала шире — граница света и тени тёплая и мягкая, как у кожи, а не пластика. В тени
 * добавки нет: тень уже учтена в directLight.color. strength 0 — выкл.
 */
function skinScatter(strength) {
  return (sh) => {
    sh.uniforms.uSss = { value: strength };
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
uniform float uSss;
void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float nl = dot( geometryNormal, directLight.direction );
	vec3 wrapW = vec3( 0.6, 0.32, 0.22 );                                // красный «заходит» за терминатор дальше
	vec3 wrapped = max( vec3( 0.0 ), ( vec3( nl ) + wrapW ) / ( 1.0 + wrapW ) ) - max( nl, 0.0 );
	reflectedLight.directDiffuse += uSss * wrapped * directLight.color * BRDF_Lambert( material.diffuseColor );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Skin`);
  };
}

function hairSwayShader(mat, uniforms, key, spec2 = null) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHairSwing = uniforms.uHairSwing;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float hairSw;\nuniform vec3 uHairSwing;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += uHairSwing * hairSw;');
    if (!spec2) return;
    // второй блик (8.1, приближение Marschner TRT): касательная пряди сдвинута к нормали, блик окрашен цветом волос
    // и шире первого. Ключевой свет — постоянное направление в системе камеры (как у студийного света сцены).
    sh.uniforms.uHairSpec2 = { value: spec2.k };
    sh.uniforms.uHairShift = { value: spec2.shift };
    sh.uniforms.uHairExp = { value: spec2.exp };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uHairSpec2;\nuniform float uHairShift;\nuniform float uHairExp;')
      .replace('#include <opaque_fragment>', `
#ifdef USE_ANISOTROPY
	{
		vec3 hT = normalize( material.anisotropy${spec2.axis} ), hV = normalize( vViewPosition ), hL = normalize( vec3( -0.42, 0.55, 0.72 ) );
		vec3 hT2 = normalize( hT + uHairShift * normal ), hH = normalize( hL + hV );
		float th = dot( hT2, hH );
		float s2 = pow( sqrt( max( 0.0, 1.0 - th * th ) ), uHairExp ) * smoothstep( -0.05, 0.35, dot( normal, hL ) );
		vec3 tint = mix( diffuseColor.rgb, sqrt( diffuseColor.rgb ), 0.5 );   // окрашен цветом волос, но светлее (свет прошёл сквозь волос)
		outgoingLight += tint * s2 * uHairSpec2;
	}
#endif
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => key + (spec2 ? '-s2' + spec2.axis : '');
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
  constructor({ gender = 'female', shadows = true, overrides = {}, detail = 'high' } = {}) {
    this.gender = gender;
    this.detail = resolveDetail(detail);
    this.L = DETAIL[this.detail];
    this.shadows = shadows;
    this.P = { ...PRESETS[gender] || PRESETS.female, ...resolveLook(overrides) };
    this.object3D = new THREE.Group();
    this.object3D.name = 'ProceduralHead';
    this._disposables = [];
    this._v3 = [0, 0, 0];
    this._initWarp();
    this._build();
  }

  /**
   * Деформация по точкам лица (P.warp, см. Portrait.refineShape): смещение (dx, dy) в плоскости анфас, TPS по
   * опорным точкам. Сдвигается база кожи (и волос, ушей, бороды), морфы считаются уже от сдвинутой базы.
   * Черты с параметрами (глаза, брови, губы) — неподвижные якоря, поэтому параметрические части остаются на месте.
   *   P.warp = { pts: [[x, y, dx, dy], …], scale = 1, win: [cx, cy, rx, ry] }
   * Вне эллипса win поле берётся с его границы: силуэт, уши и волосы сдвигаются вместе с контуром лица.
   */
  _initWarp() {
    const W = this.P.warp;
    this._warpF = null;
    if (!W?.pts?.length || !(W.scale ?? 1)) return;
    const sc = W.scale ?? 1, S = [], D = [];
    for (const [x, y, dx, dy] of W.pts) { S.push({ x, y }); D.push({ x: dx * sc, y: dy * sc }); }
    const f = thinPlate(S, D, W.lambda ?? 3e-4), t = { x: 0, y: 0 }, [cx, cy, rx, ry] = W.win || [0, -0.2, 0.75, 0.78];
    this._warpF = (p) => {
      const w = smoothstep(-0.6, 0, p[2]);
      if (w <= 0) return p;
      const e = Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry), c = e > 1 ? 1 / e : 1;
      f(cx + (p[0] - cx) * c, cy + (p[1] - cy) * c, t);
      p[0] += t.x * w; p[1] += t.y * w;
      return p;
    };
  }

  _track(x) { this._disposables.push(x); return x; }

  _build() {
    const P = this.P;
    const root = this.object3D;

    // --- материалы
    this.mat = {
      skin: this._track(new THREE.MeshPhysicalMaterial({
        color: P.skin, roughness: 0.55, metalness: 0, vertexColors: true,
        sheen: P.skinScatter === false ? 0.45 : 0.3, sheenRoughness: 0.5, sheenColor: new THREE.Color(P.skin).multiplyScalar(1.25).lerp(new THREE.Color('#ff9a80'), 0.5),   // подповерхностный «тёплый» отсвет в тон кожи
        clearcoat: 0.06, clearcoatRoughness: 0.5, envMapIntensity: 0.6,
      })),
      lid: null,
      lip: this._track(new THREE.MeshPhysicalMaterial({ color: P.lip, roughness: 0.38, vertexColors: true, normalMap: this._track(lipNormalTexture()), normalScale: new THREE.Vector2(0.35, 0.35), clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.3, sheenColor: new THREE.Color('#ff8080'), side: THREE.DoubleSide, envMapIntensity: 0.6, depthTest: false })),
      brow: this._track(new THREE.MeshStandardMaterial({ color: new THREE.Color(P.brow.color).lerp(hairTone(P).grayCol, 0.5 * (P.browGray ?? P.hairGray ?? 0) ** 2), roughness: 0.9 })),   // брови седеют вслед за волосами, но слабее
      lash: this._track(new THREE.MeshStandardMaterial({ color: '#120c0a', roughness: 0.8 })),
      hair: this._track(new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: this._track(hairTexture(hairTone(P))), roughness: 0.45, anisotropy: P.hairAniso ?? 0.6, anisotropyRotation: P.hairAnisoRot ?? 0, sheen: 0.6, sheenColor: hairMean(hairTone(P)).multiplyScalar(2.2), sheenRoughness: 0.35, vertexColors: true, side: THREE.DoubleSide, envMapIntensity: 0.5 })),
      cloth: this._track(new THREE.MeshStandardMaterial({ color: P.cloth, roughness: 0.85 })),
      eye: this._track(new THREE.MeshPhysicalMaterial({ map: this._track(eyeTexture(P)), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.3 })),
      eyeR: null,
    };
    this.mat.eyeR = P.irisRight ? this._track(new THREE.MeshPhysicalMaterial({ map: this._track(eyeTexture({ ...P, iris: P.irisRight })), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.3 })) : this.mat.eye;
    if (P.hairScalp) {                                                // ёжик: сквозь короткие волосы просвечивает кожа
      const hc = new THREE.Color(P.hair), sc = new THREE.Color(P.skin), k = P.hairScalp;
      this.mat.hair.color.setRGB(lerp(1, sc.r / Math.max(0.03, hc.r), k * 0.35), lerp(1, sc.g / Math.max(0.03, hc.g), k * 0.35), lerp(1, sc.b / Math.max(0.03, hc.b), k * 0.35));
    }
    // пряди-карточки: блик как у оболочки, альфа по текстуре прядей (alpha-to-coverage — без сортировки прозрачности)
    this.mat.hairCards = this._track(new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: this._track(hairCardTexture(hairTone(P))), roughness: 0.72,   // без анизотропии: блики карточек под разными углами давали светлые пятна — блик волос даёт оболочка
       sheen: 0.3, sheenColor: hairMean(hairTone(P)).multiplyScalar(1.3), sheenRoughness: 0.5, vertexColors: true, alphaToCoverage: true, alphaTest: 0.02, side: THREE.DoubleSide, envMapIntensity: 0.22 }));
    this._hairU = { uHairSwing: { value: new THREE.Vector3() } };
    const S2 = P.hairSpec2 === false ? null : { k: P.hairSpec2 ?? 0.35, shift: 0.3, exp: 18, axis: P.hairSpec2Axis || 'T' };
    hairSwayShader(this.mat.hair, this._hairU, 'hair-sway', S2);
    hairSwayShader(this.mat.hairCards, this._hairU, 'hair-cards-sway', S2 && { ...S2, axis: P.hairSpec2AxisCards || 'T' });
    this.mat.lid = this._track(this.mat.skin.clone());
    this.mat.lid.vertexColors = true;
    this.mat.lid.side = THREE.DoubleSide;
    this.mat.lid.color = new THREE.Color(P.skin).multiply(new THREE.Color(...P.lidTint));
    const mk = resolveMakeup(P.makeup);
    if (mk?.eyeshadow) {                                           // тени на подвижном веке
      const [c, a] = Array.isArray(mk.eyeshadow) ? mk.eyeshadow : ['#8a6a7a', mk.eyeshadow];
      this.mat.lid.color.lerp(this.mat.lid.color.clone().multiply(new THREE.Color(c)), clamp(a * 1.1, 0, 1));
    }
    if (mk?.gloss !== undefined) { this.mat.lip.clearcoat = 0.2 + 0.7 * mk.gloss; this.mat.lip.clearcoatRoughness = 0.4 - 0.32 * mk.gloss; this.mat.lip.roughness = 0.42 - 0.2 * mk.gloss; }
    this.mat.neck = this._track(this.mat.skin.clone());
    this.mat.neck.vertexColors = false;
    this.mat.neck.color = P.neckSkin ? new THREE.Color(P.neckSkin) : new THREE.Color(P.skin).multiplyScalar(0.92);   // по фото — тон низа лица (7.3)
    const sss = P.skinScatter === false ? 0 : P.skinScatter ?? 0.7;   // 8.2: рассеяние в коже — кожа, веки, шея и уши
    if (sss > 0) for (const m of [this.mat.skin, this.mat.lid, this.mat.neck]) addShaderPatch(m, 'skin-scatter', skinScatter(sss), true);

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
    this._buildGlasses();
    this._buildBeard();
    this._buildHat();
    this._buildEarrings();
    this._buildHeadphones();
    this._buildMask();

    this._batchAll();
    root.traverse((o) => {
      if (o.isMesh && this.shadows && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  // ---------------- кожа + morph targets
  _buildSkin() {
    const P = this.P;
    const geo = this._track(sphereGrid(this.L.skin[0], this.L.skin[1], (px, py, pz, out) => shapeHead(px, py, pz, P, out), 0.36, 0.6));
    // деформация по точкам лица: UV фото и декалей считаются по несдвинутой базе — рисунок едет вместе с кожей
    let base = geo.attributes.position.array;
    if (this._warpF) {
      const a = geo.attributes.position.array, q = [0, 0, 0];
      base = Float32Array.from(a);
      for (let k = 0; k < a.length; k += 3) { q[0] = a[k]; q[1] = a[k + 1]; q[2] = a[k + 2]; this._warpF(q); a[k] = q[0]; a[k + 1] = q[1]; }
    }
    // проход 2: глазницы облегают глазное яблоко
    const hm0 = new HeightMap(geo);
    const eyeR = P.eyeR, rs = eyeR * 1.08;
    const ex = P.eyeX ?? LAYOUT.eyeX;
    this.eye = { r: eyeR, rs, rl: eyeR * 1.03, x: ex, y: LAYOUT.eyeY, z: hm0.get(ex, LAYOUT.eyeY) - 0.078 };
    const E = this.eye;
    const pos = geo.attributes.position.array;
    this._eyeRing = new Float32Array(pos.length / 3);
    const ring = [];
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (z < 0.35) continue;
      const dx = (Math.abs(x) - E.x) / rs, dy = (y - E.y) / rs;
      const dist = Math.hypot(dx, dy) * rs;
      // нижнее веко плотнее облегает яблоко (меньше "мешков"), верхнее — объёмнее
      const rr = lerp(rs, E.rl, smoothstep(0, -0.35, dy));
      const rho = dist / rr;
      if (rho > 2.2) continue;
      // зона максимального раскрытия глаза: здесь кожа уходит ЗА глазное яблоко
      const eo = Math.hypot(dx / 0.97, dy > 0 ? dy / 0.74 : dy / 0.5);
      const inner = E.z + Math.sqrt(Math.max(0, (0.93 * E.r) ** 2 - dist * dist));
      // вокруг — кожа вровень с оболочкой века (веко как бы вырастает из кожи, без "ямы")
      // у края оболочки кожа уходит под неё глубже: плоские треугольники кожи не протыкают кривую сферу века «зубцами»
      const flush = E.z + Math.sqrt(Math.max(0, rr * rr - Math.min(dist, rr * 0.999) ** 2)) - 0.006 - 0.022 * smoothstep(0.7, 1.0, rho);
      let T = lerp(inner, flush, smoothstep(0.92, 1.03, eo));
      // за гладким силуэтом оболочки века кожа поднимается к естественной поверхности (складка века)
      // пологая стенка: крутой подъём сетка 240×200 передаёт «зубцами» (ступеньки вершин по кругу глазницы)
      if (rho >= 1) T = E.z - 0.028 + rr * 2.9 * Math.pow(rho - 1, 1.3) + 0.022 * smoothstep(1.0, 1.25, rho);
      const m = 1 - smoothstep(1.2, 2.1, rho);
      pos[k + 2] = lerp(z, Math.min(z, T), m);
      // затенение глазницы: мягкий градиент по всей стенке, а не светлое кольцо
      this._eyeRing[k / 3] = (rho < 1 ? smoothstep(0.85, 1.0, rho) : 1 - smoothstep(1.0, 1.5, rho)) * m * (dy > 0 ? 1 : 0.9);
      if (rho > 0.9 && rho < 2.0) ring.push(k / 3);
    }
    // сглаживание стенки глазницы по соседям (z): крутой склон на грубой сетке иначе даёт «зубцы» в освещении
    {
      const idx = geo.index.array, nb = new Map(), set = new Set(ring);
      for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
        const a = idx[t + e], b = idx[t + (e + 1) % 3];
        if (set.has(a)) (nb.get(a) || nb.set(a, new Set()).get(a)).add(b);
        if (set.has(b)) (nb.get(b) || nb.set(b, new Set()).get(b)).add(a);
      }
      const tmpZ = new Float32Array(ring.length);
      for (let it = 0; it < 4; it++) {
        ring.forEach((v, j) => { let sz = 0, n = 0; for (const u of nb.get(v) || []) { sz += pos[u * 3 + 2]; n++; } tmpZ[j] = n ? lerp(pos[v * 3 + 2], sz / n, 0.6) : pos[v * 3 + 2]; });
        ring.forEach((v, j) => { pos[v * 3 + 2] = tmpZ[j]; });
      }
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
    this._morphList = this.L.morphs === 'lite' ? MORPH_LIST_LITE : MORPH_LIST;
    for (const m of this._morphList) addMorph(m.name, m.fn, m.sg);
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
      const hmB = base === pos ? this.hm : new HeightMap({ attributes: { position: { array: base } }, index: geo.index });
      P.photo.prepare?.({ pos: base, hm: hmB, eye: this.eye, P });
      const uv = geo.attributes.uv.array, t = [0, 0];
      for (let k = 0, i = 0; k < pos.length; k += 3, i += 2) {
        P.photo.uv(base[k], base[k + 1], pos[k + 2], t);
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
    if (hasDecals(P)) this._applyDecals(geo, base);
  }

  /**
   * Слой декалей (skin-decals.js): фронтальная проекция (x, y) → UV второго канала, цвет кожи × рисунок.
   * Инъекция в шейдер MeshPhysicalMaterial: отдельный атрибут decalUv, текстура decalMap.
   */
  _applyDecals(geo, pos = geo.attributes.position.array) {
    const B = DECAL_BOUNDS, uv = new Float32Array((pos.length / 3) * 2);
    for (let k = 0, i = 0; k < pos.length; k += 3, i += 2) {
      const front = pos[k + 2] > 0.02;                              // затылок — в угол (белый пиксель)
      uv[i] = front ? (pos[k] - B.x0) / (B.x1 - B.x0) : 0.001;
      uv[i + 1] = front ? (pos[k + 1] - B.y0) / (B.y1 - B.y0) : 0.999;
    }
    geo.setAttribute('decalUv', new THREE.BufferAttribute(uv, 2));
    const tex = this._track(new THREE.CanvasTexture(drawDecals(this.P, this.eye)));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const m = this.mat.skin;
    addShaderPatch(m, 'skin-decals', (sh) => {
      sh.uniforms.decalMap = { value: tex };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 decalUv;\nvarying vec2 vDecalUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvDecalUv = decalUv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D decalMap;\nvarying vec2 vDecalUv;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb *= texture2D(decalMap, vDecalUv).rgb;');
    });
  }

  // ---------------- глаза и веки
  _buildEyes() {
    const P = this.P, E = this.eye;
    const [ews, ehs] = this.L.eye;
    const ballGeo = this._track(P.cornea === false ? new THREE.SphereGeometry(E.r, ews, ehs).rotateX(Math.PI / 2) : eyeballGeometry(E.r, ews, ehs));
    this._corneaU = { value: 1 };
    this._pupilU = { value: 1 };
    const cu = P.cornea === false ? { value: 0 } : this._corneaU;    // без роговицы шейдер нужен только для зрачка
    corneaShader(this.mat.eye, E.r, cu, this._pupilU, P.pupil ?? 0.155);
    if (this.mat.eyeR !== this.mat.eye) corneaShader(this.mat.eyeR, E.r, cu, this._pupilU, P.pupil ?? 0.155);
    const phiS = Math.PI / 2 - 1.75, phiL = 3.5;
    const upGeo = this._track(new THREE.SphereGeometry(E.rs, this.L.lid, 14, phiS, phiL, 0, Math.PI / 2));
    const loGeo = this._track(new THREE.SphereGeometry(E.rl, this.L.lid, 10, phiS, phiL, Math.PI / 2, Math.PI / 2));
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
    const liner = resolveMakeup(P.makeup)?.eyeliner || 0;           // подводка — толще линия ресниц
    const lashGeo = this._track(new THREE.TorusGeometry(E.rs * 1.004, P.lash * (0.65 + 0.8 * liner), 5, 40, Math.PI));   // линия роста ресниц
    // ресницы-карточки: изогнутые ленты от кромки, длиннее к внешнему углу; upper — вверх, lower — вниз и реже
    const lashCards = (R, n, len, up, sg) => {
      const pos = [], idx = [];
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n, a = lerp(-1.42, 1.42, t), u = Math.sin(a) * sg;              // u > 0 — к виску
        const L = len * (0.55 + 0.6 * smoothstep(-0.7, 0.75, u)) * (1 - 0.35 * smoothstep(0.85, 1, Math.abs(u))) * (0.85 + 0.3 * ((j * 7919) % 13) / 13);
        const h = ((j * 7919) % 101) / 101, h2 = ((j * 3571) % 97) / 97;                       // разброс без Math.random
        const rad = [Math.sin(a), 0, Math.cos(a)], tan = [Math.cos(a), 0, -Math.sin(a)], tilt = 0.3 * u + 0.18 * (h2 - 0.5);   // у висков — наружу
        const w = len * (0.045 + 0.02 * h), base = pos.length / 3;
        for (let k = 0; k <= 3; k++) {
          const f = k / 3, curl = up * (0.1 + (0.7 + 0.3 * h2) * f * f), out = 0.75 + 0.25 * f;
          const cx = R * rad[0] + L * f * (out * rad[0] + tilt * tan[0]), cy = L * f * curl, cz = R * rad[2] + L * f * (out * rad[2] + tilt * tan[2]);
          const ww = w * (1 - 0.85 * f);
          pos.push(cx - tan[0] * ww, cy, cz - tan[2] * ww, cx + tan[0] * ww, cy, cz + tan[2] * ww);
          if (k) { const b = base + (k - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
        }
      }
      const g = this._track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    const lashLen = (P.lashLen ?? (this.gender === 'female' ? 1 : 0.7)) * 0.034 * (E.r / 0.116) * (1 + 0.25 * liner);
    const lashCardMat = this._track(new THREE.MeshStandardMaterial({ color: '#120c0a', roughness: 0.8, side: THREE.DoubleSide }));
    lashGeo.rotateX(Math.PI / 2);
    const lashLoGeo = this._track(new THREE.TorusGeometry(E.rl * 1.004, P.lash * 0.28, 4, 32, Math.PI * 0.8));
    lashLoGeo.rotateX(Math.PI / 2);
    lashLoGeo.rotateY(-Math.PI * 0.1);
    // мягкая тень от верхнего века: полоса с альфа-градиентом прямо под кромкой
    const shGeo = this._track(new THREE.SphereGeometry(E.r * 1.012, ews, 6, phiS + 0.2, phiL - 0.4, Math.PI / 2, 0.42));
    const shPos = shGeo.attributes.position, shCol = new Float32Array(shPos.count * 4);
    for (let i = 0; i < shPos.count; i++) {
      const y = shPos.getY(i) / (E.r * 1.012);        // 0 на кромке, отрицательный ниже
      const a = smoothstep(-0.4, 0.0, y) * 0.55;
      shCol.set([0.05, 0.02, 0.02, a], i * 4);
    }
    shGeo.setAttribute('color', new THREE.BufferAttribute(shCol, 4));
    const shMat = this._track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));

    // кромка нижнего века (влажная полоска между веком и глазом) и слёзное мясцо во внутреннем углу
    const wetGeo = this._track(new THREE.TorusGeometry((E.r + E.rl) / 2, Math.max(0.0024, (E.rl - E.r) * 0.7), 6, 40, Math.PI));
    wetGeo.rotateX(Math.PI / 2);
    const wetMat = this._track(new THREE.MeshPhysicalMaterial({ color: new THREE.Color(P.skin).lerp(new THREE.Color('#d98a86'), 0.55), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 }));
    const carGeo = this._track(new THREE.SphereGeometry(1, 16, 12));
    const carMat = this._track(new THREE.MeshPhysicalMaterial({ color: '#cf7f7a', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.0 }));
    const kr = E.r / 0.116;
    // нижние ресницы редкие и короткие: не чёрная обводка, а тёмная полупрозрачная линия
    const lashLoMat = this._track(new THREE.MeshStandardMaterial({ color: new THREE.Color('#120c0a').lerp(new THREE.Color(P.skin), 0.35), roughness: 0.8, transparent: true, opacity: 0.6 }));

    // складка: дуга-трубка на сфере радиуса rs·1.03 на высоте creaseEl над кромкой; hood опускает и утолщает её
    const hood = clamp(P.hood || 0, 0, 1), crease = P.lidCrease ?? 0.45;
    const creaseEl = (P.upperOpen + 30 - 20 * hood) * DEG;
    let creaseGeo = null;
    if (crease > 0.02 || hood > 0.02) {
      const tube = (0.003 + 0.004 * crease + 0.013 * hood) * kr;
      creaseGeo = this._track(new THREE.TorusGeometry(E.rs * (1.02 + 0.03 * hood), tube, 6, 36, Math.PI * 0.86));
      creaseGeo.rotateX(Math.PI / 2);
      creaseGeo.rotateY(Math.PI * 0.07);
      // тень под валиком: низ трубки темнее, края дуги растворяются в коже (тоньше к углам)
      const p = creaseGeo.attributes.position, c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const v = p.getY(i) < 0 ? lerp(1, 0.72, clamp(-p.getY(i) / tube, 0, 1)) : 1; c.set([v, v * 0.97, v * 0.97], i * 3); }
      creaseGeo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      const R = E.rs * (1.02 + 0.03 * hood);
      for (let i = 0; i < p.count; i++) {                          // к углам глаза валик сходит на нет (прижимается к оболочке)
        const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z) || 1, e = Math.abs(x) / R, f = 1 - smoothstep(0.55, 0.98, e);
        const rr = R + (r - R) * f; p.setXYZ(i, (x / r) * rr, p.getY(i) * f, (z / r) * rr);
      }
      creaseGeo.computeVertexNormals();
    }
    const epiGeo = this._track(new THREE.SphereGeometry(1, 14, 10));
    epiGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(epiGeo.attributes.position.count * 3).fill(0.96), 3));

    this.eyes = [];
    for (const sg of [1, -1]) {                         // 1 = левый глаз персонажа (+X)
      const g = new THREE.Group();
      g.position.set(sg * E.x, E.y, E.z);
      const ball = new THREE.Mesh(ballGeo, sg > 0 ? this.mat.eye : this.mat.eyeR);   // sg < 0 — правый глаз персонажа
      ball.rotation.order = 'YXZ';
      ball.userData.noShadow = false;
      g.add(ball);
      const lids = new THREE.Group();
      lids.rotation.z = sg * P.eyeTilt;
      g.add(lids);
      const up = new THREE.Mesh(this._shapeLid(upGeo, sg, true), this.mat.lid);
      const lo = new THREE.Mesh(this._shapeLid(loGeo, sg, false), this.mat.lid);
      // ресницы, тень и кромка повторяют форму кромки века
      const lash = new THREE.Mesh(this._shapeLid(lashGeo, sg, true, E.rs), this.mat.lash);
      const lashLo = new THREE.Mesh(this._shapeLid(lashLoGeo, sg, false, E.rl), lashLoMat);
      const sh = new THREE.Mesh(this._shapeLid(shGeo, sg, true, E.rs), shMat);
      sh.userData.noShadow = true;
      sh.renderOrder = 1;
      lash.userData.noShadow = true; lashLo.userData.noShadow = true;
      const wet = new THREE.Mesh(this._shapeLid(wetGeo, sg, false, E.rl), wetMat);
      wet.userData.noShadow = true;
      wet.position.y = 0.0012 * kr;
      const cardsU = new THREE.Mesh(this._shapeLid(lashCards(E.rs * 1.003, 44, lashLen, 1, sg), sg, true, E.rs), lashCardMat);
      const cardsL = new THREE.Mesh(this._shapeLid(lashCards(E.rl * 1.003, 26, lashLen * 0.38, -1, sg), sg, false, E.rl), lashLoMat);
      cardsU.userData.noShadow = cardsL.userData.noShadow = true;
      up.add(lash, sh, cardsU);
      lo.add(lashLo, wet, cardsL);
      // складка века (валик кожи над подвижным веком) и нависание; эпикантус — кожная складка во внутреннем углу
      if (creaseGeo) {
        const cr = new THREE.Mesh(this._shapeLid(creaseGeo, sg, true, E.rs), this.mat.lid);
        cr.rotation.x = -creaseEl;
        cr.userData.noShadow = true;
        lids.add(cr);
      }
      if (P.epicanthus > 0.02) {
        const ep = new THREE.Mesh(epiGeo, this.mat.lid), k = P.epicanthus;
        ep.position.set(-sg * E.r * (0.9 - 0.05 * k), 0.004 * kr, E.r * (0.42 + 0.04 * k));
        ep.scale.set((0.012 + 0.016 * k) * kr, (0.016 + 0.014 * k) * kr, (0.008 + 0.006 * k) * kr);
        ep.rotation.set(0, -sg * 0.5, sg * -0.5);
        ep.userData.noShadow = true;
        lids.add(ep);
      }
      const car = new THREE.Mesh(carGeo, carMat);       // в группе век: наклоняется вместе с разрезом
      car.position.set(-sg * E.r * 0.915, -0.003 * kr, E.r * 0.39);
      car.scale.set(0.008 * kr, 0.011 * kr, 0.006 * kr);
      car.rotation.y = -sg * 0.3;
      car.userData.noShadow = true;
      lids.add(up, lo, car);
      this.headRoot.add(g);
      this.eyes.push({ sg, group: g, ball, up, lo });
    }
  }

  /**
   * Форма разреза: кромка века поворачивается вокруг оси глаза на угол Δ(u), u = −1 (внутренний угол) … +1 (внешний).
   *   lidUpSkew / lidLoSkew — перекос, градусы: > 0 — вершина дуги смещена к внешнему углу (верх) / внешний угол ниже (низ)
   *   lidUpFull / lidLoFull — полнота, градусы: > 0 — середина раскрыта сильнее (круглее), < 0 — площе (уже)
   * Вершины ближе к кромке поворачиваются полностью, к полюсу оболочки — плавно меньше. Геометрия своя для каждого глаза.
   */
  _shapeLid(geo, sg, upper, R = geo.parameters.radius) {
    const P = this.P, sk = upper ? P.lidUpSkew || 0 : P.lidLoSkew || 0, fu = upper ? P.lidUpFull || 0 : P.lidLoFull || 0;
    if (!sk && !fu) return geo;
    const g = this._track(geo.clone()), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const u = clamp((sg * x) / R, -1, 1), e = 1 - u * u;
      const d = (sk * u * e * 2.6 + fu * e * e) * DEG;            // градусы → радианы
      const el = Math.asin(clamp(Math.abs(y) / R, 0, 1));          // 0 у кромки → π/2 у полюса
      const a = (upper ? -d : d) * (1 - smoothstep(0, 1.3, el));   // верх: −Δ поднимает кромку; низ: +Δ опускает
      const c = Math.cos(a), s = Math.sin(a);
      p.setXYZ(i, x, y * c - z * s, y * s + z * c);
    }
    g.computeVertexNormals();
    return g;
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
    this.mouth = {};
    const M = this.mouth;
    // Рот рисуется поверх кожи без теста глубины (порядок: полость → язык → зубы → губы).
    // Так деформированная кожа никогда не "протыкает" губы; рот фронтальный, при поворотах до ±20° это незаметно.
    // Полость пишет в буфер глубины «дальнюю плоскость» (gl_FragDepth = 1): внутри ротового отверстия зубы, дёсны
    // и язык потом перекрывают друг друга по-честному, а кожа, нарисованная раньше, им не мешает.
    const cavMat = this._track(new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, ...stencilWrite }));
    cavMat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragDepth = 1.0;'); };
    const inner = { depthTest: true, depthWrite: true, ...stencilTest };
    M.teethColor = new THREE.Color(TEETH_COLORS[P.teethColor] || P.teethColor || TEETH_COLORS.natural);
    const teethMat = this._track(new THREE.MeshPhysicalMaterial({ color: M.teethColor, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.25, vertexColors: true, envMapIntensity: 0.5, ...inner }));
    const gumMat = this._track(new THREE.MeshPhysicalMaterial({ color: '#c4646c', roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3, vertexColors: true, envMapIntensity: 0.4, ...inner }));
    const tongueMat = this._track(new THREE.MeshStandardMaterial({ color: '#b5525a', roughness: 0.5, vertexColors: true, side: THREE.DoubleSide, ...inner }));   // сетка языка обходится «изнанкой» к камере
    M.teethMat = teethMat; M.gumMat = gumMat; M.cavMat = cavMat; M.tongueMat = tongueMat;

    M.N = 36;
    M.cav = new THREE.Mesh(this._track(dynamicGrid(M.N, 8, true)), cavMat);
    M.tongue = new THREE.Mesh(this._track(dynamicGrid(16, 6, true)), tongueMat);
    // зубы и дёсны: верхние неподвижны, нижние — в группе, которая поворачивается вокруг оси челюсти
    const zFront = this.hm.get(0, LAYOUT.mouthY) - 0.012;
    const dU = buildDentition(P, zFront, true, this.L.teeth), dL = buildDentition(P, zFront - 0.024, false, this.L.teeth);
    for (const g of [dU.teeth, dU.gums, dL.teeth, dL.gums]) this._track(g);
    M.teethU = new THREE.Mesh(dU.teeth, teethMat); M.gumsU = new THREE.Mesh(dU.gums, gumMat);
    M.jaw = new THREE.Group();
    M.jaw.position.set(0, JAW_PIVOT.y, JAW_PIVOT.z);
    const jawInner = new THREE.Group();
    jawInner.position.set(0, -JAW_PIVOT.y, -JAW_PIVOT.z);
    M.jaw.add(jawInner);
    M.teethL = new THREE.Mesh(dL.teeth, teethMat); M.gumsL = new THREE.Mesh(dL.gums, gumMat);
    jawInner.add(M.teethL, M.gumsL);
    if (dU.braces) {
      const bm = this._track(bracesMaterial(P.braces)); Object.assign(bm, inner);
      M.bracesMat = bm; M.bracesColor = bm.color.clone();
      M.bracesU = new THREE.Mesh(this._track(dU.braces), bm); M.bracesL = new THREE.Mesh(this._track(dL.braces), bm);
      jawInner.add(M.bracesL);
    }
    this.headRoot.add(M.jaw);
    M.lipU = new THREE.Mesh(this._track(dynamicGrid(M.N, 7, true)), this.mat.lip);
    M.lipL = new THREE.Mesh(this._track(dynamicGrid(M.N, 7, true)), this.mat.lip);
    let order = 10;
    for (const k of ['cav', 'tongue', 'gumsL', 'teethL', 'bracesL', 'gumsU', 'teethU', 'bracesU', 'lipU', 'lipL']) {
      const m = M[k];
      if (!m) continue;
      m.renderOrder = order++;
      m.frustumCulled = false;
      if (k !== 'lipU' && k !== 'lipL') m.userData.noShadow = true;
      if (!m.parent) this.headRoot.add(m);
    }
    // постоянные цвета: губы темнеют к внутренней кромке
    // губы темнеют к внутренней кромке и к уголкам; у внешнего контура цвет чуть уходит в тон кожи (без «наклейки»)
    const lipC = new THREE.Color(P.lip), skinC = new THREE.Color(P.skin);
    const toSkin = [skinC.r / Math.max(0.05, lipC.r), skinC.g / Math.max(0.05, lipC.g), skinC.b / Math.max(0.05, lipC.b)];
    const shadeLip = (geo) => {
      const { cols, rows } = geo.userData, c = geo.attributes.color.array;
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const s = r / rows, t = (i / cols) * 2 - 1, k = (r * (cols + 1) + i) * 3;
        const v = lerp(0.55, 1, smoothstep(0, 0.35, s)) * lerp(1, 0.75, Math.abs(t) ** 4);
        const edge = smoothstep(0.82, 1, s) * 0.22;
        c[k] = v * lerp(1, toSkin[0], edge); c[k + 1] = v * 0.97 * lerp(1, toSkin[1], edge); c[k + 2] = v * 0.97 * lerp(1, toSkin[2], edge);
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
    const J = this._jaw = { open: g('jawOpen'), fwd: g('jawForward'), left: g('jawLeft'), right: g('jawRight') };
    const press = (prL + prR) / 2, smile = (smL + smR) / 2, stretch = (stL + stR) / 2;
    const round = clamp(puck + fun, 0, 1);

    const corner = (sg, sm, fr, st, dm, pr) => ({
      x: sg * P.mouthHW * (1 + 0.17 * sm + 0.3 * st + 0.1 * dm - 0.4 * puck - 0.28 * fun - 0.06 * pr) + 0.07 * shift,
      // асимметрия (3.8): уголок в покое выше/ниже — mouthCornerL/R (единицы головы)
      y: 0.072 * sm - 0.065 * fr - 0.012 * st + 0.018 * dm - 0.008 * pr + ((sg > 0 ? P.mouthCornerL : P.mouthCornerR) || 0),
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
      // lipUAsym/lipLAsym > 0 — левая половина губы полнее; lipLoShape — полнота нижней губы к уголкам (больше — «квадратнее»)
      C.thU[i] = thU0 * upperLipProfile(t, P) * (1 + (P.lipUAsym || 0) * t);
      C.thL[i] = thL0 * Math.pow(Math.max(0, 1 - at ** (P.lipLoShape ?? 2.2)), 0.5) * (1 + (P.lipLAsym || 0) * t);
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
          const bulge = th * 0.55 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * s)), 0.65) * (1 - 0.3 * s)
            + 0.0022 * Math.exp(-(((s - 0.9) / 0.06) ** 2));       // кайма: валик по внешнему контуру ловит свет
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

    // зубы: нижняя дуга поворачивается вместе с челюстью (тот же угол, что у морфа jawOpen)
    M.jaw.rotation.x = J.open * JAW_THETA;
    M.jaw.position.x = (J.left - J.right) * 0.04;
    M.jaw.position.z = JAW_PIVOT.z + J.fwd * 0.045;
    // свет во рту: чем шире раскрыт рот, тем светлее зубы и полость (узкая щель — почти темнота)
    const gap = clamp(J.open * 1.6 + smile * 0.55 + 0.4 * (upL + upR) / 2 - 0.5 * press, 0, 1);
    const lit = lerp(0.5, 1, smoothstep(0, 0.6, gap));
    M.teethMat.color.copy(M.teethColor).multiplyScalar(lit);
    if (M.bracesMat) { M.bracesMat.color.copy(M.bracesColor).multiplyScalar(lit); M.bracesMat.envMapIntensity = 0.9 * lit; }
    M.gumMat.color.set('#c4646c').multiplyScalar(lit);
    M.tongueMat.color.set('#b5525a').multiplyScalar(lerp(0.6, 1, smoothstep(0, 0.6, gap)));

    // язык
    {
      const geo = M.tongue.geometry, { cols, rows } = geo.userData, pos = geo.attributes.position.array;
      // s: 0 — корень (низ), 1 — кончик. tongueUp поднимает и сужает кончик к альвеолам за верхними зубами
      // (Т, Д, Н, Л), tongueOut выдвигает вперёд; по центру — продольный желобок
      const out = g('tongueOut'), up = clamp(ch.tongueUp || 0, 0, 1);
      const reach = (J.open * JAW_THETA) * 0.32;                   // челюсть опускает язык — кончику тянуться выше
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const t = (i / cols) * 2 - 1, s = r / rows, tip = s * s;
        const x = t * P.mouthHW * 0.82 * Math.sqrt(1 - 0.6 * s * s) * (1 - 0.38 * up * tip);
        const y = MY - 0.068 + s * (0.05 + 0.06 * out) * (1 - 0.5 * t * t) + up * tip * (0.08 + reach) * (1 - 0.6 * t * t);
        const z = -0.068 + 0.1 * out * s - 0.03 * t * t + 0.03 * up * tip - 0.006 * Math.exp(-((t / 0.28) ** 2)) * (1 - s);
        this._mouthPoint(x, y, z, lowerJawW, J, pos, (r * (cols + 1) + i) * 3);
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
    // объём по фото (photo-avatar): толщина волос над силуэтом черепа по углу θ от макушки (0, 20 … 100°, анфас)
    const vol = P.hairVol, HC = 0.15;
    const volAt = (x, y) => {
      if (!vol) return null;
      const t = clamp(Math.atan2(Math.abs(x), y - HC) / DEG / 20, 0, vol.length - 1), i = Math.min(Math.floor(t), vol.length - 2);
      return lerp(vol[i], vol[i + 1], t - i);
    };
    const bangSide = P.bangSide ?? (long ? -1 : 0), bangDepth = P.bangDepth ?? (long ? 0.1 : 0);
    const lineF = (long ? [0.6, 0.52, 0.34, 0.16, 0.0, -0.3, -0.5, -0.55] : [0.64, 0.57, 0.4, 0.24, 0.08, -0.2, -0.36, -0.4])
      .map((v, i) => v + (P.hairline || 0) * Math.max(0, 1 - i / 4) + (P.hairTemples || 0) * Math.exp(-(((i - 1.6) / 0.8) ** 2)));   // лоб (по фото), залысины
    const hairline = (a) => {
      const u = clamp(Math.abs(a) / Math.PI * (lineF.length - 1), 0, lineF.length - 1.001);
      const i = Math.floor(u);
      return lerp(lineF[i], lineF[i + 1], smoothstep(0, 1, u - i));
    };
    const tmp = [0, 0, 0];
    /** Точка оболочки волос по направлению (px, py, pz) единичной сферы; возвращает высоту на голове и линию роста. */
    const shellAt = (px, py, pz, out) => {
      shapeHead(px, py, pz, P, tmp);
      if (this._warpF) this._warpF(tmp);
      const a = Math.atan2(tmp[0], tmp[2]);
      let yh = hairline(a);
      if (bangSide) yh -= bangDepth * G(a, 0, bangSide * 0.45, 0, 0.3, 1);  // чёлка набок (сторона и глубина — по фото)
      let H = long ? 0.06 + 0.06 * smoothstep(0.2, 0.9, tmp[1]) + 0.05 * G(a, tmp[1], bangSide * 0.5 || -0.5, 0.45, 0.4, 0.18) : 0.032 + 0.018 * smoothstep(0.3, 0.9, tmp[1]);
      if (!long) H += 0.012 * G(a, tmp[1], 0, 0.6, 0.5, 0.1);               // лёгкий объём надо лбом
      const v = volAt(tmp[0], tmp[1]);
      // силуэт причёски с фото; к вискам и ниже — плавно к обычной толщине (иначе по бокам «поля шляпы»)
      if (v !== null) H = lerp(H, Math.max(H * 0.6, long ? v : Math.min(v, P.hairVolMax ?? 0.14)), smoothstep(-0.45, 0.3, tmp[1]) * (0.55 + 0.45 * smoothstep(-0.2, 0.5, tmp[1])));
      H *= P.hairThick ?? 1;
      if (P.hairCurl) {                                                       // кудри: «пупырчатый» шум, сильнее у края силуэта
        const nz = Math.sin(tmp[0] * 47 + Math.sin(tmp[1] * 29) * 2.5) + Math.sin(tmp[1] * 43 + tmp[2] * 31) + Math.sin(tmp[2] * 37 + tmp[0] * 19);
        H += P.hairCurl * Math.abs(nz) * 0.6 * smoothstep(-0.2, 0.5, tmp[1]);
      }
      if (P.hat) { const hl = P.hat.y0 ?? HAT_LINE[P.hat.style] ?? 0.45; H = lerp(H, Math.min(H, 0.03), smoothstep(hl - 0.08, hl, tmp[1])); }   // под шапкой волосы примяты
      // у линии роста волосы сходят на нет, ниже неё поверхность уходит глубоко под кожу
      const off = H * (0.3 + 0.7 * smoothstep(yh, yh + 0.16, tmp[1])) - (0.25 + 0.3 * H) * (1 - smoothstep(yh - 0.1, yh, tmp[1]));
      const nx = px / prof(P.gx, py), ny = py, nz = pz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const y = tmp[1];
      out[0] = tmp[0] + (nx / nl) * off; out[1] = tmp[1] + (ny / nl) * off; out[2] = tmp[2] + (nz / nl) * off;
      return y - yh;                                                         // > 0 — выше линии роста
    };
    const geo = this._track(sphereGrid(this.L.hair[0], this.L.hair[1], shellAt));
    geo.computeVertexNormals();
    // цвет: корни темнее, верх с бликом
    const p = geo.attributes.position.array, col = new Float32Array(p.length);
    for (let k = 0; k < p.length; k += 3) { const v = lerp(0.6, 1.05, smoothstep(-0.4, 0.9, p[k + 1])); col[k] = col[k + 1] = col[k + 2] = v; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const cap = new THREE.Mesh(geo, this.mat.hair);
    cap.name = 'hair';
    this.headRoot.add(cap);

    if (P.hairTail) this._buildHairTail(P.hairTail);
    /** Занавес длинных волос: угол a вокруг головы (0 — лицо), t = 0 у висков … 1 у кончиков. */
    const curtainAt = (a, t, out, wk = 1) => {
      const bottom = (P.hairBottom ?? -1.55) + 0.07 * Math.sin(a * 5) + 0.05 * Math.sin(a * 13);
      const y = lerp(0.42, bottom, t);
      const flare = smoothstep(-0.2, -1.5, y);
      const front = Math.cos(a) > 0 ? Math.cos(a) : 0;
      const jaw = smoothstep(0.1, -0.7, y) * (1 - smoothstep(-0.9, -1.3, y)) * front;   // у лица пряди ближе к щекам
      const rx = (0.84 + 0.1 * flare + 0.012 * Math.sin(a * 9 + y * 3) - 0.1 * jaw) * wk;
      const rz = 0.86 + 0.06 * flare + 0.012 * Math.sin(a * 7 - y * 2) - 0.12 * jaw;
      out[0] = rx * Math.sin(a); out[1] = y; out[2] = -0.08 + rz * Math.cos(a);
      return out;
    };
    let wkC = 1;
    if (long) {
      // "занавес" длинных волос сзади и по бокам
      const side = volAt(1, HC - 0.17);                                      // объём у висков (θ ≈ 100°)
      const cols = 64, rows = 30, a0 = 1.0, wk = wkC = prof(P.gx, 0) / 0.755 * (side === null ? 1 : clamp(1 + (side - 0.07) / 0.84, 0.92, 1.35));   // занавес по ширине головы и волос
      const g = this._track(dynamicGrid(cols, rows, true));
      const pos = g.attributes.position.array, c = g.attributes.color.array, q = [0, 0, 0], sw = new Float32Array(pos.length / 3);
      for (let r = 0; r <= rows; r++) for (let i = 0; i <= cols; i++) {
        const a = a0 + (i / cols) * (Math.PI * 2 - 2 * a0);
        curtainAt(a, r / rows, q, wk);
        const k = (r * (cols + 1) + i) * 3;
        pos[k] = q[0]; pos[k + 1] = q[1]; pos[k + 2] = q[2];
        sw[k / 3] = (r / rows) ** 2;                                        // раскачка растёт к кончикам
        const v = lerp(0.95, 0.55, r / rows) * (0.9 + 0.1 * Math.sin(i * 1.7));
        c[k] = c[k + 1] = c[k + 2] = v;
      }
      g.setAttribute('hairSw', new THREE.BufferAttribute(sw, 1));
      g.computeVertexNormals();
      const curtain = new THREE.Mesh(g, this.mat.hair);
      curtain.name = 'hairLong';
      this.headRoot.add(curtain);
    }
    if (P.hairCards ?? !(P.hairScalp || P.hairCurl)) this._buildHairCards(shellAt, long ? (a, t, o) => curtainAt(a, t, o, wkC) : null, volAt);
  }

  /**
   * Пряди-карточки (1.7–1.9) поверх оболочки: ленты с альфа-текстурой прядей, корни на скальпе, пряди текут
   * от макушки по оболочке, у длинных — дальше по занавесу. Прозрачность — alpha-to-coverage (MSAA, без сортировки), тени
   * отбрасывает оболочка. Раскачка — вершинный шейдер: hairSw (0 у корня → 1 у кончика) × смещение пружины
   * (_updateHairSwing). Детерминированный ГПСЧ: одинаковая причёска при каждой сборке.
   */
  _buildHairCards(shellAt, curtainAt, volAt) {
    const P = this.P, long = !!curtainAt, n = P.hairCards > 1 ? P.hairCards : Math.round((long ? 420 : 300) * this.L.cards);
    let seed = 7;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const V = THREE.Vector3, C = new V(0, 0.82, -0.57).normalize();          // макушка (завиток) — пряди расходятся от неё
    const side = P.bangSide ?? (long ? -1 : 0), q = [0, 0, 0];
    const pos = [], uv = [], col = [], sw = [], idx = [];
    const u = new V(), t = new V(), p = new V(), pPrev = new V(), nrm = new V(), b = new V(), X = new V(1, 0, 0), D = new V(0, -1, 0);
    const seg = long ? 10 : 6;
    for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
      // корень: равномерно по сфере, выше линии роста (с запасом)
      const z = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      u.set(r * Math.cos(ph), z, r * Math.sin(ph));
      if (u.y < -0.2 || shellAt(u.x, u.y, u.z, q) < 0.06) continue;
      const v = volAt(q[0], q[1]);
      if (v !== null && v < 0.025) continue;                                  // выбритые зоны (андеркат) — без прядей
      k++;
      const len = (long ? 0.55 : 0.32) * (0.7 + 0.5 * rnd()), w = (long ? 0.075 : 0.06) * (0.75 + 0.5 * rnd()), lift = 0.003 + 0.01 * rnd();
      const shade = 0.93 + 0.11 * rnd(), base = pos.length / 3, pts = [];   // небольшой разброс: сильный давал пятна
      // шагаем по сфере направлений: от макушки, у лица — в сторону пробора, по бокам длинных — вниз
      const step = len / seg / 0.9;
      let onCurtain = false, ca = 0, ct = 0;
      for (let i = 0; i <= seg; i++) {
        if (!onCurtain) {
          shellAt(u.x, u.y, u.z, q); p.set(q[0], q[1], q[2]);
          nrm.copy(u);
          if (long && i > 0 && p.y < 0.42 && Math.abs(Math.atan2(p.x, p.z + 0.08)) > 1.0) { onCurtain = true; ca = Math.atan2(p.x, p.z + 0.08); ct = 0; }
        }
        if (onCurtain) { curtainAt(ca, ct, q); p.set(q[0], q[1], q[2]); nrm.set(Math.sin(ca), 0, Math.cos(ca)); }
        if (!pts.length || pts[pts.length - 1].p.distanceToSquared(p) > 1e-6)   // совпавшие узлы (конец занавеса) — пропуск
          pts.push({ p: p.clone(), n: nrm.clone(), ct: onCurtain ? ct : null });   // на занавесе вес раскачки = как у занавеса (ct²)
        if (onCurtain) ct = Math.min(1, ct + step / 1.6);
        if (!onCurtain) {
          t.copy(C).addScaledVector(u, -u.dot(C)).multiplyScalar(-1);       // касательная «от макушки»
          if (u.z > 0.3 && side) t.addScaledVector(X, side * 0.5 * smoothstep(0.3, 0.8, u.z));
          if (long) t.addScaledVector(D, 0.6 * smoothstep(0.2, 0.9, Math.abs(u.x)));
          t.addScaledVector(u, -u.dot(t));
          if (t.lengthSq() < 1e-8) t.set(0, 0, -1);
          u.addScaledVector(t.normalize(), step).normalize();
          if (!long && shellAt(u.x, u.y, u.z, q) < 0.0) break;                // у линии роста короткая прядь кончается
        }
      }
      if (pts.length < 3) { k--; continue; }
      const m = pts.length - 1;
      for (let i = 0; i <= m; i++) {
        const a = pts[i], f = i / m, dir = (i < m ? pts[i + 1].p : a.p).clone().sub(i < m ? a.p : pts[i - 1].p).normalize();
        b.crossVectors(dir, a.n);
        if (b.lengthSq() < 1e-10) b.set(1, 0, 0); else b.normalize();
        const ww = w * (1 - 0.55 * f) / 2, h = lift + 0.006 * f;
        for (const s of [-1, 1]) {
          pos.push(a.p.x + a.n.x * h + b.x * ww * s, a.p.y + a.n.y * h + b.y * ww * s, a.p.z + a.n.z * h + b.z * ww * s);
          uv.push(s < 0 ? 0 : 1, 1 - f);
          const v = shade * lerp(0.62, 1.05, smoothstep(0, 0.5, f));
          col.push(v, v, v);
          sw.push(a.ct !== null ? a.ct * a.ct : 0.12 * f * f);
        }
        if (i) { const o = base + (i - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      }
    }
    const geo = this._track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('hairSw', new THREE.Float32BufferAttribute(sw, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.mat.hairCards);
    mesh.name = 'hairCards';
    // тени от прядей (8.1): своя глубина с вырезом по альфе текстуры и той же раскачкой — пряди затеняют лоб и лицо
    const depth = this._track(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this.mat.hairCards.map, alphaTest: 0.3, side: THREE.DoubleSide }));
    hairSwayShader(depth, this._hairU, 'hair-cards-depth');
    mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false;
    this.headRoot.add(mesh);
    this.hairCards = mesh;
  }

  /** Головной убор: тело вращения по силуэту черепа + волос (эллипс в плане), козырёк/поля — отдельно. */
  _buildHat() {
    const P = this.P, h = P.hat;
    if (!h) return;
    const st = h.style || 'beanie', y0 = h.y0 ?? HAT_LINE[st] ?? 0.45, tmp = [0, 0, 0], brimmed = st === 'fedora' || st === 'bowler';
    const hairT = P.hairStyle === 'none' ? 0.005 : 0.035;
    // полуоси головы на высоте y: ширина (x) и глубина вперёд/назад (z), центр по z
    const ell = (y) => {
      const yy = clamp(y, -0.99, 0.999), r = Math.sqrt(1 - yy * yy);
      shapeHead(r, yy, 0, P, tmp); const ax = tmp[0];
      shapeHead(0, yy, r, P, tmp); const zf = tmp[2];
      shapeHead(0, yy, -r, P, tmp); const zb = tmp[2];
      return { ax, az: (zf - zb) / 2, cz: (zf + zb) / 2 };
    };
    const mat = this._track(new THREE.MeshStandardMaterial({ color: h.color || '#3a4a5a', roughness: st === 'cap' ? 0.7 : 0.92, side: THREE.DoubleSide }));
    const group = new THREE.Group();
    group.name = 'hat';
    // купол: кольца по высоте от края до макушки (поверх волос), для fedora — выше и с заломом
    const rows = this._q(22, 10), segs = this._q(72, 24), pos = [], idx = [];
    const topY = st === 'fedora' ? 1.32 : st === 'bowler' ? 1.3 : st === 'headband' ? y0 + 0.13 : 1.0 + hairT + (st === 'cloche' ? 0.08 : 0.1);
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, y = lerp(y0, topY, t);
      const e = ell(Math.min(y, 0.8)), pad = hairT + (st === 'beanie' ? 0.03 + 0.012 * (r < 5 ? 1 : 0) : 0.02);   // выше 0.8 — эллипс купола, а не черепа
      let k = 1;
      if (st !== 'headband' && y > 0.8) k = Math.sqrt(Math.max(0, 1 - ((y - 0.8) / (topY - 0.8)) ** 2));   // скругление к макушке (с запасом над волосами)
      if (st === 'fedora') k = y < 1.2 ? 1 - 0.05 * t : Math.sqrt(Math.max(0, 1 - ((y - 1.2) / 0.12) ** 2));
      if (st === 'bowler') k = y < 0.95 ? 1 : Math.sqrt(Math.max(0, 1 - ((y - 0.95) / (topY - 0.95)) ** 2));   // купол котелка
      for (let c = 0; c <= segs; c++) {
        const a = (c / segs) * Math.PI * 2, sx = Math.sin(a), cz = Math.cos(a);
        let rx = (e.ax + pad) * k, rz = (e.az + pad) * k;
        if (brimmed) { rx = Math.max(rx, 0.62 * k); rz = Math.max(rz, 0.72 * k); }
        let yy = y;
        if (st === 'fedora' && y > 1.15) yy -= 0.06 * Math.exp(-((sx / 0.25) ** 2)) * (1 - Math.abs(cz) * 0.3);   // залом тульи
        if (st === 'beanie') { const rib = 0.004 * Math.sin(a * 48); rx += rib * (r < 5 ? 1 : 0.4); rz += rib * (r < 5 ? 1 : 0.4); }
        pos.push(rx * sx, yy, e.cz + rz * cz);
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < segs; c++) { const a = r * (segs + 1) + c, b = a + 1, d = a + segs + 1, e2 = d + 1; idx.push(a, b, d, b, e2, d); }
    const dome = this._track(new THREE.BufferGeometry());
    dome.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    dome.setIndex(idx); dome.computeVertexNormals();
    group.add(new THREE.Mesh(dome, mat));
    // козырёк (cap) или поля (fedora)
    if (st === 'cap' || brimmed || st === 'cloche') {
      const e = ell(y0), pts = [], bi = [], rim = [];
      const n = this._q(48, 16), W = st === 'cap' ? Math.PI * 0.55 : Math.PI * 2, a0 = st === 'cap' ? -W / 2 : 0;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (i / n) * W, sx = Math.sin(a), cz = Math.cos(a);
        const rx = e.ax + hairT + 0.02, rz = e.az + hairT + 0.02;
        const ext = st === 'cap' ? 0.42 * Math.cos((a / W) * Math.PI) ** 0.6 : st === 'bowler' ? 0.19 : st === 'cloche' ? 0.1 : 0.3;
        const ix = rx * sx, iz = e.cz + rz * cz, ox = (rx + ext) * sx, oz = e.cz + (rz + ext) * cz;
        const droop = st === 'cap' ? -0.06 : st === 'cloche' ? -0.08 : st === 'bowler' ? 0.08 * (1 - Math.abs(cz)) - 0.015 : 0.04 * (1 - Math.abs(cz)) - 0.03 * Math.max(0, cz);    // козырёк вниз; поля: бока вверх
        pts.push(ix, y0 + 0.005, iz, ox, y0 + droop, oz);
        if (i < n) rim.push(new THREE.Vector3(ox, y0 + droop, oz));
        if (i) { const b = (i - 1) * 2; bi.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      }
      const brim = this._track(new THREE.BufferGeometry());
      brim.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      brim.setIndex(bi); brim.computeVertexNormals();
      group.add(new THREE.Mesh(brim, mat));
      if (st !== 'cap') {                                           // завёрнутый край полей: читается и на тёмном фетре
        const tube = this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim, true), this._q(96, 24), st === 'bowler' ? 0.02 : 0.009, this._q(6, 4), true));
        group.add(new THREE.Mesh(tube, mat));
      }
    }
    if (brimmed) {                                                  // лента на тулье
      const band = this._track(new THREE.TorusGeometry(1, 0.035, this._q(6, 4), this._q(64, 20)));
      band.rotateX(Math.PI / 2);
      const e = ell(y0 + 0.08), m = new THREE.Mesh(band, this._track(new THREE.MeshStandardMaterial({ color: '#1a1410', roughness: 0.6 })));
      m.scale.set(Math.max(e.ax + 0.06, 0.62) * 0.97, 1, Math.max(e.az + 0.06, 0.72) * 0.97); m.position.set(0, y0 + 0.08, e.cz);
      group.add(m);
    }
    this.hat = group; group.userData.batch = true;
    this.headRoot.add(group);
  }

  /** Серьги на мочках ушей (и когда уши закрыты длинными волосами — висят ниже волос). */
  _buildEarrings() {
    const P = this.P, er = P.earrings;
    if (!er) return;
    const w = prof(P.gx, -0.06) * 0.998, es = clamp(w / 0.785, 0.85, 1.1), k = (er.size ?? 1) * es;
    const mat = this._track(new THREE.MeshPhysicalMaterial({ color: er.color || '#e6c36a', metalness: er.style === 'drop' ? 0.1 : 0.95, roughness: er.style === 'drop' ? 0.05 : 0.25, clearcoat: er.style === 'drop' ? 1 : 0, envMapIntensity: 1.6 }));
    for (const sg of [1, -1]) {
      const g = new THREE.Group();
      g.position.set(sg * (w + 0.03), -0.06 - 0.155 * es, -0.03);
      if (er.style === 'hoop') {
        const m = new THREE.Mesh(this._track(new THREE.TorusGeometry(0.05 * k, 0.0055 * k, this._q(8, 4), this._q(40, 14))), mat);
        m.rotation.y = Math.PI / 2; m.position.y = -0.045 * k; g.add(m);
      } else if (er.style === 'drop') {
        const chain = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.0025, 0.0025, 0.05 * k, 6)), this._track(new THREE.MeshStandardMaterial({ color: '#d9b45a', metalness: 0.9, roughness: 0.3 })));
        chain.position.y = -0.025 * k; g.add(chain);
        const gem = new THREE.Mesh(this._track(new THREE.SphereGeometry(0.018 * k, this._q(20, 8), this._q(14, 6))), mat);
        gem.scale.y = 1.35; gem.position.y = -0.068 * k; g.add(gem);
      } else g.add(new THREE.Mesh(this._track(new THREE.SphereGeometry(0.014 * k, this._q(16, 8), this._q(12, 6))), mat));
      g.userData.batch = true; this.headRoot.add(g);
    }
  }

  /**
   * Внешний контур головы с волосами по направлению d (из центра головы): максимум проекции вершин кожи и оболочки
   * волос в узком конусе вокруг d. Нужен, чтобы оголовье и чашки наушников легли поверх причёски.
   */
  _outline(d, cone = 0.985) {
    const C = this._olC ||= new THREE.Vector3(0, -0.05, -0.08);
    if (!this._olPts) {
      const pts = [];
      this.headRoot.traverse((m) => { if (m.isMesh && ['skin', 'hair', 'hairLong'].includes(m.name)) { const a = m.geometry.attributes.position.array; for (let i = 0; i < a.length; i += 6) pts.push(a[i] - C.x, a[i + 1] - C.y, a[i + 2] - C.z); } });
      this._olPts = new Float32Array(pts);
    }
    const p = this._olPts; let best = 0;
    for (let i = 0; i < p.length; i += 3) {
      const l = Math.hypot(p[i], p[i + 1], p[i + 2]); if (l < 1e-6) continue;
      const dt = (p[i] * d.x + p[i + 1] * d.y + p[i + 2] * d.z) / l;
      if (dt > cone && l * dt > best) best = l * dt;
    }
    return C.clone().addScaledVector(d, best);
  }

  /** Наушники (5.12): накладные (оголовье + две чашки), гарнитура (одна чашка + микрофон), вкладыши. */
  _buildHeadphones() {
    const hp = this.P.headphones;
    if (!hp) return;
    const P = this.P, style = hp.style || 'over', col = new THREE.Color(hp.color || '#26282c');
    const mat = this._track(new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 }));
    const soft = this._track(new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.55), roughness: 0.9 }));
    const g = new THREE.Group(); g.name = 'headphones';
    const w = prof(P.gx, -0.06) * 0.998, es = clamp(w / 0.785, 0.85, 1.1);
    if (style === 'earbuds') {
      for (const sg of [1, -1]) {
        const b = new THREE.Group(); b.position.set(sg * (w + 0.035), -0.08, -0.02);
        const bud = new THREE.Mesh(this._track(new THREE.SphereGeometry(0.03 * es, this._q(16, 8), this._q(12, 6))), mat); bud.scale.set(0.8, 1, 1.1); b.add(bud);
        const stem = new THREE.Mesh(this._track(new THREE.CapsuleGeometry(0.011 * es, 0.09 * es, this._q(4, 2), this._q(10, 6))), mat); stem.position.set(sg * 0.008, -0.065 * es, 0.012); stem.rotation.z = sg * 0.12; b.add(stem);
        g.add(b);
      }
      g.userData.batch = true; this.headRoot.add(g); this.headphones = g; return;
    }
    // чашки: по контуру головы с волосами в стороны от ушей
    const sides = style === 'headset' ? [1, -1] : [1, -1];
    const cupAt = {};
    for (const sg of sides) {
      const d = new THREE.Vector3(sg, -0.12, 0.04).normalize(), o = this._outline(d, 0.99);
      const cup = new THREE.Group(); cup.position.set(o.x + sg * 0.03, o.y, o.z); cup.rotation.z = sg * -0.04;
      const R = (style === 'headset' ? 0.13 : 0.165) * es;
      const shell = new THREE.Mesh(this._track(new THREE.CylinderGeometry(R, R * 1.04, 0.075, this._q(32, 12))), mat); shell.rotation.z = Math.PI / 2; shell.position.x = sg * 0.05; cup.add(shell);
      const cap = new THREE.Mesh(this._track(new THREE.SphereGeometry(R * 0.98, this._q(24, 12), this._q(10, 4), 0, Math.PI * 2, 0, 0.5)), mat); cap.rotation.z = -sg * Math.PI / 2; cap.position.x = sg * 0.085; cap.scale.y = 0.6; cup.add(cap);
      const pad = new THREE.Mesh(this._track(new THREE.TorusGeometry(R * 0.82, 0.032, this._q(10, 5), this._q(32, 12))), soft); pad.rotation.y = Math.PI / 2; pad.position.x = sg * 0.006; cup.add(pad);
      g.add(cup); cupAt[sg] = cup.position.clone().add(new THREE.Vector3(sg * 0.05, 0, 0));
    }
    // оголовье: дуга поверх волос от чашки к чашке (в плоскости чуть впереди ушей)
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = lerp(-1.25, 1.25, i / 24), d = new THREE.Vector3(Math.sin(a), Math.cos(a), 0.04).normalize();
      const o = this._outline(d, 0.993).addScaledVector(d, P.hairStyle === 'none' ? 0.03 : 0.07);   // над прядями-карточками
      pts.push(o);
    }
    pts.unshift(cupAt[-1].clone().add(new THREE.Vector3(0.0, 0.17 * es, 0))); pts.push(cupAt[1].clone().add(new THREE.Vector3(0, 0.17 * es, 0)));
    const band = new THREE.Mesh(this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), this._q(80, 24), 0.022, this._q(10, 5), false)), mat); band.scale.z = 1; g.add(band);
    const cushion = new THREE.Mesh(this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.slice(6, -6)), this._q(48, 16), 0.018, this._q(8, 4), false)), soft);
    cushion.position.y = -0.012; g.add(cushion);
    if (style === 'headset') {
      // штанга микрофона: от левой чашки вперёд и вниз к уголку рта
      const c = cupAt[1], MY = LAYOUT.mouthY, tip = new THREE.Vector3(P.mouthHW * 1.15, MY + 0.02, this.hm.get(P.mouthHW * 1.15, MY) + 0.07);
      // путь над щекой: точки по поверхности лица (карта высот) + зазор, от чашки к уголку рта
      const path = [c.clone().add(new THREE.Vector3(0.0, -0.05, 0.1))];
      for (let i = 1; i <= 6; i++) {
        const t = i / 7, x = lerp(c.x - 0.08, tip.x, t), y = lerp(c.y - 0.08, tip.y, t ** 0.8), z = this.hm.get(x, y);
        path.push(new THREE.Vector3(x, y, (z > -1 ? z : c.z) + 0.06 + 0.02 * Math.sin(Math.PI * t)));
      }
      path.push(tip);
      g.add(new THREE.Mesh(this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), this._q(48, 16), 0.009, this._q(8, 4), false)), mat));
      const mic = new THREE.Mesh(this._track(new THREE.CapsuleGeometry(0.02, 0.035, this._q(6, 2), this._q(12, 6))), soft); mic.position.copy(tip); mic.rotation.z = Math.PI / 2 - 0.3; g.add(mic);
    }
    g.userData.batch = true; this.headRoot.add(g); this.headphones = g;
  }

  /**
   * Маска (5.12): ткань от переносицы до подбородка, натянута по «верхней огибающей» лица (в ямки не проваливается),
   * едет за челюстью и морфами кожи (как борода, см. _mouthPoint). Губы и усы под маской скрываются.
   */
  _buildMask() {
    const mk = this.P.mask;
    if (!mk) return;
    const P = this.P, style = mk.style || 'medical', hm = this.hm;
    const cols = Math.round(44 * (this.L.beard + 0.3) / 1.3), rows = Math.round(34 * (this.L.beard + 0.3) / 1.3);
    const x0 = -0.62, x1 = 0.62, yTop = -0.1, yBot = -1.0;
    const eyeY = this.eye.y ?? LAYOUT.eyeY;
    // верхняя огибающая: максимум высоты в окрестности, затем сглаживание — ткань натянута
    const GW = 64, GH = 56, env = new Float32Array(GW * GH), tmp = new Float32Array(GW * GH);
    const gx = (i) => lerp(x0 - 0.05, x1 + 0.05, i / (GW - 1)), gy = (j) => lerp(yTop + 0.05, yBot - 0.08, j / (GH - 1));
    // вне лица карта высот пуста (−10): сдвигаемся к середине до ближайшей точки лица
    const valid = (x, y) => { for (let k = 0; k < 80; k++) { const z = hm.get(x, y); if (z > -1) return [x, z, y]; x *= 0.97; if (k > 40) y += 0.01; } return [x, 0, y]; };
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) env[j * GW + i] = valid(gx(i), gy(j))[1];
    const R = 3;
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { let m = -9; for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < GW && b < GH) m = Math.max(m, env[b * GW + a] - 0.004 * (di * di + dj * dj)); } tmp[j * GW + i] = m; }
    for (let it = 0; it < 3; it++) for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) env[j * GW + i] = (tmp[j * GW + i] * 4 + tmp[j * GW + i - 1] + tmp[j * GW + i + 1] + tmp[(j - 1) * GW + i] + tmp[(j + 1) * GW + i]) / 8, tmp.set(env);
    const envAt = (x, y) => { const fi = clamp(((x - x0 + 0.05) / (x1 - x0 + 0.1)) * (GW - 1), 0, GW - 1.001), fj = clamp(((yTop + 0.05 - y) / (yTop - yBot + 0.13)) * (GH - 1), 0, GH - 1.001); const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j; return lerp(lerp(env[j * GW + i], env[j * GW + i + 1], u), lerp(env[(j + 1) * GW + i], env[(j + 1) * GW + i + 1], u), v); };
    const geo = this._track(dynamicGrid(cols, rows, false));
    const n = (cols + 1) * (rows + 1), rest = new Float32Array(n * 3), wj = new Float32Array(n), col = new Float32Array(n * 3);
    const beardT = P.beard && P.beard.style && P.beard.style !== 'none' ? 0.03 + 0.06 * (P.beard.length ?? 0.3) : 0;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c, u = (c / cols) * 2 - 1, v = r / rows;
      // контур: верх — по переносице и под глазами (дугой), низ — под подбородком; бока уходят к ушам
      const top = yTop - 0.02 - 0.1 * u * u + (style === 'n95' ? 0.02 : 0);
      const xr = u * lerp(0.48, 0.57, Math.sin(Math.PI * v)) * (style === 'n95' ? 0.92 : 1);
      // низ — по линии челюсти: самая низкая точка лица в этом столбце + запас
      let yl = -1.04; while (yl < -0.5 && hm.get(xr, yl) < -1) yl += 0.01;
      const bot = Math.max(yBot + 0.08 * u * u - (style === 'n95' ? 0.02 : 0), yl + 0.035);
      const [x, z0, y] = valid(xr, lerp(top, bot, v));
      let dz = Math.max(0, envAt(x, y) - z0) + 0.014 + beardT * smoothstep(-0.35, -0.6, y);
      if (style === 'medical') dz += 0.004 * Math.sin(v * Math.PI * 6) ** 2 * (1 - Math.abs(u) ** 2);   // складки-гармошка
      if (style === 'n95') dz += 0.06 * Math.sin(Math.PI * v) * (1 - u * u);                        // жёсткая «чашка»
      dz = Math.max(0.007, dz - 0.05 * smoothstep(0.75, 1, Math.abs(u)));                          // края прилегают к щекам, но не уходят под кожу
      // на крутых боках зазор по нормали, а не по глубине: иначе сетка между отсчётами прорезает кожу
      const hx = (hm.get(x + 0.012, y) - hm.get(x - 0.012, y)) / 0.024, hy = (hm.get(x, y + 0.012) - hm.get(x, y - 0.012)) / 0.024;
      if (Math.abs(hx) < 50 && Math.abs(hy) < 50) dz += Math.min(0.09, 0.016 * (Math.sqrt(1 + hx * hx + hy * hy) - 1));
      rest[i * 3] = x; rest[i * 3 + 1] = y; rest[i * 3 + 2] = dz;
      wj[i] = jawWeight(x, y, z0) * smoothstep(-0.42, -0.62, y);
      const sh = 0.9 + 0.1 * Math.cos(u * 1.4);
      col.set([sh, sh, sh], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = this._track(new THREE.MeshPhysicalMaterial({ color: mk.color || '#bcd8ea', roughness: style === 'cloth' ? 0.95 : 0.8, sheen: style === 'cloth' ? 0.5 : 0.2, sheenColor: new THREE.Color('#ffffff'), vertexColors: true, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'mask'; mesh.frustumCulled = false; mesh.renderOrder = 30;          // после губ и усов
    this.headRoot.add(mesh);
    this.maskPart = { mesh, rest, w: wj, cols, rows };
    // резинки к ушам
    const w = prof(P.gx, -0.06) * 0.998, strapMat = this._track(new THREE.MeshStandardMaterial({ color: style === 'cloth' ? mk.color || '#30343c' : '#f4f4f2', roughness: 0.7 }));
    this._maskStraps = [];
    for (const sg of [1, -1]) for (const [vy, ey] of [[0.12, 0.02], [0.88, -0.17]]) {
      const c = sg > 0 ? cols : 0, r = Math.round(vy * rows), i = r * (cols + 1) + c;
      const a = new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], hm.get(rest[i * 3], rest[i * 3 + 1]) + rest[i * 3 + 2]);
      const b = new THREE.Vector3(sg * (w + 0.02), ey, -0.12), m = new THREE.Vector3(sg * (w - 0.02), lerp(a.y, ey, 0.5), lerp(a.z, -0.05, 0.6));
      const s2 = new THREE.Mesh(this._track(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, m, b]), 16, 0.006, 5, false)), strapMat);
      s2.renderOrder = 30; s2.userData.batch = true; this.headRoot.add(s2);
    }
    void eyeY;
  }

  _updateMask() {
    const pt = this.maskPart;
    if (!pt) return;
    const pos = pt.mesh.geometry.attributes.position.array, n = pos.length / 3;
    for (let i = 0; i < n; i++) this._mouthPoint(pt.rest[i * 3], pt.rest[i * 3 + 1], pt.rest[i * 3 + 2], pt.w[i], this._jaw, pos, i * 3);
    pt.mesh.geometry.attributes.position.needsUpdate = true;
    pt.mesh.geometry.computeVertexNormals();
  }

  /** Хвост (сужающаяся трубка от затылка вниз) или пучок (сфера на макушке сзади). */
  _buildHairTail(kind) {
    const P = this.P, tmp = [0, 0, 0];
    const back = (y) => { shapeHead(0, y, -Math.sqrt(Math.max(0, 1 - y * y)), P, tmp); return tmp[2] - 0.03; };
    let geo;
    if (kind === 'bun') {
      geo = this._track(new THREE.SphereGeometry(0.25, 28, 20));
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = 1 + 0.06 * Math.sin(x * 60 + y * 40) * Math.sin(z * 50); p.setXYZ(i, x * n, y * n * 0.8, z * n); }
      geo.translate(0, 0.78, back(0.78) - 0.12);
    } else {
      const pts = [[0, 0.62, back(0.62) + 0.05], [0, 0.48, back(0.48) - 0.12], [0, 0.1, back(0.1) - 0.2], [0, -0.35, back(-0.1) - 0.16], [0, -0.75, back(-0.1) - 0.08]].map((q) => new THREE.Vector3(...q));
      const curve = new THREE.CatmullRomCurve3(pts), seg = 40, rad = 12;
      geo = this._track(new THREE.TubeGeometry(curve, seg, 0.14, rad, false));
      const p = geo.attributes.position;
      for (let i = 0; i <= seg; i++) {
        const t = i / seg, c = curve.getPointAt(t), k = (t < 0.12 ? lerp(0.6, 1.15, t / 0.12) : lerp(1.15, 0.35, (t - 0.12) / 0.88)) * (1 + 0.05 * Math.sin(t * 40));
        for (let j = 0; j <= rad; j++) { const v = i * (rad + 1) + j; p.setXYZ(v, c.x + (p.getX(v) - c.x) * k, c.y + (p.getY(v) - c.y) * k, c.z + (p.getZ(v) - c.z) * k); }
      }
    }
    geo.computeVertexNormals();
    const col = new Float32Array(geo.attributes.position.count * 3).fill(0.85);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo, this.mat.hair);
    m.name = 'hairTail';
    this.headRoot.add(m);
  }

  _buildEars() {
    if (this.P.hairStyle === 'long' && !this.P.ears) return;
    const geo = this._track(new THREE.SphereGeometry(1, this._q(24, 12), this._q(16, 8)));
    const inGeo = this._track(new THREE.SphereGeometry(1, this._q(16, 8), this._q(12, 6)));
    const inMat = this._track(this.mat.neck.clone());
    inMat.color = new THREE.Color(this.P.skin).multiplyScalar(0.6);
    const w = prof(this.P.gx, -0.06) * 0.998, es = clamp(w / 0.785, 0.85, 1.1);   // уши на силуэте головы
    for (const sg of [1, -1]) {
      const ear = new THREE.Mesh(geo, this.mat.neck);
      ear.position.set(sg * (w + 0.02), -0.06, -0.06);
      if (this._warpF) ear.position.fromArray(this._warpF(ear.position.toArray()));
      ear.scale.set(0.06 * es, 0.17 * es, 0.11 * es);
      ear.rotation.y = sg * -0.35;
      const inner = new THREE.Mesh(inGeo, inMat);
      inner.position.set(sg * 0.25, -0.05, 0.1);
      inner.scale.set(0.5, 0.6, 0.6);
      ear.add(inner);
      ear.userData.batch = true; this.headRoot.add(ear);
    }
  }

  /**
   * Борода и усы: оболочки над кожей. Борода едет за челюстью и морфами кожи (веса как у губ, см. _mouthPoint),
   * усы — за верхней губой и рисуются поверх губ. Толщина по маске стиля сходит на нет к краям, края растворяются
   * через alphaHash (дизеринг без сортировки прозрачности).
   */
  _buildBeard() {
    const P = this.P, bd = P.beard;
    if (!bd || (bd.style === 'none' && !bd.moustache)) return;
    const MY = LAYOUT.mouthY, hw = P.mouthHW, L = clamp(bd.length ?? 0.3, 0, 1);
    const color = new THREE.Color(bd.color || P.beardColor || P.hair);
    const lipTop = MY + P.lipU + 0.012, lipBot = MY - P.lipL - 0.012;
    const ss = (a, b, x) => smoothstep(a, b, x);
    const mat = this._track(new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: this._track(hairTexture({ ...hairTone(P, color, P.beardGray ?? P.hairGray), streak: 0 })), roughness: 0.7, sheen: 0.7, sheenRoughness: 0.4,
      sheenColor: hairMean(hairTone(P, color, P.beardGray ?? P.hairGray)).multiplyScalar(2.4).addScalar(0.08), vertexColors: true, alphaHash: true, side: THREE.DoubleSide }));
    mat.map.repeat.set(10, 3);
    this.beard = { parts: [] };
    const part = (name, x0, x1, y0, y1, cols, rows, mask, depth, jaw, extra = {}) => {
      const geo = this._track(dynamicGrid(cols, rows, false));
      const n = (cols + 1) * (rows + 1), col = new Float32Array(n * 4), rest = new Float32Array(n * 3), w = new Float32Array(n);
      for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
        const i = r * (cols + 1) + c, t = clamp(mask(lerp(x0, x1, c / cols), lerp(y1, y0, r / rows)), 0, 1);
        const q = [lerp(x0, x1, c / cols), lerp(y1, y0, r / rows), 0.5];
        if (this._warpF) this._warpF(q);                           // маска — по параметрическим губам, положение — по сдвинутой коже
        // вне лица карта высот пуста (−10): точку — к середине, до лица (иначе при повороте тянутся полосы)
        const bad = this.hm.get(q[0], q[1] - (extra.droop || 0) * t) < -1;   // такие точки ещё и прозрачные (см. col ниже)
        for (let k = 0; k < 80 && this.hm.get(q[0], q[1] - (extra.droop || 0) * t) < -1; k++) { q[0] *= 0.97; if (k > 40) q[1] += 0.01; }
        const x = q[0], y = q[1], z0 = this.hm.get(x, y);
        // под маской борода прижата (иначе торчит сквозь ткань); видна только по краям
        const um = P.mask ? 1 - 0.92 * smoothstep(0.6, 0.48, Math.abs(x)) * smoothstep(-0.06, -0.16, y) * smoothstep(-1.04, -0.94, y) : 1;
        rest[i * 3] = x; rest[i * 3 + 1] = y - (extra.droop || 0) * t; rest[i * 3 + 2] = depth(t, x, y) * um;
        w[i] = jaw ? jawWeight(x, y, z0) : 0;
        const v = lerp(0.55, 1, t) * (0.9 + 0.1 * Math.sin(c * 2.3 + r * 1.7));
        col.set([v, v, v, bad ? 0 : ss(0.02, 0.55, t)], i * 4);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      const mesh = new THREE.Mesh(geo, extra.mat || mat);
      mesh.frustumCulled = false; mesh.name = name;
      mesh.userData.noShadow = true;                               // тень не учитывает alphaHash: вся сетка дала бы тень-прямоугольник
      if (extra.renderOrder) mesh.renderOrder = extra.renderOrder;
      this.headRoot.add(mesh);
      this.beard.parts.push({ mesh, rest, w, cols, rows });
    };
    // маска бороды: граница по щеке (бакенбарды → уголки рта), без губ
    const cheekTop = (ax) => -0.36 + 0.3 * ss(0.25, 0.62, ax);
    // вырез под губы — эллипс по контуру губ с мягким краем
    const lc = (lipTop + lipBot) / 2, lh = (lipTop - lipBot) / 2 + 0.012;
    const lips = (x, y) => ss(1, 1.25, Math.hypot(x / (hw * 1.1), (y - lc) / lh));
    const st = bd.style;
    if (st && st !== 'none') {
      const mask = (x, y) => {
        const ax = Math.abs(x);
        let m = 0;
        if (st === 'full') m = ss(cheekTop(ax), cheekTop(ax) - 0.07, y) * ss(0.66, 0.56, ax);
        else if (st === 'goatee') m = ss(0.28, 0.2, ax) * ss(lipBot + 0.01, lipBot - 0.03, y) * ss(-1.02, -0.9, y);
        else if (st === 'chinstrap') { const top = -0.62 + 0.5 * ss(0.18, 0.62, ax); m = ss(top, top - 0.07, y) * ss(0.66, 0.56, ax); }
        return m * lips(x, y) * ss(-1.2, -1.05, y);
      };
      const depth = (t) => 0.006 + (0.02 + 0.06 * L) * Math.sqrt(t);
      const kb = this.L.beard;                                     // сетка бороды пересчитывается на CPU каждый кадр
      part('beard', -0.68, 0.68, -1.18, -0.06, Math.round(68 * kb), Math.round(56 * kb), mask, depth, true, { droop: 0.07 * L });
    }
    const ms = bd.moustache;
    if (ms) {
      const wide = ms === 'walrus' ? 1.3 : ms === 'pencil' ? 1.0 : 1.15, H = ms === 'pencil' ? 0.02 : ms === 'walrus' ? 0.11 : 0.075;
      const mask = (x, y) => {
        const u = Math.abs(x) / (hw * wide);
        if (u > 1) return 0;
        const low = lipTop - 0.012 - (ms === 'walrus' ? 0.03 * (1 - u * u) + 0.05 * ss(0.6, 1, u) : 0.012 * ss(0.7, 1, u));   // walrus свисает на губу
        const top = lipTop + H * (1 - 0.55 * u * u) - (ms === 'pencil' ? 0 : 0.012 * Math.exp(-((x / 0.025) ** 2)));         // ложбинка под носом
        return ss(low - 0.006, low + 0.022, y) * ss(top + 0.01, top - 0.03, y) * ss(1, 0.7, u);   // мягкая бахрома снизу и у кончиков
      };
      const mmat = this._track(mat.clone());
      mmat.depthTest = false;                                       // поверх губ (они тоже без теста глубины)
      const depth = (t, x, y) => 0.034 + (0.012 + 0.03 * L) * Math.sqrt(t) * (0.75 + 0.25 * Math.cos(Math.min(1, Math.abs(x) / (hw * wide)) * Math.PI / 2));
      part('moustache', -hw * 1.35, hw * 1.35, lipTop - 0.09, lipTop + 0.13, Math.round(40 * this.L.beard), Math.round(20 * this.L.beard), mask, depth, false, { mat: mmat, renderOrder: 25 });
    }
  }

  _updateBeard() {
    if (!this.beard) return;
    const J = this._jaw;
    for (const pt of this.beard.parts) {
      const pos = pt.mesh.geometry.attributes.position.array, n = pos.length / 3;
      for (let i = 0; i < n; i++) this._mouthPoint(pt.rest[i * 3], pt.rest[i * 3 + 1], pt.rest[i * 3 + 2], pt.w[i], J, pos, i * 3);
      pt.mesh.geometry.attributes.position.needsUpdate = true;
      pt.mesh.geometry.computeVertexNormals();
    }
  }

  /** Очки: оправа (трубка по суперэллипсу), перемычка, дужки до ушей, линзы. Двигаются с головой. */
  _buildGlasses() {
    if (!this.P.glasses) return;
    const P = this.P, E = this.eye, g = { ...GLASSES.rect, ...P.glasses };
    const rx = E.rs * 0.97 * (g.size ?? 1.55), ry = rx / (g.aspect ?? 1.3), th = g.thickness ?? 0.008;
    const cy = E.y + (g.dy ?? 0.05) * E.rs;
    // плоскость оправы перед веками и бровями; у переносицы — перед кожей носа
    const zF = Math.max(E.z + E.rs + 0.04, this.hm.get(E.x, E.y + 0.12) + 0.015);
    const zB = Math.max(zF - 0.01, this.hm.get(0, cy + ry * 0.3) + 0.02);
    const frameMat = this._track(new THREE.MeshPhysicalMaterial({ color: g.color, roughness: g.metal ? 0.25 : 0.35, metalness: g.metal ? 0.85 : 0, clearcoat: g.metal ? 0 : 0.6, envMapIntensity: 1.2 }));
    const lensMat = this._track(new THREE.MeshPhysicalMaterial({ color: g.tint || '#ffffff', transparent: true, opacity: g.tint ? 0.78 : 0.07, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.6, depthWrite: false, side: THREE.DoubleSide }));
    const n = g.style === 'round' ? 2 : g.style === 'rect' ? 4.2 : 3;
    // контур линзы в своей плоскости (u — к виску, v — вверх)
    const rim = (t) => {
      const c = Math.cos(t), s = Math.sin(t);
      let u = rx * Math.sign(c) * Math.abs(c) ** (2 / n), v = ry * Math.sign(s) * Math.abs(s) ** (2 / n);
      if (g.style === 'cat') v += ry * 0.28 * Math.max(0, s) * Math.max(0, c) ** 2;           // приподнятый внешний верх
      if (g.style === 'aviator') { if (s < 0) { v *= 1.18; u *= 1 + 0.12 * Math.max(0, c); } else v *= 0.85; }   // «капля»
      return [u, v];
    };
    const group = new THREE.Group(), ends = [];
    group.name = 'glasses';
    for (const sg of [1, -1]) {
      const pts = [];
      for (let i = 0; i < 64; i++) {
        const [u, v] = rim((i / 64) * Math.PI * 2), x = sg * (E.x + u);
        // оправа огибает лицо и нигде не уходит в кожу (у фото-голов скулы и нос выступают по-разному)
        const zz = Math.max(zF - 0.35 * u * u - 0.05 * Math.max(0, sg * x - E.x), this.hm.get(x, cy + v) + 0.03);
        pts.push(new THREE.Vector3(x, cy + v, zz));
      }
      const curve = new THREE.CatmullRomCurve3(pts, true);
      group.add(new THREE.Mesh(this._track(new THREE.TubeGeometry(curve, this._q(96), th, this._q(6, 4), true)), frameMat));
      // линза: веер треугольников от центра
      const lp = [E.x * sg, cy, zF - 0.004], pos = [];
      for (let i = 0; i < 64; i++) { const a = pts[i], b = pts[(i + 1) % 64]; pos.push(...lp, a.x, a.y, a.z - 0.003, b.x, b.y, b.z - 0.003); }
      const lg = this._track(new THREE.BufferGeometry());
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      lg.computeVertexNormals();
      const lens = new THREE.Mesh(lg, lensMat);
      lens.renderOrder = 30;
      group.add(lens);
      // дужка: от внешнего края оправы назад к уху по боку головы
      const h0 = pts[2], hx = h0.x, side = Math.sqrt(Math.max(0, 1 - cy * cy)) * prof(P.gx, cy) + 0.02, v0 = h0.y - cy;
      ends.push(pts[Math.round(64 * 0.44)]);
      const arm = new THREE.CatmullRomCurve3([
        h0.clone(),
        new THREE.Vector3(sg * Math.max(Math.abs(hx) + 0.02, side * 0.97), cy + v0 * 0.6, zF - 0.12),
        new THREE.Vector3(sg * side, cy - 0.01, 0.2),
        new THREE.Vector3(sg * side * 0.98, cy - 0.05, -0.05),
      ]);
      group.add(new THREE.Mesh(this._track(new THREE.TubeGeometry(arm, this._q(24, 8), th * 0.8, this._q(5, 4), false)), frameMat));
    }
    // перемычка над переносицей
    const [a, b] = ends;
    const bridge = new THREE.CatmullRomCurve3([a.clone(), new THREE.Vector3(0, (a.y + b.y) / 2 + ry * 0.12, Math.max(zB, this.hm.get(0, a.y + ry * 0.12) + 0.025)), b.clone()]);
    group.add(new THREE.Mesh(this._track(new THREE.TubeGeometry(bridge, this._q(16, 6), th * 0.9, this._q(6, 4), false)), frameMat));
    group.traverse((m) => { if (m.isMesh) m.userData.noShadow = m.material === lensMat; });
    this.glasses = group;
    this.headRoot.add(group);
  }

  _buildBody() {
    const P = this.P;
    const r = P.neckR;
    const top = P.hairStyle === 'long' ? -1.56 : -1.38;
    const topR = P.hairStyle === 'long' ? r * 2.05 : r * 1.45;
    const clothPts = [[topR * 0.97, top + 0.02], [topR, top], [topR * 1.02, top - 0.03], [1.05, -1.74], [1.36, -1.9], [1.55, -2.15], [1.64, -2.6], [1.66, -3.4]];
    const outfit = OUTFITS[P.outfit] ? P.outfit : null;
    // шея; под вырезом одежды кожа груди повторяет профиль торса (чуть глубже), иначе в V-вырезе видна «пустота»
    const Rof = (y) => {                                                // радиус торса на высоте y (по профилю)
      if (y >= clothPts[1][1]) return topR;
      for (let i = 1; i < clothPts.length - 1; i++) {
        const [r0, y0] = clothPts[i], [r1, y1] = clothPts[i + 1];
        if (y <= y0 && y >= y1) return lerp(r0, r1, (y0 - y) / (y0 - y1));
      }
      return clothPts[clothPts.length - 1][0];
    };
    const neckPts = (outfit && outfit !== 'crew' && outfit !== 'turtleneck' && outfit !== 'hoodie'
      ? [[r, -0.45], [r * 0.97, -0.9], [r * 1.05, -1.25], [r * 1.5, -1.5], ...[-1.62, -1.74, -1.9, -2.15, -2.6].map((y) => [Math.max(r * 1.5, Rof(y) * 0.965), y])]
      : [[r, -0.45], [r * 0.97, -0.9], [r * 1.05, -1.25], [r * 1.5, -1.5], [r * 2.6, -1.72], [r * 3.6, -1.92]]).map(([x, y]) => new THREE.Vector2(x, y));
    const neckGeo = this._track(new THREE.LatheGeometry(neckPts, 48));   // шея и ворот — одинаковые грани на всех уровнях (иначе кожа просвечивает у ворота)
    neckGeo.scale(1, 1, 0.6);
    let neckMat = this.mat.neck;
    if (!this.shadows) {
      // без карты теней (low, shadows: false): тень головы на шее запекается в цвет вершин — темнее под подбородком спереди
      const p = neckGeo.attributes.position, col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i), z = p.getZ(i) / 0.6, front = smoothstep(-0.2, 0.25, z / Math.max(0.05, Math.hypot(p.getX(i), z)));
        const k = 1 - 0.42 * front * smoothstep(-1.45, -0.95, y) * smoothstep(-0.45, -0.85, y) - 0.12 * smoothstep(-1.35, -1.6, y) * front;
        col.set([k, k, k * 0.98], i * 3);
      }
      neckGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      neckMat = this._track(Object.assign(this.mat.neck.clone(), { vertexColors: true }));
      for (const pt of this.mat.neck.userData.patches || []) if (pt.fn) addShaderPatch(neckMat, pt.key, pt.fn, pt.safe);
    }
    const neck = new THREE.Mesh(neckGeo, neckMat);
    neck.position.set(0, 0, -0.15);
    this.body.add(neck);
    if (!outfit) {                                                      // по умолчанию — прежний круглый ворот (тело вращения)
      const clothGeo = this._track(new THREE.LatheGeometry(clothPts.map(([x, y]) => new THREE.Vector2(x, y)), 64));
      clothGeo.scale(1, 1, 0.6);
      this.torso = new THREE.Mesh(clothGeo, this.mat.cloth);
      this.torso.position.set(0, 0, -0.15);
      this.body.add(this.torso);
      return;
    }
    this._buildOutfit(outfit, { r, top, topR, Rof });
  }

  /**
   * Одежда (5.11): торс — сетка по углу вокруг тела φ (0 — перед) и высоте, верхний край — вырез top(φ).
   * Поверх: воротник рубашки, лацканы и галстук (пиджак), капюшон со шнурками (худи), высокое горло (водолазка).
   */
  _buildOutfit(outfit, { r, top, topR, Rof }) {
    const P = this.P, V3 = THREE.Vector3, O = OUTFITS[outfit];
    const surf = (phi, y, k = 1, dr = 0) => { const R = Rof(y) * k + dr; return new V3(R * Math.sin(phi), y, R * Math.cos(phi) * 0.6 - 0.15); };
    const radial = (phi) => new V3(Math.sin(phi), 0, Math.cos(phi) * 0.6).normalize();
    const vcut = (depth, w, pow = 1.1) => (phi) => top - depth * Math.max(0, 1 - Math.abs(phi) / w) ** pow;
    const mat2 = this._track(new THREE.MeshStandardMaterial({ color: P.cloth2 || O.cloth2 || '#e9e7e2', roughness: 0.75, side: THREE.DoubleSide }));
    const add = (geo, mat) => { geo.computeVertexNormals(); const m = new THREE.Mesh(this._track(geo), mat); this.body.add(m); return m; };
    // сетка-полоса: rows — массивы точек одинаковой длины (closed — замкнуть по столбцам)
    const strip = (rows, closed = false) => {
      const n = rows[0].length, pos = [], idx = [];
      for (const row of rows) for (const p of row) pos.push(p.x, p.y, p.z);
      const cols = closed ? n : n - 1;
      for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < cols; j++) {
        const a = i * n + j, b = i * n + ((j + 1) % n), c = a + n, d = b + n;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      return g;
    };
    // торс с вырезом topFn; k — масштаб радиуса (нижний слой — чуть внутри)
    const torso = (topFn, k = 1, mat = this.mat.cloth, phiMax = Math.PI) => {
      const N = this._q(112, 40), ROWS = this._q(44, 18), rows = [];
      const full = phiMax >= Math.PI;
      for (let i = 0; i <= ROWS; i++) {
        const v = i / ROWS, row = [];
        for (let j = 0; j < (full ? N : N + 1); j++) {
          const phi = full ? (j / N) * Math.PI * 2 - Math.PI : -phiMax + (2 * phiMax * j) / N;
          const t0 = topFn(phi), y = lerp(t0, -3.4, v ** 1.7);
          const p = surf(phi, y, k);
          if (i === 0) p.add(radial(phi).multiplyScalar(-0.012));       // кромка выреза чуть загнута внутрь
          row.push(p);
        }
        rows.push(row);
      }
      const geo = strip(rows, full);
      return add(geo, mat);
    };
    // кромка выреза — тонкий валик
    const rim = (topFn, mat = this.mat.cloth, rad = 0.016, phiA = -Math.PI, phiB = Math.PI, k = 1) => {
      const pts = [];
      for (let j = 0; j <= 96; j++) { const phi = lerp(phiA, phiB, j / 96); pts.push(surf(phi, topFn(phi), k, 0.004)); }
      const closed = phiB - phiA >= Math.PI * 2 - 1e-6;
      if (closed) pts.pop();
      return add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed), this._q(160, 48), rad, this._q(6, 4), closed), mat);
    };
    // воротник рубашки: стойка + отворот, к переду — уголки; phi0 — половина ширины выреза спереди
    const collar = (topFn, mat, phi0, k = 1, h = 0.085, fall = 0.12, point = 0.13) => {
      const rows = [[], [], [], []];
      for (let j = 0; j <= 80; j++) {
        const side = j <= 40 ? -1 : 1, u = j <= 40 ? j / 40 : (80 - j) / 40;   // 0 — сзади, 1 — у выреза
        const phi = side * lerp(Math.PI, phi0, u), yt = topFn(phi), front = smoothstep(0.6, 1, u);
        const base = surf(phi, yt, k, 0.006), rd = radial(phi);
        const stand = base.clone().add(new V3(0, h * (1 - 0.35 * front), 0)).addScaledVector(rd, 0.012);
        const fold = stand.clone().addScaledVector(rd, 0.035).add(new V3(0, 0.008, 0));
        const lie = surf(phi + side * 0.22 * front, yt - 0.03 - point * front ** 1.5, k, 0.016 + 0.01 * front).addScaledVector(rd, fall * (1 - front) * 0.4);
        rows[0].push(base); rows[1].push(stand); rows[2].push(fold); rows[3].push(lie);
      }
      // порядок строк в 80-м столбце и в 0-м совпадает (сзади): полоса не замкнута, шов сзади закрыт стойкой
      return add(strip(rows), mat);
    };

    if (outfit === 'crew' || outfit === 'turtleneck' || outfit === 'hoodie') {
      const fn = () => top;
      torso(fn); rim(fn);
    }
    if (outfit === 'turtleneck') {
      const pts = [[r * 1.12, -0.9], [r * 1.22, -0.93], [r * 1.17, -0.98], [r * 1.2, -1.1], [r * 1.3, -1.22], [topR * 0.93, top + 0.06]].map(([x, y]) => new THREE.Vector2(x, y));
      const g = new THREE.LatheGeometry(pts, this._q(48, 24)); g.scale(1, 1, 0.6); g.translate(0, 0, -0.15);
      add(g, this.mat.clothSide ||= this._track(Object.assign(this.mat.cloth.clone(), { side: THREE.DoubleSide })));
    }
    if (outfit === 'vneck' || outfit === 'scoop') {
      const fn = outfit === 'vneck' ? vcut(0.36, 0.55) : (phi) => top - 0.24 * Math.max(0, Math.cos((phi / 1.05) * Math.PI / 2)) ** 1.6 * (Math.abs(phi) < 1.05 ? 1 : 0);
      torso(fn); rim(fn);
    }
    if (outfit === 'shirt') {
      const fn = vcut(0.26, 0.4);
      torso(fn); collar(fn, this.mat.clothSide ||= this._track(Object.assign(this.mat.cloth.clone(), { side: THREE.DoubleSide })), 0.38, 1, 0.09, 0.14, 0.2);
      // планка с пуговицами
      const btn = this._track(new THREE.MeshStandardMaterial({ color: new THREE.Color(P.cloth).multiplyScalar(0.8), roughness: 0.4 }));
      for (let i = 0; i < 4; i++) {
        const y = top - 0.24 - i * 0.22, p = surf(0, y, 1, 0.008);
        const b = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 12)), btn);
        b.rotation.x = Math.PI / 2; b.position.copy(p); this.body.add(b);
      }
    }
    if (outfit === 'blazer') {
      const shirtFn = vcut(0.1, 0.24), jacketFn = vcut(0.62, 0.62, 1.05);
      torso(shirtFn, 0.985, mat2, 1.3);                                // рубашка — только спереди, под пиджаком
      collar(shirtFn, mat2, 0.22, 0.985, 0.075, 0.08, 0.1);
      torso(jacketFn);
      // лацканы: полосы вдоль краёв выреза пиджака, отворот к плечу; сверху переходят в воротник пиджака
      for (const sg of [-1, 1]) {
        const inner = [], outer = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24, phi = sg * 0.62 * (1 - t) ** 0.95, y = jacketFn(phi);
          const wd = 0.17 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) + 0.03;
          inner.push(surf(phi, y, 1, 0.012));
          outer.push(surf(phi + sg * wd / Math.max(0.5, Rof(y)), y + 0.02 * (1 - t), 1, 0.02));
        }
        add(strip([inner, outer]), this.mat.lapel ||= this._track(Object.assign(this.mat.cloth.clone(), { side: THREE.DoubleSide, color: new THREE.Color(P.cloth).multiplyScalar(0.82), roughness: 0.6 })));
      }
      collar((phi) => (Math.abs(phi) > 0.62 ? top : jacketFn(phi)), this.mat.clothSide, 0.62, 1.01, 0.09, 0.1, 0.05);
      const tie = P.tie === undefined ? O.tie && this.gender === 'male' : P.tie;
      if (tie) {
        const tm = this._track(new THREE.MeshStandardMaterial({ color: typeof tie === 'string' ? tie : '#6e1c28', roughness: 0.55, side: THREE.DoubleSide }));
        const yk = shirtFn(0) - 0.035;
        const knot = new THREE.Mesh(this._track(new THREE.SphereGeometry(1, 12, 8)), tm);
        knot.scale.set(0.045, 0.05, 0.025); knot.position.copy(surf(0, yk, 0.985, 0.022)); this.body.add(knot);
        const L = [], R = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16, y = yk - 0.04 - t * 0.85, w = lerp(0.035, 0.075, Math.min(1, t * 1.6)) / Math.max(0.5, Rof(y));
          L.push(surf(-w, y, 0.985, 0.014)); R.push(surf(w, y, 0.985, 0.014));
        }
        add(strip([L, R]), tm);
      }
    }
    if (outfit === 'hoodie') {
      // капюшон, сложенный за шеей: толстый валик по задней части выреза, к переду тоньше
      const pts = [];
      for (let j = 0; j <= 40; j++) { const phi = lerp(0.5, Math.PI * 2 - 0.5, j / 40); pts.push({ phi, c: surf(phi, top + 0.06, 1, 0.07) }); }
      const ring = [];
      for (let j = 0; j < pts.length; j++) {
        const { phi, c } = pts[j], u = Math.abs(j / 40 - 0.5) * 2, rad = lerp(0.2, 0.06, u ** 1.5);
        const rd = radial(phi), row = [];
        for (let k = 0; k <= 10; k++) { const a = (k / 10) * Math.PI * 2; row.push(c.clone().addScaledVector(rd, Math.cos(a) * rad).add(new V3(0, Math.sin(a) * rad * 0.8, 0))); }
        ring.push(row);
      }
      const T = ring[0].map((_, k) => ring.map((row) => row[k]));          // строки — по окружности сечения
      add(strip(T), this.mat.clothSide ||= this._track(Object.assign(this.mat.cloth.clone(), { side: THREE.DoubleSide })));
      for (const sg of [-1, 1]) {
        const a = surf(sg * 0.42, top - 0.01, 1, 0.02), b = surf(sg * 0.38, top - 0.42, 1, 0.022), m = surf(sg * 0.43, top - 0.2, 1, 0.03);
        add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, m, b]), 16, 0.009, 6, false), mat2);
        const tip = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 8)), mat2); tip.position.copy(b).add(new V3(0, -0.02, 0)); this.body.add(tip);
      }
    }
    this.torso = this.body.children[1] || null;
  }

  /** Разрешение сеток одежды и аксессуаров по уровню детализации (6.3): n·acc, не меньше min. */
  _q(n, min = 3) { return Math.max(min, Math.round(n * (this.L.acc ?? 1))); }

  /**
   * Склейка мешей ради числа вызовов отрисовки (6.2). Меши с одним материалом сливаются в один: неподвижные
   * относительно root — в обычный меш, подвижные (веки, нижняя челюсть) — в SkinnedMesh, где каждая вершина
   * жёстко привязана к кости своей подвижной части (movers). Исходные объекты остаются как узлы-«кости»
   * (их по-прежнему поворачивает update), но сами не рисуются: им ставится невидимый материал.
   * Не трогаем: динамические сетки (пересчёт на CPU), морфы, материалы со своим шейдером (onBeforeCompile).
   */
  _batch(root, meshes, movers = new Set(), { colorMerge = false } = {}) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert(), groups = new Map();
    // colorMerge: материалы одного типа, различающиеся только цветом, — в один (цвет переходит в цвет вершин)
    const r1 = (v) => Math.round((v ?? 0) * 10) / 10;
    const sig = (m) => !colorMerge || m.map || m.normalMap || m.alphaMap || m.transparent ? m.uuid
      : [m.type, m.depthTest, m.depthWrite, m.stencilWrite, m.stencilFunc, m.stencilRef, m.alphaHash, m.alphaToCoverage, m.blending, Math.round((m.metalness ?? 0) * 2), Math.round((m.clearcoat ?? 0) * 2), (m.sheen ?? 0) > 0, m.emissive?.getHex() ?? 0].join('|');   // шероховатость усредняется, сторона — двусторонняя при расхождении
    for (const m of meshes) {
      if (!m.isMesh || m.isSkinnedMesh || !m.visible || m.material === HIDDEN_MAT) continue;
      const g = m.geometry, mat = m.material;
      const ownShader = Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile') && !(mat.userData.patches?.length && mat.userData.patches.every((q) => q.safe));
      if (g.morphAttributes.position || g.attributes.position.usage === THREE.DynamicDrawUsage || ownShader) continue;
      const key = sig(mat);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const frameOf = (m) => { for (let p = m; p && p !== root; p = p.parent) if (movers.has(p)) return p; return root; };
    let saved = 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const mats = [...new Set(list.map((m) => m.material))], bake = mats.length > 1;
      let mat = mats[0];
      if (bake) {
        const patches = mat.userData.patches;
        mat = this._track(mat.clone()); mat.vertexColors = true; mat.color.set('#ffffff');
        for (const pt of patches || []) if (pt.fn) addShaderPatch(mat, pt.key, pt.fn, pt.safe);   // вставки в шейдер клон не наследует
        const area = mats.map((q) => list.filter((m) => m.material === q).reduce((a, m) => a + (m.geometry.index?.count ?? m.geometry.attributes.position.count), 0));
        const avg = (k) => mats.reduce((a, q, i) => a + (q[k] ?? 0) * area[i], 0) / area.reduce((a, b) => a + b, 0);
        mat.roughness = avg('roughness'); if ('envMapIntensity' in mat) mat.envMapIntensity = avg('envMapIntensity');
        if (new Set(mats.map((q) => q.side)).size > 1) mat.side = THREE.DoubleSide;
      }
      const frames = [...new Set(list.map(frameOf))], skinned = frames.length > 1 || frames[0] !== root;
      const needC = !!mat.vertexColors, needUv = !!(mat.map || mat.normalMap || mat.alphaMap || mat.roughnessMap);
      const cs = needC && list.some((m) => m.geometry.attributes.color?.itemSize === 4) ? 4 : 3;
      const P = [], N = [], C = [], U = [], SI = [], SW = [], I = [];
      const M4 = new THREE.Matrix4(), N3 = new THREE.Matrix3(), v = new THREE.Vector3();
      for (const m of list) {
        let g = m.geometry;
        if (!g.attributes.normal) { g = g.clone(); g.computeVertexNormals(); }
        M4.multiplyMatrices(inv, m.matrixWorld); N3.getNormalMatrix(M4);
        const ca = m.material.vertexColors ? g.attributes.color : null, mc = bake ? m.material.color : null;
        const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, base = P.length / 3, fi = frames.indexOf(frameOf(m));
        for (let i = 0; i < pa.count; i++) {
          v.fromBufferAttribute(pa, i).applyMatrix4(M4); P.push(v.x, v.y, v.z);
          v.fromBufferAttribute(na, i).applyMatrix3(N3).normalize(); N.push(v.x, v.y, v.z);
          if (needC) for (let k = 0; k < cs; k++) C.push((ca ? (k < ca.itemSize ? ca.array[i * ca.itemSize + k] : 1) : 1) * (mc && k < 3 ? [mc.r, mc.g, mc.b][k] : 1));
          if (needUv) U.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);
          if (skinned) { SI.push(fi, 0, 0, 0); SW.push(1, 0, 0, 0); }
        }
        if (g.index) for (let k = 0; k < g.index.count; k++) I.push(base + g.index.getX(k)); else for (let k = 0; k < pa.count; k++) I.push(base + k);
        if (g !== m.geometry) g.dispose();
      }
      const geo = this._track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      if (needC) geo.setAttribute('color', new THREE.Float32BufferAttribute(C, cs));
      if (needUv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      geo.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
      let mesh;
      if (skinned) {
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
        const bones = frames.map((f) => { const b = new THREE.Bone(); f.add(b); return b; });
        mesh = new THREE.SkinnedMesh(geo, mat);
        root.add(mesh); root.updateMatrixWorld(true);
        mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
      } else { mesh = new THREE.Mesh(geo, mat); root.add(mesh); }
      mesh.name = 'batch';
      mesh.frustumCulled = false;
      mesh.renderOrder = Math.min(...list.map((m) => m.renderOrder));
      mesh.userData.noShadow = list.every((m) => m.userData.noShadow);
      for (const m of list) { m.material = HIDDEN_MAT; m.castShadow = m.receiveShadow = false; m.userData.noShadow = true; }
      saved += list.length - 1;
    }
    return saved;
  }

  /** Все склейки головы: глаза (веки — кости), зубы и дёсны (нижняя челюсть — кость), неподвижные аксессуары, очки, тело. */
  _batchAll() {
    if (this.P.batch === false) return;                          // отладка: look.batch = false — без склейки
    const eyeMovers = new Set(), eyeMeshes = [];
    for (const e of this.eyes) { eyeMovers.add(e.up); eyeMovers.add(e.lo); e.group.traverse((o) => { if (o.isMesh && o !== e.ball) eyeMeshes.push(o); }); }
    let saved = this._batch(this.headRoot, eyeMeshes, eyeMovers, { colorMerge: true });
    const M = this.mouth;
    if (M?.jaw) saved += this._batch(this.headRoot, [M.teethU, M.teethL, M.gumsU, M.gumsL, M.bracesU, M.bracesL].filter(Boolean), new Set([M.jaw]));
    const acc = [];
    for (const c of this.headRoot.children) if (c.userData.batch) c.traverse((o) => { if (o.isMesh) acc.push(o); });
    saved += this._batch(this.headRoot, acc, undefined, { colorMerge: true });
    if (this.glasses) { const gl = []; this.glasses.traverse((o) => { if (o.isMesh) gl.push(o); }); saved += this._batch(this.glasses, gl, undefined, { colorMerge: true }); }
    const body = []; this.body.traverse((o) => { if (o.isMesh) body.push(o); });
    saved += this._batch(this.body, body, undefined, { colorMerge: true });
    // динамические пары (пересчёт на CPU каждый кадр): после пересчёта вершины копируются в общий буфер
    this._dyn = [];
    const dyn = (list) => {
      list = list.filter(Boolean);
      if (list.length < 2 || list.some((m) => m.parent !== list[0].parent || m.material !== list[0].material || !m.matrix.equals(list[0].matrix))) return 0;
      for (const m of list) if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();   // у динамических сеток нормали появляются только в первом кадре
      const geo = this._track(new THREE.BufferGeometry()), names = ['position', 'normal', 'color', 'uv'].filter((k) => list.every((m) => m.geometry.attributes[k]));
      for (const k of names) {
        const n = list.reduce((a, m) => a + m.geometry.attributes[k].array.length, 0), arr = new Float32Array(n);
        let o = 0; for (const m of list) { arr.set(m.geometry.attributes[k].array, o); o += m.geometry.attributes[k].array.length; }
        const at = new THREE.BufferAttribute(arr, list[0].geometry.attributes[k].itemSize);
        if (k === 'position' || k === 'normal') at.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(k, at);
      }
      const I = []; let base = 0;
      for (const m of list) { const g = m.geometry; for (let i = 0; i < g.index.count; i++) I.push(base + g.index.getX(i)); base += g.attributes.position.count; }
      geo.setIndex(I);
      const mesh = new THREE.Mesh(geo, list[0].material);
      mesh.name = 'batchDyn'; mesh.frustumCulled = false; mesh.renderOrder = Math.min(...list.map((m) => m.renderOrder));
      mesh.userData.noShadow = list.every((m) => m.userData.noShadow);
      mesh.position.copy(list[0].position); mesh.quaternion.copy(list[0].quaternion); mesh.scale.copy(list[0].scale);
      list[0].parent.add(mesh);
      for (const m of list) { m.material = HIDDEN_MAT; m.castShadow = m.receiveShadow = false; m.userData.noShadow = true; }
      this._dyn.push({ mesh, list });
      return list.length - 1;
    };
    saved += dyn(this.brows.map((b) => b.mesh));
    saved += dyn([M?.lipU, M?.lipL]);
    this.batchSaved = saved;
  }

  /** Копия пересчитанных на CPU вершин в склеенные динамические меши (см. _batchAll). */
  _syncDyn() {
    for (const { mesh, list } of this._dyn || []) {
      for (const k of ['position', 'normal']) {
        const dst = mesh.geometry.attributes[k]; if (!dst) continue; let o = 0;
        for (const m of list) { const a = m.geometry.attributes[k]?.array; if (a) dst.array.set(a, o); o += a ? a.length : 0; }
        dst.needsUpdate = true;
      }
      mesh.visible = list.some((m) => m.visible);
    }
  }

  // ------------------------------------------------------------------ кадр
  /**
   * @param {Object<string,number>} ch  ARKit-каналы 0..1
   * @param {object} pose  { pitch, yaw, roll, eyeYaw, eyePitch, breath, focus }
   */
  update(ch, pose) {
    // morph targets
    const inf = this.skin.morphTargetInfluences, dict = this.skin.morphTargetDictionary;
    const cs = this._morphList === MORPH_LIST_LITE ? foldLite(ch, (this._chLite ||= {})) : ch;
    for (const name in dict) inf[dict[name]] = cs[name] || 0;

    // зрачок (2.8): pose.pupil −1…1.5 → масштаб exp(0.55·v): 0.5…2.3 от нарисованного
    if (this._pupilU) this._pupilU.value = Math.exp(0.55 * clamp(pose.pupil || 0, -1.2, 1.5));
    // голова
    this.headPivot.rotation.set(pose.pitch, pose.yaw, pose.roll);
    this._updateHairSwing(pose);
    // губы и усы рисуются без теста глубины (поверх полости рта) — со спины их прячем, иначе просвечивают сквозь затылок
    const facing = Math.cos(pose.yaw) * Math.cos(pose.pitch) > 0.05;
    if (this.mouth.lipU) this.mouth.lipU.visible = this.mouth.lipL.visible = facing && !this.maskPart;   // под маской губ не видно (они без теста глубины)
    for (const pt of this.beard?.parts || []) if (pt.mesh.name === 'moustache') pt.mesh.visible = facing && !pt.mesh.userData.hidden && !this.maskPart;   // hidden — скрыты снаружи (кадр для метрики)
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
      // веки следуют за взглядом: вниз верхнее веко почти «едет» за зрачком, вверх — меньше; нижнее — слабее
      // асимметрия глаз (2.10): раскрытие щели (множитель) и её высота (сдвиг обоих век, градусы) — у каждого глаза свои
      const oS = (e.sg > 0 ? P.eyeOpenL : P.eyeOpenR) ?? 1, lift = (e.sg > 0 ? P.eyeLiftL : P.eyeLiftR) ?? 0;
      const lower = P.lowerOpen * oS + lift + 13 * sq + 9 * chs + 3 * sm - 4 * wide + pitchDeg * (pitchDeg > 0 ? 0.4 : 0.22);
      const open = P.upperOpen * oS + lift + 18 * wide - 7 * sq - 5 * bd + 3 * bu + pitchDeg * (pitchDeg > 0 ? 0.55 : 0.85);
      const upper = Math.max(lower + 1.2, lerp(open, lower + 1.5, clamp(blink, 0, 1)));
      e.up.rotation.x = -upper * DEG;
      e.lo.rotation.x = -lower * DEG;
    }

    this._activeMorphs = [];
    for (const m of this._morphList) {
      const w = cs[m.name] || 0;
      if (!m.jaw && w > 0.002) this._activeMorphs.push({ fn: m.fn, sg: m.sg, w });
    }
    this._updateBrows(ch);
    this._updateMouth(ch);
    this._updateBeard();
    this._updateMask();
    this._syncDyn();
  }

  /** Преломление в роговице вкл/выкл (кадры для измерений рендерятся без него — см. EmotionalHead._shotFace). */
  setCornea(on) { if (this._corneaU) this._corneaU.value = on ? 1 : 0; }

  /**
   * Пружина раскачки волос (1.9): смещение кончиков d в системе головы. Масса «помнит» положение в мире —
   * при повороте головы кончики отстают, потом догоняют с затуханием; гравитация тянет их вниз мира
   * при наклоне. pose.still — сразу равновесие (детерминированные кадры renderStill).
   */
  _updateHairSwing(pose) {
    const S = (this._swing ||= { d: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), t: 0, init: false, tmp: new THREE.Vector3(), tgt: new THREE.Vector3() });
    const q = new THREE.Quaternion().setFromEuler(this.headPivot.rotation);
    const qi = q.clone().invert();
    // гравитация в системе головы: при наклоне длинные волосы свисают «вниз мира»
    S.tgt.set(0, -1, 0).applyQuaternion(qi).sub(new THREE.Vector3(0, -1, 0)).multiplyScalar(0.18);
    const now = performance.now() / 1000, dt = S.init ? Math.min(0.05, Math.max(0, now - S.t)) : 0;
    S.t = now;
    if (pose.still || !S.init) { S.d.copy(S.tgt); S.v.set(0, 0, 0); S.init = true; }
    else if (dt > 0) {
      // поворот головы за кадр: точка R + d, неподвижная в мире, в новой системе головы
      const R = S.tmp.set(0, -0.45, -0.55);                            // типичный кончик относительно шарнира шеи
      const w = R.clone().add(S.d).applyQuaternion(qi.clone().multiply(S.q)).sub(R);   // q⁻¹·q_prev·(R + d) − R
      S.d.lerp(w, 0.85);                                               // не вся масса отстаёт (корни держат)
      const k = 55, c = 2 * Math.sqrt(k) * 0.45;                    // недодемпфирована: одно-два качания и покой
      S.v.addScaledVector(S.tgt.clone().sub(S.d).multiplyScalar(k).addScaledVector(S.v, -c), dt);
      S.d.addScaledVector(S.v, dt);
      if (S.d.length() > 0.22) S.d.setLength(0.22);
    }
    S.q.copy(q);
    this._hairU?.uHairSwing.value.copy(S.d);
  }

  dispose() {
    this.object3D.removeFromParent();
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
  }
}
