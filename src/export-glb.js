/**
 * export-glb.js — экспорт процедурной головы в glTF/GLB (9.2): сетка, материалы, текстуры и 52 ARKit-морфа.
 *
 *   const glb = await head.exportGLB();                       // ArrayBuffer (.glb)
 *   const glb = await head.exportGLB({ detail: 'medium', scale: 0.115, morphs: true });
 *
 * Морфы снимаются «как есть»: голова ставится в нейтраль, затем каждый канал по очереди выставляется в 1,
 * и разница положений вершин всех видимых мешей записывается морф-целью. Так в морфы попадает всё, что
 * в рантайме двигают кости (челюсть, веки, глаза) и пересчёт на CPU (губы, брови, борода, маска).
 * Взгляд (eyeLook*) — поворот глаз на 0.6 рад по горизонтали и 0.45 по вертикали (как читает gltf-head.js).
 * Имена морфов — ARKit (mesh.extras.targetNames): Unity, Unreal, Blender, Ready Player Me-совместимые плееры.
 *
 * Чего в файле нет: собственных шейдеров (роговица с преломлением, рассеяние в коже, раскачка волос) —
 * материалы стандартные PBR (glTF + KHR_materials_*), зрачок не меняет размер.
 */
import * as THREE from 'three';
import { CHANNELS } from './emotions.js';

const EYE_YAW = 0.6, EYE_PITCH = 0.45;
// взгляд: канал → поза и сторона (Left — глаз при x > 0)
const EYE_LOOK = {
  eyeLookOutLeft: [{ eyeYaw: EYE_YAW }, 1], eyeLookInRight: [{ eyeYaw: EYE_YAW }, -1],
  eyeLookInLeft: [{ eyeYaw: -EYE_YAW }, 1], eyeLookOutRight: [{ eyeYaw: -EYE_YAW }, -1],
  eyeLookUpLeft: [{ eyePitch: EYE_PITCH }, 1], eyeLookUpRight: [{ eyePitch: EYE_PITCH }, -1],
  eyeLookDownLeft: [{ eyePitch: -EYE_PITCH }, 1], eyeLookDownRight: [{ eyePitch: -EYE_PITCH }, -1],
};
const POSE0 = { pitch: 0, yaw: 0, roll: 0, eyeYaw: 0, eyePitch: 0, breath: 0, focus: 1e6, pupil: 0, still: true };

/**
 * @param {import('./head-model.js').ProceduralHead} rig
 * @param {object} o  { morphs = true, scale = 0.115 (метры: голова ≈ 23 см), binary = true, name = 'AnimaHead' }
 * @returns {Promise<ArrayBuffer|object>}  .glb (binary) или JSON glTF
 */
export async function exportHeadGLB(rig, o = {}) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const root = rig.object3D, morphs = o.morphs !== false;
  const zero = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  const pose = (p = {}) => rig.update(zero, { ...POSE0, ...p });
  const set = (ch, p) => { rig.update({ ...zero, ...ch }, { ...POSE0, ...p }); root.updateMatrixWorld(true); };

  set({});
  // видимые меши (невидимые «кости» склейки и скрытые части — мимо)
  const shown = (m) => { for (let p = m; p; p = p.parent) if (!p.visible) return false; return true; };
  const list = [];
  root.traverse((m) => {
    if (!m.isMesh || m.isInstancedMesh || m.userData.backPass) return;   // изнанка волос (12.4) — та же сетка, она экспортируется двусторонней
    const mats = [].concat(m.material);
    if (mats.every((q) => q.visible === false) || !m.geometry.attributes.position) return;
    list.push(m);
  });
  const inv = new THREE.Matrix4(), v = new THREE.Vector3();
  const snap = (m) => {
    inv.copy(root.matrixWorld).invert();
    const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), n = m.geometry.attributes.position.count, out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, v).applyMatrix4(M); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
    return out;
  };
  // базовая поза: только то, что видно в нейтрали (губы со спины прячутся — для экспорта поза анфас)
  const underHead = (m) => { for (let q = m; q; q = q.parent) if (q === rig.headPivot) return true; return false; };
  const meshes = list.filter(shown).map((m) => ({ src: m, targets: [], head: underHead(m), inner: [].concat(m.material).some((q) => q.stencilWrite) }));
  const skinE = meshes.find((e) => e.src === rig.skin);
  // меши век: в них есть узлы-кости век (склейка) или сами веки
  const lidNodes = new Set((rig.eyes || []).flatMap((e) => [e.up, e.lo]));
  const hasLid = (m) => { if (lidNodes.has(m) || [...lidNodes].some((l) => l && m.parent && (l === m.parent || l.parent === m))) return true; let f = false; m.skeleton?.bones.forEach((b) => { for (let q = b; q; q = q.parent) if (lidNodes.has(q)) f = true; }); if (!f) m.traverseAncestors((q) => { if (lidNodes.has(q)) f = true; }); return f; };
  for (const e of meshes) e.lids = hasLid(e.src);
  // все меши в текущей позе; полость рта, зубы, язык (в рантайме — по трафарету, только в ротовом отверстии) —
  // за поверхность кожи этой позы: в glTF трафарета нет, иначе нижние зубы торчат сквозь подбородок
  const snapAll = () => {
    const S = meshes.map((e) => snap(e.src));
    if (cavE) {                                                         // полость — чашей вглубь: края у губ, середина за зубами
      const p = S[meshes.indexOf(cavE)], rows = cavE.src.geometry.userData.rows || 8, cols = p.length / 3 / (rows + 1) - 1;
      for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
        const sv = r / rows, t = (c / cols) * 2 - 1, k = (r * (cols + 1) + c) * 3;
        p[k + 2] -= 0.2 * Math.min(1, sv * 8, (1 - sv) * 8) * Math.min(1, (1 - t * t) * 6);
      }
    }
    if (skinE) {
      // глубина кожи по сетке 0.01: в ячейке — самая дальняя вперёд вершина; пустые ячейки (щель рта, редкая сетка)
      // заполняются по соседям, если их хотя бы три (открытый рот так не «зарастает»)
      const sk = S[meshes.indexOf(skinE)], C = 0.01, X0 = -1.2, Y0 = -1.6, W = 240, H = 240, NO = -Infinity;
      let Z = new Float32Array(W * H).fill(NO);
      for (let i = 0; i < sk.length; i += 3) {
        if (sk[i + 2] < 0.2 || (holeOnly && !holeOnly[i / 3])) continue;   // только перед лица, без отверстия рта
        const x = Math.floor((sk[i] - X0) / C), y = Math.floor((sk[i + 1] - Y0) / C);
        if (x >= 0 && y >= 0 && x < W && y < H && sk[i + 2] > Z[y * W + x]) Z[y * W + x] = sk[i + 2];
      }
      for (let it = 0; it < 2; it++) {
        const Z2 = Z.slice();
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          if (Z[y * W + x] !== NO) continue;
          let n = 0, m = Infinity;
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const z = Z[(y + b) * W + x + a]; if (z !== NO) { n++; m = Math.min(m, z); } }
          if (n >= 3) Z2[y * W + x] = m;
        }
        Z = Z2;
      }
      for (const [k, e] of meshes.entries()) if (e.inner) {
        const p = S[k];
        for (let i = 0; i < p.length; i += 3) {
          const x = Math.floor((p[i] - X0) / C), y = Math.floor((p[i + 1] - Y0) / C);
          let m = Infinity;                                             // самая глубокая кожа рядом — с запасом на склонах
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
            const X = x + a, Y = y + b;
            if (X >= 0 && Y >= 0 && X < W && Y < H && Z[Y * W + X] !== NO) m = Math.min(m, Z[Y * W + X]);
          }
          if (m !== Infinity && p[i + 2] > m - 0.004) p[i + 2] = m - 0.004;
        }
      }
    }
    return S;
  };
  // отверстие рта в коже: в рантайме кожа сплошная, а полость рисуется поверх неё по трафарету. Для glTF убираем
  // треугольники кожи, которые хоть в одной позе попадают в след полости (объединение по позам); в покое это место
  // закрывают губы, при открытом рте сквозь него видны полость, зубы и язык
  const cavE = meshes.find((e) => [].concat(e.src.material).some((q) => q.stencilWrite && q.stencilFunc === THREE.AlwaysStencilFunc));
  const poses = [[{}, {}], ...(morphs ? CHANNELS.map((c) => (EYE_LOOK[c] ? [{}, EYE_LOOK[c][0]] : [{ [c]: 1 }, {}])) : [])];
  const hole = new Set();
  const lipE = meshes.find((e) => [].concat(e.src.material).includes(rig.mat?.lip));
  if (skinE && cavE) {
    const sIdx = rig.skin.geometry.index.array, cg = cavE.src.geometry, cIdx = cg.index ? cg.index.array : null;
    const R = 0.004, X0 = -0.7, Y0 = -1.0, W = 350, H = 225, mark = new Uint8Array(W * H), lipCover = new Uint8Array(W * H);
    // след треугольников (x, y) на сетке
    const raster = (pos, idx, out, grow = 0) => {
      const nT = idx ? idx.length : pos.length / 3;
      for (let t = 0; t < nT; t += 3) {
        const ia = (idx ? idx[t] : t) * 3, ib = (idx ? idx[t + 1] : t + 1) * 3, ic = (idx ? idx[t + 2] : t + 2) * 3;
        const ax = pos[ia], ay = pos[ia + 1], bx = pos[ib], by = pos[ib + 1], cx = pos[ic], cy = pos[ic + 1];
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - X0) / R) - grow), x1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx, cx) - X0) / R) + grow);
        const y0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - Y0) / R) - grow), y1 = Math.min(H - 1, Math.ceil((Math.max(ay, by, cy) - Y0) / R) + grow);
        for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
          const px = X0 + (gx + 0.5) * R, py = Y0 + (gy + 0.5) * R;
          const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
          if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) out[gy * W + gx] = 1;
        }
      }
    };
    if (lipE) {                                                         // в покое вырез закрыт губами (с запасом 3 ячейки)
      set({});
      const full = new Uint8Array(W * H), E = 3;
      raster(snap(lipE.src), lipE.src.geometry.index?.array, full);
      for (let y = E; y < H - E; y++) for (let x = E; x < W - E; x++) {
        let ok = 1;
        for (let b = -E; b <= E && ok; b++) for (let a = -E; a <= E; a++) if (!full[(y + b) * W + x + a]) { ok = 0; break; }
        lipCover[y * W + x] = ok;
      }
    }
    let cand = null;
    for (const [ch, p] of poses) {
      set(ch, p);
      const sk = snap(rig.skin), cv = snap(cavE.src);
      if (!cand) {                                                      // кандидаты — треугольники кожи у рта
        cand = [];
        for (let t = 0; t < sIdx.length; t += 3) {
          const a = sIdx[t] * 3, b = sIdx[t + 1] * 3, c = sIdx[t + 2] * 3, x = (sk[a] + sk[b] + sk[c]) / 3, y = (sk[a + 1] + sk[b + 1] + sk[c + 1]) / 3, z = (sk[a + 2] + sk[b + 2] + sk[c + 2]) / 3;
          if (Math.abs(x) < 0.65 && y > -0.95 && y < -0.15 && z > 0.3) {
            const gx = Math.floor((x - X0) / R), gy = Math.floor((y - Y0) / R);
            if (!lipE || lipCover[gy * W + gx]) cand.push(t);                // только под губами покоя: иначе дыры за уголками рта
          }
        }
      }
      mark.fill(0);
      raster(cv, cIdx, mark);
      for (const t of cand) {
        if (hole.has(t)) continue;
        const a = sIdx[t] * 3, b = sIdx[t + 1] * 3, c = sIdx[t + 2] * 3;
        const gx = Math.floor(((sk[a] + sk[b] + sk[c]) / 3 - X0) / R), gy = Math.floor(((sk[a + 1] + sk[b + 1] + sk[c + 1]) / 3 - Y0) / R);
        if (gx >= 0 && gy >= 0 && gx < W && gy < H && mark[gy * W + gx]) hole.add(t);
      }
    }
    set({});
  }
  // вершины, оставшиеся только у вырезанных треугольников, — не кожа (для глубины кожи при посадке зубов)
  let holeOnly = null;
  if (hole.size) {
    const sIdx = rig.skin.geometry.index.array, keep = new Uint8Array(rig.skin.geometry.attributes.position.count);
    for (let t = 0; t < sIdx.length; t += 3) if (!hole.has(t)) keep[sIdx[t]] = keep[sIdx[t + 1]] = keep[sIdx[t + 2]] = 1;
    holeOnly = keep;
  }
  const base = snapAll();
  meshes.forEach((e, k) => { e.base = base[k]; });

  // центры глаз (для поправки век): в координатах object3D, поза — нейтраль
  set({});
  const eyeC = (rig.eyes || []).map((e) => e.ball.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv.copy(root.matrixWorld).invert()));
  const eyeR = rig.eye?.r || 0.11, corneaR = eyeR * 1.06 + 0.002;
  // веко в морфе поворачивается вокруг центра глаза, а морф ведёт вершину по хорде: на полпути моргания веко
  // проваливается под роговицу (радужка просвечивает). Конечную точку отодвигаем наружу так, чтобы середина
  // хорды прошла над роговицей; закрытое веко чуть выпуклее — как у настоящего
  const lidFix = (b, p) => {
    for (const c of eyeC) {
      const ax = b[0] - c.x, ay = b[1] - c.y, az = b[2] - c.z, R0 = Math.hypot(ax, ay, az);
      if (R0 < eyeR * 0.98 || R0 > eyeR * 1.3) continue;
      const bx = p[0] - c.x, by = p[1] - c.y, bz = p[2] - c.z, R1 = Math.hypot(bx, by, bz);
      if (R1 < 1e-6) return;
      const cos = (ax * bx + ay * by + az * bz) / (R0 * R1);
      if (cos > 0.997) return;                                          // поворот меньше ~4.5° — хорда не проваливается
      const mid = 0.5 * Math.sqrt(R0 * R0 + R1 * R1 + 2 * R0 * R1 * cos);
      if (mid >= corneaR) return;
      const R1n = -R0 * cos + Math.sqrt(R0 * R0 * cos * cos - R0 * R0 + 4 * corneaR * corneaR), k = R1n / R1;
      p[0] = c.x + bx * k; p[1] = c.y + by * k; p[2] = c.z + bz * k;
      return;
    }
  };

  if (morphs) {
    const EPS = 2e-5;
    for (const c of CHANNELS) {
      const look = EYE_LOOK[c];
      set(look ? {} : { [c]: 1 }, look ? look[0] : {});
      const S = snapAll();
      for (const [k, e] of meshes.entries()) {
        const p = S[k], d = new Float32Array(p.length);
        let any = false;
        for (let i = 0; i < p.length; i += 3) {
          if (look && Math.sign(e.base[i]) !== look[1]) continue;              // взгляд: только свой глаз
          if (e.lids) { const q = [p[i], p[i + 1], p[i + 2]]; lidFix([e.base[i], e.base[i + 1], e.base[i + 2]], q); p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2]; }
          const dx = p[i] - e.base[i], dy = p[i + 1] - e.base[i + 1], dz = p[i + 2] - e.base[i + 2];
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < EPS) continue;
          d[i] = dx; d[i + 1] = dy; d[i + 2] = dz; any = true;
        }
        if (any) e.targets.push([c, d]);
      }
    }
    set({});
  }
  pose();

  // сцена для экспорта
  const scene = new THREE.Scene(), group = new THREE.Group();
  group.name = o.name || 'AnimaHead';
  group.scale.setScalar(o.scale ?? 0.115);
  scene.add(group);
  // узел Head — шарнир шеи: всё, что поворачивается с головой (в движке голову можно вращать этим узлом)
  const headNode = new THREE.Group(), piv = rig.headPivot.position;
  headNode.name = 'Head';
  headNode.position.copy(piv);
  group.add(headNode);
  const matCache = new Map(), N3 = new THREE.Matrix3();
  for (const [k, e] of meshes.entries()) {
    const m = e.src, g = m.geometry, mats = [].concat(m.material);
    const geo = new THREE.BufferGeometry();
    if (e.head) for (let i = 0; i < e.base.length; i += 3) { e.base[i] -= piv.x; e.base[i + 1] -= piv.y; e.base[i + 2] -= piv.z; }
    geo.setAttribute('position', new THREE.BufferAttribute(e.base, 3));
    inv.copy(root.matrixWorld).invert();
    N3.getNormalMatrix(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    if (g.attributes.normal) {
      const na = g.attributes.normal, nn = new Float32Array(na.count * 3);
      for (let i = 0; i < na.count; i++) { v.fromBufferAttribute(na, i).applyMatrix3(N3).normalize(); nn[i * 3] = v.x; nn[i * 3 + 1] = v.y; nn[i * 3 + 2] = v.z; }
      geo.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    }
    const decal = mats[0].userData.decal;                                // слой декалей кожи: своя развёртка
    const textured = mats.some((q) => q.map || q.normalMap || q.roughnessMap || q.alphaMap || q.userData.decal);
    if (g.attributes.uv && textured && !(decal && !mats[0].map)) geo.setAttribute('uv', g.attributes.uv.clone());
    if (decal && !mats[0].map && g.attributes[decal.attr]) geo.setAttribute('uv', g.attributes[decal.attr].clone());
    // роговица в рантайме преломляет и увеличивает радужку (~×1.15); в glTF её шейдера нет — увеличение переносим
    // в развёртку глаза: зрачок на полюсе (v = 1), угол от него a = (1 − v)·π, у полюса текстура «растягивается»
    if (geo.attributes.uv && rig.P?.cornea !== false && mats.some((q) => q === rig.mat?.eye || q === rig.mat?.eyeR)) {
      const uv = geo.attributes.uv, MAG = 0.2, AC = 0.95;           // край радужки (0.53 рад) — ×1.14
      for (let i = 0; i < uv.count; i++) {
        const a = (1 - uv.getY(i)) * Math.PI;
        if (a < AC) uv.setY(i, 1 - a / (1 + MAG * (1 - (a / AC) ** 2)) / Math.PI);
      }
    }
    const useColor = mats.some((q) => q.vertexColors) && g.attributes.color;
    if (useColor) {
      const ca = g.attributes.color.clone();
      if (decal && mats[0].map && g.attributes[decal.attr]) bakeDecal(ca, g.attributes[decal.attr], decal.tex.image);   // со снимком: декали — в цвет вершин
      for (let i = 0; i < ca.array.length; i++) ca.array[i] = Math.min(1, Math.max(0, ca.array[i]));   // glTF: COLOR_0 в 0…1
      geo.setAttribute('color', ca);
    }
    if (g.index && m === rig.skin && hole.size) {
      const src = g.index.array, kept = [];
      for (let t = 0; t < src.length; t += 3) if (!hole.has(t)) kept.push(src[t], src[t + 1], src[t + 2]);
      geo.setIndex(kept);
    } else if (g.index) geo.setIndex(g.index.clone());
    for (const gr of g.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    if (g.drawRange.count !== Infinity) geo.setDrawRange(g.drawRange.start, g.drawRange.count);
    const mat = mats.map((q) => matCache.get(q) || matCache.set(q, exportMaterial(q, !!useColor)).get(q));
    const out = new THREE.Mesh(geo, mat.length > 1 ? mat : mat[0]);
    out.name = m.name && m.name !== 'batch' && m.name !== 'batchDyn' ? m.name : `part${k}`;
    if (e.targets.length) {
      geo.morphAttributes.position = e.targets.map(([, d]) => new THREE.BufferAttribute(d, 3));
      geo.morphTargetsRelative = true;
      out.updateMorphTargets();
      out.morphTargetDictionary = Object.fromEntries(e.targets.map(([c], i) => [c, i]));
      out.morphTargetInfluences = e.targets.map(() => 0);
    }
    (e.head ? headNode : group).add(out);
  }
  const exporter = new GLTFExporter();
  let result = await exporter.parseAsync(scene, { binary: o.binary !== false, onlyVisible: true });
  if (result instanceof ArrayBuffer && o.sparse !== false) result = sparsifyGLB(result);
  group.traverse((ch) => ch.geometry?.dispose());
  for (const q of matCache.values()) q.dispose();
  return result;
}

/** Копия материала без своих шейдеров; режимы прозрачности — понятные glTF (MASK вместо alphaHash и alpha-to-coverage). */
function exportMaterial(q, vc) {
  const m = q.clone();
  m.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
  m.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
  if (q.userData.twoPass) m.side = THREE.DoubleSide;
  m.userData = {};
  m.vertexColors = vc;
  m.name = q.name || q.type.replace('Mesh', '').replace('Material', '').toLowerCase();
  if (q.alphaHash) { m.alphaHash = false; m.alphaTest = Math.max(q.alphaTest, 0.4); m.transparent = false; }
  if (q.alphaToCoverage) { m.alphaToCoverage = false; m.alphaTest = Math.max(q.alphaTest, 0.3); }
  const decal = q.userData.decal;
  if (decal && !q.map) m.map = decal.tex;
  for (const k of ['color', 'sheenColor', 'emissive', 'specularColor', 'attenuationColor']) if (m[k]?.isColor) { const c = m[k]; c.setRGB(Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b)); }   // glTF: множители цвета в 0…1
  return m;
}

/** Декали кожи в цвет вершин (когда UV заняты снимком): цвет × рисунок в точке развёртки декалей. */
function bakeDecal(color, uv, img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, s2l = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  for (let i = 0; i < color.count; i++) {
    const x = Math.min(c.width - 1, Math.max(0, Math.round(uv.getX(i) * (c.width - 1))));
    const y = Math.min(c.height - 1, Math.max(0, Math.round((1 - uv.getY(i)) * (c.height - 1))));
    const k = (y * c.width + x) * 4;
    color.setXYZ(i, color.getX(i) * s2l(d[k] / 255), color.getY(i) * s2l(d[k + 1] / 255), color.getZ(i) * s2l(d[k + 2] / 255));
  }
}

/**
 * Морф-цели — разреженными accessor'ами (glTF sparse): хранятся только сдвинутые вершины (обычно ~1/5),
 * файл в 2–2.5 раза меньше. Читают three.js, Blender, Unity (glTFast), Babylon.
 */
function sparsifyGLB(buf) {
  const dv = new DataView(buf), jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binOff = 20 + jsonLen + 8, bin = new Uint8Array(buf, binOff, dv.getUint32(20 + jsonLen, true));
  const targetAcc = new Set();
  for (const m of json.meshes || []) for (const pr of m.primitives) for (const t of pr.targets || []) for (const k in t) targetAcc.add(t[k]);
  const chunks = [], views = [];
  const addView = (bytes) => { views.push({ bytes }); return views.length - 1; };
  const keep = new Map();                                              // старый bufferView → новый
  const useView = (i) => { if (!keep.has(i)) { const v = json.bufferViews[i]; keep.set(i, addView(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength))); views[keep.get(i)].src = v; } return keep.get(i); };
  for (const [ai, a] of json.accessors.entries()) {
    if (a.bufferView === undefined) continue;
    const v = json.bufferViews[a.bufferView];
    if (targetAcc.has(ai) && a.componentType === 5126 && a.type === 'VEC3' && (!v.byteStride || v.byteStride === 12)) {
      const f = new Float32Array(bin.buffer, bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0), a.count * 3), idx = [];
      for (let i = 0; i < a.count; i++) if (f[i * 3] || f[i * 3 + 1] || f[i * 3 + 2]) idx.push(i);
      if (idx.length * 16 < a.count * 12) {
        const big = a.count > 65535, I = big ? new Uint32Array(idx) : new Uint16Array(idx), V = new Float32Array(idx.length * 3);
        idx.forEach((i, k) => { V[k * 3] = f[i * 3]; V[k * 3 + 1] = f[i * 3 + 1]; V[k * 3 + 2] = f[i * 3 + 2]; });
        delete a.bufferView; delete a.byteOffset;
        a.sparse = idx.length ? { count: idx.length, indices: { bufferView: addView(new Uint8Array(I.buffer)), componentType: big ? 5125 : 5123 }, values: { bufferView: addView(new Uint8Array(V.buffer)) } } : undefined;
        if (!a.sparse) delete a.sparse;
        continue;
      }
    }
    a.bufferView = useView(a.bufferView);
  }
  for (const im of json.images || []) if (im.bufferView !== undefined) im.bufferView = useView(im.bufferView);
  // новый BIN: виды подряд, по 4 байта
  let off = 0;
  json.bufferViews = views.map((w) => {
    const bv = { buffer: 0, byteOffset: off, byteLength: w.bytes.byteLength };
    if (w.src?.byteStride) bv.byteStride = w.src.byteStride;
    if (w.src?.target) bv.target = w.src.target;
    chunks.push([off, w.bytes]); off += (w.bytes.byteLength + 3) & ~3;
    return bv;
  });
  json.buffers = [{ byteLength: off }];
  const jb = new TextEncoder().encode(JSON.stringify(json)), jl = (jb.length + 3) & ~3, total = 12 + 8 + jl + 8 + off;
  const out = new ArrayBuffer(total), o8 = new Uint8Array(out), od = new DataView(out);
  od.setUint32(0, 0x46546c67, true); od.setUint32(4, 2, true); od.setUint32(8, total, true);
  od.setUint32(12, jl, true); od.setUint32(16, 0x4e4f534a, true); o8.set(jb, 20); o8.fill(0x20, 20 + jb.length, 20 + jl);
  od.setUint32(20 + jl, off, true); od.setUint32(24 + jl, 0x004e4942, true);
  for (const [at, bytes] of chunks) o8.set(bytes, 28 + jl + at);
  return out;
}
