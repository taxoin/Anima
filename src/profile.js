/**
 * profile.js — глубина лица по снимку в профиль (7.5): выступ носа, глубина переносицы, горбинка, вздёрнутость,
 * губы относительно E-линии, ямка под губой, выпуклость профиля (подбородок).
 *
 * Один снимок анфас не даёт глубины: у MediaPipe она — шаблон и мимика (проверено в 4.5). Профиль даёт её прямо:
 * передний контур головы. Контур снимка — по многоклассовому сегментатору MediaPipe (кожа лица / волосы / фон),
 * край уточняется по градиенту изображения. Тот же контур у модели считается по форме черепа (profileCurve).
 * Контур снимка совмещается с контуром модели подобием (масштаб, поворот, сдвиг — размер и наклон головы на снимке
 * не важны), параметры подгоняются по невязкам совмещённых контуров (Левенберг — Марквардт по быстрой кривой модели).
 * Точки профиля (переносица, кончик носа, губы, подбородок) и меры по ним — для отчёта (profilePoints).
 *
 *   const prof = await analyzeProfile(fileOrUrl);              // { curve, side, warnings }
 *   const fit = fitProfile(prof.curve, gender, overrides);     // { params: { nose, noseRoot, noseHump, noseUp, lipPro, lipDepthL, chin }, rms, reliable }
 */
import { profileCurve } from './head-model.js';
import { PHOTO_ASSETS, toCanvas, loadMulti, detectFace } from './photo-avatar.js';

/** Параметры, которые подгоняются по профилю: [имя, мин, макс, шаг для производной]. */
export const PROFILE_PARAMS = [
  ['nose', 0.06, 0.32, 0.01], ['noseRoot', -1, 1.5, 0.1], ['noseHump', -1, 1.2, 0.1], ['noseUp', -1, 1.5, 0.1],
  ['lipPro', -1.2, 1.6, 0.1], ['lipDepthL', -1, 1.5, 0.1], ['chin', -0.03, 0.2, 0.01],
];

// ------------------------------------------------------------------ точки и меры (общие для снимка и модели)

/** Гауссово сглаживание с пропусками (NaN). */
function smooth(a, sigma) {
  const n = a.length, out = new Float64Array(n), R = Math.ceil(sigma * 2.5), w = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = -R; k <= R; k++) { const j = i + k; if (j >= 0 && j < n && Number.isFinite(a[j])) { s += a[j] * w[k + R]; ws += w[k + R]; } }
    out[i] = ws > 0.3 ? s / ws : NaN;
  }
  return out;
}

/**
 * Точки профиля по контуру: y — высота (вверх), a — выступ вперёд (одни единицы), оба массива сверху вниз или снизу
 * вверх — неважно. ok[i] — достоверна ли точка (не волосы, не борода). Возвращает точки { g, n, prn, sn, ls, sto, li, sm, pog }
 * как [y, a] и меры. Окна поиска — в долях высоты лица F (от лба до низа подбородка по контуру).
 */
export function profilePoints(ys, as, ok = null) {
  // сортировка по высоте сверху вниз
  const idx = [...ys.keys()].filter((i) => Number.isFinite(as[i])).sort((p, q) => ys[q] - ys[p]);
  if (idx.length < 40) return null;
  const y = idx.map((i) => ys[i]), a0 = idx.map((i) => as[i]), good = idx.map((i) => (ok ? !!ok[i] : true));
  const F = y[0] - y[y.length - 1], n = y.length, dy = F / (n - 1);
  const a = smooth(a0, Math.max(1, (0.005 * F) / dy));
  const at = (yy) => Math.max(0, Math.min(n - 1, Math.round((y[0] - yy) / dy)));
  const range = (y1, y2) => { const i1 = at(Math.max(y1, y2)), i2 = at(Math.min(y1, y2)); const r = []; for (let i = i1; i <= i2; i++) if (Number.isFinite(a[i])) r.push(i); return r; };
  const argmax = (r, f = (i) => a[i]) => r.reduce((b, i) => (b < 0 || f(i) > f(b) ? i : b), -1);
  const p = (i) => [y[i], a[i]];
  // самая глубокая точка под хордой i→j (или самая выступающая над ней: sign = −1)
  const deepest = (i, j, sign = 1) => (i < 0 || j < 0 ? -1 : argmax(range(y[i], y[j]).filter((k) => k !== i && k !== j), (k) => -sign * signedDist(p(k), p(i), p(j))));
  // кончик носа — самая выступающая точка средней части; масштаб D — от кончика носа до низа подбородка
  const prn = argmax(range(y[0] - 0.25 * F, y[0] - 0.7 * F));
  if (prn < 0) return null;
  const D = y[prn] - y[n - 1], Y = (i) => y[i];
  // лоб и переносица: n — глубже всего под хордой «кончик носа — лоб», g — выше всего над хордой «n — лоб»
  const T = at(Y(prn) + 0.62 * D), nn = deepest(prn, T), g = nn >= 0 ? deepest(nn, at(Y(nn) + 0.3 * D), -1) : -1;
  // губы: локальные максимумы ниже носа (верхняя, нижняя), подбородок — самая выступающая точка ниже нижней губы
  const lm = range(Y(prn) - 0.18 * D, Y(prn) - 0.66 * D).filter((i) => i > 0 && i < n - 1 && a[i] >= a[i - 1] && a[i] >= a[i + 1]);
  const ls = lm[0] ?? -1, li = lm.find((i) => Y(i) < Y(ls) - 0.04 * D) ?? -1;
  const pog = li >= 0 ? deepest(li, n - 1, -1) : -1;                  // подбородок: выше всего над хордой «нижняя губа — низ»
  const sn = deepest(prn, ls), sto = deepest(ls, li), sm = deepest(li, pog);
  const pt = (i) => (i >= 0 ? [y[i], a[i], good[i]] : null);
  const P = { g: pt(g), n: pt(nn), prn: pt(prn), sn: pt(sn), ls: pt(ls), sto: pt(sto), li: pt(li), sm: pt(sm), pog: pt(pog) };
  // горбинка: наибольшее отклонение спинки от прямой n–prn (со знаком: + — выпуклая); у кончика и переносицы не считаем
  let hump = null;
  if (P.n && P.prn) {
    let best = 0;
    const L = Y(nn) - Y(prn);
    for (const i of range(Y(nn) - 0.15 * L, Y(prn) + 0.25 * L)) { const d = signedDist(p(i), P.n, P.prn); if (Math.abs(d) > Math.abs(best)) best = d; }
    hump = best;
  }
  return { points: P, metrics: metricsOf(P, hump), F, D };
}

/** Расстояние точки p от прямой a→b со знаком: + — впереди (больше a), как выступ. Точки — [y, a]. */
function signedDist(p, A, B) {
  const vy = B[0] - A[0], va = B[1] - A[1], L = Math.hypot(vy, va) || 1;
  // нормаль, смотрящая вперёд (+a)
  let ny = -va / L, na = vy / L;
  if (na < 0) { ny = -ny; na = -na; }
  return (p[0] - A[0]) * ny + (p[1] - A[1]) * na;
}
const angle = (A, O, B) => {
  const u = [A[0] - O[0], A[1] - O[1]], v = [B[0] - O[0], B[1] - O[1]];
  return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1)))) * 180) / Math.PI;
};

/** Меры по точкам: всё в долях |n–pog| или в градусах; null — точки нет или она недостоверна. */
function metricsOf(P, hump) {
  const ok = (...k) => k.every((q) => P[q] && P[q][2]);
  const H = ok('n', 'pog') || (P.n && P.pog) ? Math.hypot(P.n[0] - P.pog[0], P.n[1] - P.pog[1]) : null;
  const m = {};
  const put = (k, need, f) => { m[k] = H && ok(...need) ? f() : null; };
  put('noseProj', ['n', 'sn', 'prn'], () => signedDist(P.prn, P.n, P.sn) / H);
  put('nasion', ['g', 'n', 'prn'], () => -signedDist(P.n, P.g, P.prn) / H);
  put('hump', ['n', 'prn'], () => hump / H);
  put('nasolabial', ['prn', 'sn', 'ls'], () => angle(P.prn, P.sn, P.ls));
  put('lipU', ['prn', 'pog', 'ls'], () => signedDist(P.ls, P.prn, P.pog) / H);
  put('lipL', ['prn', 'pog', 'li'], () => signedDist(P.li, P.prn, P.pog) / H);
  put('sulcus', ['li', 'pog', 'sm'], () => -signedDist(P.sm, P.li, P.pog) / H);
  put('convex', ['g', 'sn', 'pog'], () => angle(P.g, P.sn, P.pog));
  return m;
}

// ------------------------------------------------------------------ модель

/** Меры профиля модели (по форме черепа, без сборки). */
export function modelProfile(gender, overrides = {}) {
  const c = profileCurve(gender, overrides), ys = [], as = [];
  for (let i = 0; i < c.z.length; i++) {
    const y = c.y0 + i * c.step;
    if (y < -0.98 || y > 0.42 || !Number.isFinite(c.z[i])) continue;   // от линии роста волос до низа подбородка
    ys.push(y); as.push(c.z[i]);
  }
  return profilePoints(ys, as);
}

/** Кривая модели как ломаная [y, z] от линии роста волос до низа подбородка. */
export function modelCurve(gender, overrides = {}) {
  const c = profileCurve(gender, overrides), pts = [];
  for (let i = 0; i < c.z.length; i++) {
    const y = c.y0 + i * c.step;
    if (y >= -0.98 && y <= 0.42 && Number.isFinite(c.z[i])) pts.push([y, c.z[i]]);
  }
  return pts;
}

/**
 * Совмещение контура снимка с контуром модели: подобие (масштаб, поворот, сдвиг) методом ближайших точек.
 * photo — [[y, a, вес]] (вес 0 — точка не участвует: волосы, борода), model — ломаная [[y, z]].
 * Начальное приближение — по кончику носа и высоте «нос — низ подбородка». Возвращает { T, d } (d — невязки по точкам).
 */
export function alignCurves(photo, model, T0 = null, sPrior = null, lam = 0) {
  const near = (q) => {                                                // ближайшая точка ломаной (с проекцией на отрезок)
    let best = Infinity, bi = 0, bt = 0;
    for (let i = 0; i < model.length - 1; i++) {
      const A = model[i], B = model[i + 1], vy = B[0] - A[0], vz = B[1] - A[1], L2 = vy * vy + vz * vz || 1e-12;
      const t = Math.max(0, Math.min(1, ((q[0] - A[0]) * vy + (q[1] - A[1]) * vz) / L2));
      const dy = A[0] + vy * t - q[0], dz = A[1] + vz * t - q[1], d2 = dy * dy + dz * dz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    const A = model[bi], B = model[bi + 1];
    return [A[0] + (B[0] - A[0]) * bt, A[1] + (B[1] - A[1]) * bt];
  };
  let T = T0;
  if (!T) {
    const tipP = photo.reduce((b, p) => (p[1] > b[1] ? p : b)), tipM = model.reduce((b, p) => (p[1] > b[1] ? p : b));
    const lowP = Math.min(...photo.map((p) => p[0])), lowM = Math.min(...model.map((p) => p[0]));
    const s = sPrior || (tipM[0] - lowM) / Math.max(1e-9, tipP[0] - lowP);
    T = { s, c: 1, sn: 0, ty: tipM[0] - s * tipP[0], tz: tipM[1] - s * tipP[1] };
  }
  const apply = (p, t = T) => [t.s * (t.c * p[0] - t.sn * p[1]) + t.ty, t.s * (t.sn * p[0] + t.c * p[1]) + t.tz];
  for (let it = 0; it < 12; it++) {
    // соответствия и взвешенное подобие (Умеяма, 2D)
    const P = [], Q = [], W = [];
    for (const p of photo) { if (!(p[2] > 0)) continue; const q = apply(p); P.push(p); Q.push(near(q)); W.push(p[2]); }
    if (P.length < 10) break;
    const sw = W.reduce((a, b) => a + b, 0);
    let my = 0, ma = 0, qy = 0, qz = 0;
    P.forEach((p, i) => { my += p[0] * W[i]; ma += p[1] * W[i]; qy += Q[i][0] * W[i]; qz += Q[i][1] * W[i]; });
    my /= sw; ma /= sw; qy /= sw; qz /= sw;
    let sxx = 0, sxy = 0, var_ = 0;
    P.forEach((p, i) => {
      const x0 = p[0] - my, x1 = p[1] - ma, y0 = Q[i][0] - qy, y1 = Q[i][1] - qz, w = W[i];
      sxx += w * (x0 * y0 + x1 * y1); sxy += w * (x0 * y1 - x1 * y0); var_ += w * (x0 * x0 + x1 * x1);
    });
    const ang = Math.atan2(sxy, sxx), c = Math.cos(ang), sn = Math.sin(ang), sI = Math.hypot(sxx, sxy) / Math.max(1e-12, var_);
    const s = sPrior && lam ? Math.exp((1 - lam) * Math.log(sI) + lam * Math.log(sPrior)) : sI;   // масштаб слегка тянется к опоре «нос — подбородок» (страховка от схлопывания на коротком контуре)
    T = { s, c, sn, ty: qy - s * (c * my - sn * ma), tz: qz - s * (sn * my + c * ma) };
  }
  const d = photo.map((p) => { if (!(p[2] > 0)) return 0; const q = apply(p), m = near(q); return Math.hypot(q[0] - m[0], q[1] - m[1]) * Math.sign(m[1] - q[1] || 1) * Math.sqrt(p[2]); });
  return { T, d, apply };
}

/**
 * Подгонка параметров глубины под контур снимка (Левенберг — Марквардт по невязкам совмещённых контуров).
 * photo — [[y, a, вес]] в пикселях (y вверх, a — вперёд), overrides — внешность от снимка анфас.
 * Возвращает { params, rms0, rms } (rms — средняя невязка в единицах головы).
 */
export function fitProfile(photo, gender, overrides = {}, o = {}) {
  // сначала — свободный масштаб; если совмещение вырождено (короткий контур, непохожая основа) — с опорой «нос — подбородок»
  const a = fitOnce(photo, gender, overrides, { ...o, lam: 0 });
  if (a.reliable) return a;
  const b = fitOnce(photo, gender, overrides, { ...o, lam: 0.5 });
  return b.reliable || b.rms < a.rms ? b : a;
}

function fitOnce(photo, gender, overrides, { iterations = 12, reg = 0.04, lam = 0, onStep } = {}) {
  const cur = Object.fromEntries(PROFILE_PARAMS.map(([k, lo, hi]) => [k, Math.min(hi, Math.max(lo, overrides[k] ?? modelDefault(gender, k)))]));
  const start = { ...cur }, m = PROFILE_PARAMS.length;
  // невязки: расстояния точек снимка до контура модели + регуляризация (тянет к старту, если данных мало)
  let T = null;
  // опора масштаба меряется на контуре, повёрнутом как у модели (правило низа подбородка зависит от наклона)
  const A0 = alignCurves(photo, modelCurve(gender, overrides));
  const photoTC = tipChin(photo.map(([y, a, w]) => [A0.T.c * y - A0.T.sn * a, A0.T.sn * y + A0.T.c * a, w]));
  let sP = null;
  const res = (p, keepT = false) => {
    const mc = modelCurve(gender, { ...overrides, ...p }), sp = tipChin(mc) / Math.max(1e-9, photoTC);
    if (keepT) sP = sp;
    const A = alignCurves(photo, mc, T, sp, lam);
    if (keepT) T = A.T;
    const R = A.d.slice();
    PROFILE_PARAMS.forEach(([k, lo, hi]) => R.push(((p[k] - start[k]) / (hi - lo)) * reg));
    return R;
  };
  const rms = (R) => Math.sqrt(R.slice(0, photo.length).reduce((s, x) => s + x * x, 0) / Math.max(1, photo.filter((q) => q[2] > 0).length));
  T = null;
  let r0 = res(cur, true);
  const rms0 = rms(r0);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const J = PROFILE_PARAMS.map(([k, lo, hi, h]) => {
      const p = { ...cur }, d = cur[k] + h <= hi ? h : -h;
      p[k] = cur[k] + d;
      const r = res(p);
      return r.map((x, i) => (x - r0[i]) / d);
    });
    const A = Array.from({ length: m }, () => new Float64Array(m)), b = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) for (let q = 0; q < r0.length; q++) A[i][j] += J[i][q] * J[j][q];
      for (let q = 0; q < r0.length; q++) b[i] -= J[i][q] * r0[q];
    }
    let done = false;
    for (let t = 0; t < 6 && !done; t++) {
      const Al = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const delta = solve(Al, b);
      if (!delta) { lambda *= 10; continue; }
      const p = { ...cur };
      PROFILE_PARAMS.forEach(([k, lo, hi], i) => { p[k] = Math.min(hi, Math.max(lo, cur[k] + delta[i])); });
      const r = res(p);
      if (r.reduce((s, x) => s + x * x, 0) < r0.reduce((s, x) => s + x * x, 0)) { Object.assign(cur, p); r0 = res(cur, true); lambda = Math.max(1e-6, lambda / 3); done = true; }
      else lambda *= 8;
    }
    onStep?.(it, rms(r0));
    if (!done) break;
  }
  const params = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, +v.toFixed(3)]));
  // совмещение не должно «схлопнуться» (масштаб далеко от начального, нулевая невязка) или остаться плохим
  const W = photo.filter((q) => q[2] > 0), used = W.length, fr = rms(r0);
  const span = (q) => Math.max(...q.map((x) => x[0])) - Math.min(...q.map((x) => x[0])), cover = used ? span(W) / span(photo) : 0;
  const reliable = used >= 40 && cover > 0.5 && fr > 2e-4 && fr < 0.025 && T.s > 0.5 * sP && T.s < 2 * sP;
  return { params, rms0, rms: fr, T, reliable, points: used, cover: +cover.toFixed(2) };
}

function modelDefault(gender, k) {
  return { nose: gender === 'male' ? 0.165 : 0.14, chin: gender === 'male' ? 0.065 : 0.05 }[k] ?? 0;
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// ------------------------------------------------------------------ снимок

/** Индекс кончика носа: самая выступающая точка средней части контура (сверху вниз). */
function tipIndex(curve) {
  let b = Math.floor(curve.length / 3);
  for (let i = Math.floor(0.15 * curve.length); i < 0.75 * curve.length; i++) if (curve[i][1] > curve[b][1]) b = i;
  return b;
}
/**
 * Низ подбородка (длина контура до него): ниже уровня губ край начинает уходить назад быстрее, чем вниз
 * (нижняя сторона подбородка, шея). Одно правило для снимка и модели — масштаб «нос — подбородок» у них одинаков.
 */
function chinCut(curve) {
  const tip = tipIndex(curve), top = curve[0][0], Ht = top - curve[tip][0], step = Math.max(2, Math.round((0.02 * Ht * curve.length) / Math.max(1e-9, top - curve[curve.length - 1][0])));
  for (let i = tip; i + step < curve.length; i++) {
    if (top - curve[i][0] < 1.9 * Ht) continue;                          // ниже губ (подбородок ≈ 2.2·Ht от линии роста волос)
    if ((curve[i][1] - curve[i + step][1]) / (curve[i][0] - curve[i + step][0]) > 3) return i;
  }
  return curve.length;
}
/** Вертикаль «кончик носа — низ подбородка» по контуру (опора масштаба). */
function tipChin(curve) {
  const c = curve[0][0] < curve[curve.length - 1][0] ? curve.slice().reverse() : curve, n = chinCut(c);
  return c[tipIndex(c)][0] - c[Math.max(0, n - 1)][0];
}

/**
 * Контур профиля со снимка. Многоклассовый сегментатор MediaPipe (0 фон, 1 волосы, 2 кожа тела, 3 кожа лица,
 * 4 одежда, 5 прочее): сторона, куда смотрит лицо, — та, где на краю силуэта кожа лица; передний край по строкам
 * уточняется по градиенту изображения (маска сети — 256×256). Точки, где на краю волосы (чёлка, борода), — с весом 0.
 * @returns {Promise<{ curve: number[][], side: 1|-1, image: HTMLCanvasElement, rows: number, warnings: string[] }>}
 *   curve — [[y, a, вес]] в пикселях: y вверх, a — вперёд
 */
export async function analyzeProfile(src, o = {}) {
  const A = { ...PHOTO_ASSETS, ...(o.assets || {}) };
  const say = o.onProgress || (() => {});
  say('Загружаю сегментатор…');
  const img = await toCanvas(src);
  const seg = await loadMulti(A);
  say('Ищу профиль…');
  const res = seg.segment(img), mk = res.categoryMask, M = mk.getAsUint8Array().slice(), mw = mk.width, mh = mk.height;
  res.close?.();
  let out;
  try { out = profileFromMask(img, M, mw, mh); }
  catch (e) { throw new Error(`${e.message}. Лучше всего — цветной снимок строго сбоку на однотонном фоне, лицо крупно, без чёлки на лбу`); }
  // строгий профиль MediaPipe обычно не находит; если нашёл и видны оба глаза — снимок ближе к «трём четвертям»
  try {
    const det = await detectFace(img, { assets: A });
    if (det) {
      const L = det.L, ex = Math.abs(L[263].x - L[33].x) * det.w, eh = Math.abs(L[152].y - (L[263].y + L[33].y) / 2) * det.h;
      if (ex > 0.4 * eh) out.warnings.push('Лицо повёрнуто не полностью (ближе к трём четвертям): выступ носа и подбородка будет занижен. Нужен снимок строго сбоку.');
    }
  } catch (e) { /* без проверки поворота */ }
  return out;
}

/** Контур профиля по маске классов (отдельно — для тестов). */
export function profileFromMask(img, M, mw, mh, o = {}) {
  const W = img.width, H = img.height, warnings = [];
  const cls = (x, y) => M[Math.min(mh - 1, Math.floor((y * mh) / H)) * mw + Math.min(mw - 1, Math.floor((x * mw) / W))];
  // края силуэта по строкам и класс у края (на 1.5 % ширины внутрь)
  const inset = Math.max(2, Math.round(W * 0.015)), rows = [];
  let faceL = 0, faceR = 0;
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (cls(x, y) !== 0) { l = x; break; }
    if (l < 0) continue;
    for (let x = W - 1; x >= 0; x--) if (cls(x, y) !== 0) { r = x; break; }
    const cl = cls(Math.min(W - 1, l + inset), y), cr = cls(Math.max(0, r - inset), y);
    if (cl === 3) faceL++;
    if (cr === 3) faceR++;
    rows.push({ y, l, r, cl, cr });
  }
  if (!rows.length) throw new Error('На снимке профиля не найден человек');
  const side = o.side || (faceR >= faceL ? 1 : -1), faceRows = Math.max(faceL, faceR), other = Math.min(faceL, faceR);
  if (faceRows < 20) throw new Error('На снимке профиля не видно лица сбоку');
  if (!o.side && other > 0.5 * faceRows) throw new Error('Это не профиль: лицо видно с обеих сторон. Нужен снимок строго сбоку');
  // строки лица: от первой до последней с кожей лица на переднем крае
  const front = rows.filter((r) => (side > 0 ? r.cr : r.cl) === 3);
  const y0 = front[0].y, y1 = front[front.length - 1].y;
  // уточнение края по градиенту яркости и цвета (окно ± полтора пикселя маски)
  const g = img.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const px = (x, y) => { const k = (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4; return [g[k], g[k + 1], g[k + 2]]; };
  const R = Math.max(2, Math.ceil((1.5 * W) / mw)), curve = [];
  for (const r of rows) {
    if (r.y < y0 - 0.1 * (y1 - y0) || r.y > y1) continue;
    const e = side > 0 ? r.r : r.l, c = side > 0 ? r.cr : r.cl;
    let best = e, bv = -1;
    for (let x = e - R; x <= e + R; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1; dy++) { const p = px(x, r.y + dy), q = px(x + side, r.y + dy); v += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
      v *= 1 - (0.35 * Math.abs(x - e)) / (R + 1);                     // ближе к краю маски — предпочтительнее
      if (v > bv) { bv = v; best = x; }
    }
    const xe = best + (side > 0 ? 0.5 : -0.5);
    curve.push([-r.y, side * xe, c === 3 ? 1 : 0]);
  }
  curve.length = chinCut(curve);
  // сверху — не выше линии роста волос: 0.85 расстояния «кончик носа — низ подбородка» (у модели — та же область)
  const tip = tipIndex(curve), yTop = curve[tip][0] + 0.85 * (curve[tip][0] - curve[curve.length - 1][0]);
  while (curve.length && curve[0][0] > yTop) curve.shift();
  const hairFront = curve.filter((p) => p[2] === 0).length / Math.max(1, curve.length);
  if (hairFront > 0.35) warnings.push('На профиле волосы или борода закрывают заметную часть контура лица — глубина по ним не уточнялась.');
  return { curve, side, image: img, rows: curve.length, warnings };
}

