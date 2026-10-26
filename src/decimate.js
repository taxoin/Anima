/**
 * decimate.js — упрощение сетки схлопыванием рёбер в существующую вершину (11.2).
 *
 * Схлопывание u → v оставляет v на месте, поэтому выжившие вершины — подмножество исходных: все атрибуты
 * (UV, цвет, кости, свои атрибуты шейдеров) и морф-цели переносятся по индексу, мимика остаётся. Цена схлопывания —
 * квадрики плоскостей граней (Garland–Heckbert) у вершины u, умноженные на её вес, плюс расхождение сдвигов морфов
 * u и v (уголки рта, веки, брови схлопываются последними). Запрещено: переворот и вырождение граней; края открытых
 * сеток (рёбра одной грани, в т. ч. швы с дублированными вершинами) зафиксированы — без щелей.
 */
import * as THREE from 'three';

/**
 * @param {THREE.BufferGeometry} geo  индексированная сетка
 * @param {number} target  сколько треугольников оставить
 * @param {object} [o]
 * @param {Float32Array} [o.weight]  вес вершины (≥ 0, по умолчанию 1) — во сколько раз дороже её сдвигать
 * @param {number} [o.morphK=4]  цена расхождения морфов: квадрат сдвига × площадь вершины (как у квадрик) × morphK
 * @param {Int8Array} [o.cls]  класс вершины: схлопываются только вершины одного класса (граница классов сохраняется)
 * @param {number} [o.maxDev=0.035]  предел отклонения формы (среднеквадратичный, в единицах сетки): дальше — стоп, даже если
 *   target не достигнут (иначе у недостижимой цели упрощение съедает силуэт)
 * @param {number} [o.minQ=0.12]  нижняя граница качества новых треугольников (1 — равносторонний)
 * @returns {THREE.BufferGeometry} новая сетка (исходная не меняется)
 */
export function decimate(geo, target, { weight = null, morphK = 4, minQ = 0.12, cls = null, maxDev = 0.035 } = {}) {
  const P = geo.attributes.position.array, n = geo.attributes.position.count, I = geo.index.array, m = I.length / 3;
  if (m <= target || geo.groups.length > 1) return geo;             // несколько групп материалов — не упрощаем
  const F = Int32Array.from(I), alive = new Uint8Array(m).fill(1);
  const VF = Array.from({ length: n }, () => []);
  for (let f = 0; f < m; f++) for (let k = 0; k < 3; k++) VF[F[f * 3 + k]].push(f);
  // квадрики: 10 чисел симметричной матрицы 4×4 на вершину
  const Q = new Float64Array(n * 10), A = new Float64Array(n);       // A — площадь, «принадлежащая» вершине (масштаб цены морфов как у квадрик)
  for (let f = 0; f < m; f++) {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-14) continue;
    const area = len / 2; nx /= len; ny /= len; nz /= len;
    const d = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
    const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (let k = 0; k < 3; k++) { const o = F[f * 3 + k] * 10; for (let j = 0; j < 10; j++) Q[o + j] += q[j] * area; A[F[f * 3 + k]] += area / 3; }
  }
  if (weight) for (let v = 0; v < n; v++) for (let j = 0; j < 10; j++) Q[v * 10 + j] *= weight[v];
  // края открытых сеток — зафиксированы
  const lock = new Uint8Array(n), edges = new Map();
  const ek = (a, b) => (a < b ? a * n + b : b * n + a);
  for (let f = 0; f < m; f++) for (let k = 0; k < 3; k++) { const key = ek(F[f * 3 + k], F[f * 3 + (k + 1) % 3]); edges.set(key, (edges.get(key) || 0) + 1); }
  for (const [key, c] of edges) if (c === 1) { lock[Math.floor(key / n)] = 1; lock[key % n] = 1; }
  const morphs = geo.morphAttributes.position || [];
  const qv = (o, x, y, z) => Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x + Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y + Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];
  const morphCost = (u, v) => {
    let e = 0;
    for (const M of morphs) { const A = M.array, du = A[u * 3] - A[v * 3], dv = A[u * 3 + 1] - A[v * 3 + 1], dw = A[u * 3 + 2] - A[v * 3 + 2]; e = Math.max(e, du * du + dv * dv + dw * dw); }
    return e * morphK * A[u] * (weight ? weight[u] : 1);
  };
  const nrm = (a, b, c, out) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  };
  const n0 = [0, 0, 0], n1 = [0, 0, 0];
  const d2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  // качество треугольника: 1 — равносторонний, → 0 — «щепка» (4√3·S / сумма квадратов сторон)
  const quality = (a, b, c, len) => 3.4641 * len / Math.max(1e-20, d2(a, b) + d2(b, c) + d2(c, a));
  // можно ли схлопнуть u → v: грани u без v не переворачиваются, не вырождаются и не становятся «щепками»
  const valid = (u, v) => {
    for (const f of VF[u]) {
      if (!alive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === v || b === v || c === v) continue;
      nrm(a, b, c, n0);
      nrm(a === u ? v : a, b === u ? v : b, c === u ? v : c, n1);
      const l0 = Math.hypot(...n0), l1 = Math.hypot(...n1);
      if (l1 < 1e-12 || l1 < l0 * 0.02) return false;
      if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.3) return false;
      const q1 = quality(a === u ? v : a, b === u ? v : b, c === u ? v : c, l1 / 2);
      if (q1 < minQ && q1 < quality(a, b, c, l0 / 2)) return false;
    }
    return true;
  };
  const nbrs = (u) => { const s = new Set(); for (const f of VF[u]) if (alive[f]) for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== u) s.add(w); } return s; };
  // лучшая цель для каждой вершины; куча с ленивым удалением (версии)
  const best = new Int32Array(n).fill(-1), cost = new Float64Array(n).fill(Infinity), ver = new Uint32Array(n);
  const heap = [];
  const push = (c, u, vv) => {
    heap.push([c, u, vv]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; }
    }
    return top;
  };
  const dead = new Uint8Array(n);
  const evalV = (u) => {
    ver[u]++; best[u] = -1; cost[u] = Infinity;
    if (lock[u] || dead[u]) return;
    const o = u * 10, cand = [];
    const a = Math.max(A[u], 1e-12);                                  // цена на единицу площади — квадрат отклонения × вес вершины
    for (const v of nbrs(u)) if (!cls || cls[u] === cls[v]) cand.push([(Math.max(0, qv(o, P[v * 3], P[v * 3 + 1], P[v * 3 + 2])) + morphCost(u, v)) / a, v]);
    cand.sort((a, b) => a[0] - b[0]);
    for (const [c, v] of cand) if (valid(u, v)) { cost[u] = c; best[u] = v; break; }   // самая дешёвая допустимая цель
    if (best[u] >= 0) push(cost[u], u, ver[u]);
  };
  for (let u = 0; u < n; u++) if (VF[u].length) evalV(u);
  let faces = m;
  const lim = maxDev * maxDev;
  while (faces > target && heap.length) {
    const [c0, u, vv] = pop();
    if (vv !== ver[u] || dead[u]) continue;
    if (c0 > lim) break;                                               // дальше — заметная потеря формы
    const v = best[u];
    if (v < 0 || dead[v] || !valid(u, v)) { evalV(u); continue; }  // соседи изменились — переоценить
    for (const f of VF[u]) {
      if (!alive[f]) continue;
      const a = f * 3;
      if (F[a] === v || F[a + 1] === v || F[a + 2] === v) {
        alive[f] = 0; faces--;
      } else {
        for (let k = 0; k < 3; k++) if (F[a + k] === u) F[a + k] = v;
        VF[v].push(f);
      }
    }
    for (let j = 0; j < 10; j++) Q[v * 10 + j] += Q[u * 10 + j];
    A[v] += A[u];
    dead[u] = 1; VF[u] = [];
    VF[v] = VF[v].filter((f) => alive[f]);
    evalV(v);
    for (const w of nbrs(v)) evalV(w);
  }
  // сборка: живые вершины по порядку, все атрибуты и морфы — по индексу
  const remap = new Int32Array(n).fill(-1), keep = [], idx = [];
  for (let f = 0; f < m; f++) {
    if (!alive[f]) continue;
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const w of [a, b, c]) { if (remap[w] < 0) { remap[w] = keep.length; keep.push(w); } idx.push(remap[w]); }
  }
  const out = new THREE.BufferGeometry();
  const sub = (at) => {
    const s = at.itemSize, A = new at.array.constructor(keep.length * s);
    for (let i = 0; i < keep.length; i++) for (let j = 0; j < s; j++) A[i * s + j] = at.array[keep[i] * s + j];
    const r = new THREE.BufferAttribute(A, s, at.normalized); r.setUsage(at.usage); return r;
  };
  for (const k in geo.attributes) out.setAttribute(k, sub(geo.attributes[k]));
  for (const k in geo.morphAttributes) out.morphAttributes[k] = geo.morphAttributes[k].map(sub);
  out.morphTargetsRelative = geo.morphTargetsRelative;
  out.setIndex(idx);
  out.userData = { ...geo.userData, decimated: { from: m, to: idx.length / 3 } };
  return out;
}
