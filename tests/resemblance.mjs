/**
 * Сходство «как видит пользователь»: голова по фото с настройками по умолчанию (как в демо: лёгкое качество,
 * крупный кадр, вся мимика головы) → рендер → тот же разбор, что у фото (меры с поправкой на выражение) →
 * сравнение с фото. Защищает от деградаций, которые не видит test:likeness (тот рендерит с мимикой фото).
 *
 *   npm run fetch:portraits                    один раз: снимки набора в dev/portraits/
 *   npm run test:resemblance                   сравнить с базовой линией (tests/portraits/resemblance-baseline.json)
 *   npm run test:resemblance -- --save-baseline   записать результат как базовую линию
 *   npm run test:resemblance -- --opts='{"focus":0}'  свои параметры fromPhoto
 *
 * Метрики по каждому из 24 портретов анфас (12 женских, 12 мужских):
 *   cos  — косинус между отличиями человека от среднего (z по 136 портретам набора) и отличиями головы от её
 *          же основы без шаржа; 1 — черты переданы в правильную сторону и в правильной пропорции;
 *   rank — место человека среди 136 портретов набора по этому косинусу (1 — голова больше всего похожа на него).
 *   id   — вторая, независимая мерка: отпечаток лица моделью распознавания face-api (@vladmandic/face-api,
 *          128 чисел по всему изображению — видит и кожу, и брови, и причёску); idDist — расстояние от рендера
 *          до снимка того же человека (меньше — похожее; разные люди в наборе — медиана 0.81), idRank — его место
 *          среди снимков набора по этому расстоянию.
 *   hair — третья мерка (14.5): совпадение силуэта причёски с фото — IoU маски волос снимка (сегментатор MediaPipe)
 *          и точной маски мешей волос рендера, оба анфас и выровнены по глазам и рту.
 * Падает (код 1), если средний cos упал больше чем на 0.03, в пятёрку попадает на 2+ лица меньше, среднее idDist
 * выросло больше чем на 0.02, по отпечатку в пятёрке на 3+ лица меньше или IoU причёски упал больше чем на 0.03.
 * MediaPipe — на CPU (PHOTO_ASSETS.delegate): на GPU точки немного другие (меры до 1–2 %), и если GPU молча не поднимется,
 * снимки и рендеры разойдутся. Режим и версия — в базовой линии; при другом режиме сравнение не делается.
 * Лист «фото | голова» — dev/resemblance-sheet.png. Нужны Chrome ($CHROME) и сеть (MediaPipe с CDN).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), saveBase = args.includes('--save-baseline');
const OPTS = JSON.parse(args.find((a) => a.startsWith('--opts='))?.slice(7) || '{}');
const BASE = path.join(ROOT, 'tests/portraits/resemblance-baseline.json');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/portraits/manifest.json'), 'utf8'));
const have = manifest.portraits.filter((p) => fs.existsSync(path.join(ROOT, 'dev/portraits', p.id + '.jpg')));
if (have.length < 100) { console.error('Нет снимков: сначала npm run fetch:portraits'); process.exit(2); }
// 24 портрета анфас (|yaw| < 0.08): 12 женских, 12 мужских
const FACES = ['004494bc17', 'fcd353273c', 'd38f47ee6a', 'b21dd7581b', '0559c6f953', 'b63d3d621e', 'e41d5716b8', 'ee358a370c', 'a36856c69b', '13243f7109', 'b55a0e7e14', '7b53f56d2d',
  '820a4f262c', 'ac264ef4ac', 'f9ffbfb5ff', '28de559608', 'aac3dc88c5', '3c7149ebf4', 'ac56d5a36b', 'b23a56519d', '579e859c5c', 'd539a71591', '0e2c354d22', 'aeb925936b'];
const gender = Object.fromEntries(manifest.portraits.map((p) => [p.id, p.labels.gender === 'female' ? 'female' : 'male']));
// меры, которые MediaPipe по снимку анфас видит надёжно (без формы век, спинки и выступа носа)
const F = ['eyeCX', 'eyeW', 'eyeH', 'tilt', 'browY', 'browArch', 'browTail', 'browX0', 'browX1', 'browTh', 'noseTip', 'noseW', 'mouthHW', 'lipU', 'lipL', 'chin', 'chinSq', 'cheekPr', 'bowX', 'bowRC', 'w1', 'w2', 'w3', 'w4', 'w5'];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { f = fs.realpathSync(f); } catch { /* нет файла */ }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.setViewport({ width: 600, height: 700 });
await page.goto(`http://127.0.0.1:${server.address().port}/tests/render.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready === true', { timeout: 30000 });
const DELEGATE = await page.evaluate(async (src) => {
  const pa = await import('/src/photo-avatar.js');
  pa.PHOTO_ASSETS.delegate = 'CPU';
  await pa.analyzePortrait(src, {}).catch(() => null);
  return pa.photoDelegate();
}, `/dev/portraits/${have[0].id}.jpg`);
if (DELEGATE !== 'CPU') { console.error(`MediaPipe не на CPU (${DELEGATE}) — результат несравним с базовой линией`); process.exit(2); }
// face-api — в своей вкладке: в одной странице с MediaPipe она сдвигает его разбор
const idPage = await browser.newPage();
idPage.on('pageerror', (e) => console.error('pageerror', e.message));
await idPage.goto(`http://127.0.0.1:${server.address().port}/tests/portraits/manifest.json`);
const faceId = (src) => idPage.evaluate((s) => window.faceId(s), src);
const FA_VER = await idPage.evaluate(async () => {
  const fa = await import('/node_modules/@vladmandic/face-api/dist/face-api.esm.js');
  await fa.tf.setBackend('cpu'); await fa.tf.ready();
  const M = '/node_modules/@vladmandic/face-api/model';
  await Promise.all([fa.nets.ssdMobilenetv1.loadFromUri(M), fa.nets.faceLandmark68Net.loadFromUri(M), fa.nets.faceRecognitionNet.loadFromUri(M)]);
  window.faceId = async (src) => {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const d = await fa.detectSingleFace(im, new fa.SsdMobilenetv1Options({ minConfidence: 0.3 })).withFaceLandmarks().withFaceDescriptor();
    return d ? Array.from(d.descriptor) : null;
  };
  return fa.version;
});

const pick = (meas) => {
  if (!meas) return null;
  const o = {};
  for (const k of F) o[k] = k[0] === 'w' ? meas.widths?.[+k.slice(1)] : meas[k];
  return o;
};
// 1. меры всех снимков набора (кэш — по содержимому photo-avatar.js: от него зависят меры)
const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'src/photo-avatar.js'))).digest('hex').slice(0, 12);
const CACHE = path.join(ROOT, `dev/resemblance-gallery-${hash}-${DELEGATE.toLowerCase()}.json`);
let gallery = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : null;
if (!gallery || gallery.hash !== hash || Object.keys(gallery.meas).length !== have.length) {
  process.stdout.write(`Меры ${have.length} снимков набора`);
  gallery = { hash, meas: {} };
  for (const p of have) {
    const m = await page.evaluate(async (src) => {
      try { const { analyzePortrait } = await import('/src/photo-avatar.js'); return (await analyzePortrait(src, {})).meas; } catch { return null; }
    }, `/dev/portraits/${p.id}.jpg`);
    if (m) gallery.meas[p.id] = pick(m);
    process.stdout.write('.');
  }
  fs.writeFileSync(CACHE, JSON.stringify(gallery));
  console.log();
}
const ids = Object.keys(gallery.meas);
const stat = {};
for (const k of F) {
  const xs = ids.map((i) => gallery.meas[i][k]).filter((v) => typeof v === 'number');
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  stat[k] = [mu, Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length) || 1];
}
const zOf = (m, c) => F.map((k) => (typeof m[k] === 'number' && (c ? typeof c[k] === 'number' : true) ? (m[k] - (c ? c[k] : stat[k][0])) / stat[k][1] : 0));
const cos = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / Math.sqrt(aa * bb + 1e-12); };
const Zg = Object.fromEntries(ids.map((i) => [i, zOf(gallery.meas[i])]));
// отпечатки снимков набора (кэш — по версии face-api: от фото они больше ни от чего не зависят)
const ID_CACHE = path.join(ROOT, `dev/resemblance-faceid-${FA_VER}.json`);
const idG = fs.existsSync(ID_CACHE) ? JSON.parse(fs.readFileSync(ID_CACHE, 'utf8')) : {};
if (have.some((p) => !(p.id in idG))) {
  process.stdout.write(`Отпечатки ${have.length} снимков набора (один раз, ~10 мин)`);
  for (const p of have) if (!(p.id in idG)) { idG[p.id] = await faceId(`/dev/portraits/${p.id}.jpg`); process.stdout.write('.'); }
  fs.writeFileSync(ID_CACHE, JSON.stringify(idG));
  console.log();
}
const idIds = have.map((p) => p.id).filter((i) => idG[i]);
const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

// силуэт причёски (14.5): фото и рендер анфас, выровненные по глазам и рту; маска волос фото (сегментатор) и точная маска
// мешей волос рендера (материалы волос — белым, остальное — чёрным); IoU масок. Причёски нет ни там, ни там — null
await page.evaluate(() => {
  window.__hairIoU = async () => {
    const PA = await import('/src/photo-avatar.js'), THREE = await import('three');
    const P = head._portrait, size = 240;
    if (!P?.hairMask) return null;
    const align = (L, w, h) => {
      const pt = (i) => ({ x: L[i].x * w, y: L[i].y * h }), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const eR = mid(pt(33), pt(133)), eL = mid(pt(362), pt(263)), c = mid(eR, eL), m = mid(pt(13), pt(14));
      return { c, roll: Math.atan2(eL.y - eR.y, eL.x - eR.x), k: (0.22 * size) / Math.hypot(m.x - c.x, m.y - c.y) };
    };
    const bits = (img, A) => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
      g.translate(0.5 * size, 0.5 * size); g.rotate(-A.roll); g.scale(A.k, A.k); g.translate(-A.c.x, -A.c.y); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, size, size).data, o = new Uint8Array(size * size);
      for (let i = 0; i < o.length; i++) o[i] = d[i * 4] > 127;
      return o;
    };
    const dp = await PA.detectFace(P.img);
    if (!dp) return null;
    const M = P.hairMask, mc = document.createElement('canvas'); mc.width = M.w; mc.height = M.h;
    const id = mc.getContext('2d').createImageData(M.w, M.h);
    for (let i = 0; i < M.w * M.h; i++) { const v = M.data[i] ? 255 : 0; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    mc.getContext('2d').putImageData(id, 0, 0);
    const big = document.createElement('canvas'); big.width = P.img.width; big.height = P.img.height; big.getContext('2d').drawImage(mc, 0, 0, big.width, big.height);
    const A = bits(big, align(dp.L, P.img.width, P.img.height));
    const rc = head._shotImage({}), dr = await PA.detectFace(rc);
    if (!dr) return null;
    const HM = new Set([head.rig.mat?.hair, head.rig.mat?.hairCards].filter(Boolean)), saved = [];
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), black = new THREE.MeshBasicMaterial({ color: 0 });
    head.rig.object3D.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material) || o.material.visible === false || o.material.colorWrite === false) return;
      saved.push([o, o.material]);
      o.material = HM.has(o.material) || /^hair/.test(o.name) ? (o.material.alphaMap ? new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: o.material.alphaMap, alphaTest: 0.35, side: THREE.DoubleSide }) : white) : black;
    });
    const bg = head.scene.background, env = head.scene.environment;
    head.scene.background = new THREE.Color(0); head.scene.environment = null;
    const mr = head._shotImage({});
    saved.forEach(([o, m]) => { o.material = m; }); head.scene.background = bg; head.scene.environment = env;
    const B = bits(mr, align(dr.L, rc.width, rc.height));
    let I = 0, U = 0;
    for (let i = 0; i < A.length; i++) { if (A[i] && B[i]) I++; if (A[i] || B[i]) U++; }
    return U ? +(I / U).toFixed(3) : null;
  };
});

// 2. головы по фото: рендер как в демо → разбор как у фото
const rows = [], shots = [];
for (const id of FACES) {
  const r = await page.evaluate(async (src, gender, opts) => {
    const { analyzePortrait } = await import('/src/photo-avatar.js');
    const shot = async () => {
      head.renderStill({}, {});
      const url = head.renderer.domElement.toDataURL('image/jpeg', 0.9);
      const P = await analyzePortrait(url, {});
      return { meas: P.meas, url };
    };
    try {
      head.options.look = {}; head.options.flat = false;
      head.options.quality = 'lite'; head._applyShadows(); head.setLighting(head.options.lighting);
      await head.fromPhoto(src, { gender, ...opts });
      head.setFraming('close'); head._applyEnv();
      const R = await shot();
      head.setPhotoOptions({ caricature: 0, expression: 0 });
      const B = await shot();
      return { R: R.meas, B: B.meas, url: R.url };
    } catch (e) { return { error: e.message }; }
  }, `/dev/portraits/${id}.jpg`, gender[id], OPTS);
  if (r.error) { console.log(`${id}  ошибка: ${r.error}`); rows.push({ id, error: r.error }); continue; }
  r.id = await faceId(r.url);
  const z = zOf(pick(r.R), pick(r.B));
  const order = ids.slice().sort((a, b) => cos(z, Zg[b]) - cos(z, Zg[a]));
  const row = { id, cos: +cos(z, Zg[id]).toFixed(3), rank: order.indexOf(id) + 1 };
  if (r.id && idG[id]) {
    row.idDist = +dist(r.id, idG[id]).toFixed(3);
    row.idRank = idIds.filter((i) => dist(r.id, idG[i]) < row.idDist).length + 1;
  }
  rows.push(row); shots.push({ id, url: r.url });
  console.log(`${id} ${gender[id].padEnd(6)}  cos ${row.cos.toFixed(3).padStart(6)}  место ${String(row.rank).padStart(3)}/${ids.length}` +
    (row.idDist ? `   отпечаток ${row.idDist.toFixed(3)}  место ${String(row.idRank).padStart(3)}/${idIds.length}` : '   отпечаток: лицо не найдено'));
}
// причёска — отдельным проходом: лишние вызовы распознавания между замерами сдвигают следующие замеры MediaPipe
for (const row of rows) {
  if (row.error) continue;
  row.hair = await page.evaluate(async (src, gender, opts) => {
    try {
      head.options.look = {}; head.options.flat = false;
      head.options.quality = 'lite'; head._applyShadows(); head.setLighting(head.options.lighting);
      await head.fromPhoto(src, { gender, ...opts });
      return await window.__hairIoU();
    } catch { return null; }
  }, `/dev/portraits/${row.id}.jpg`, gender[row.id], OPTS);
}
console.log('причёска (IoU):', rows.filter((r) => !r.error).map((r) => `${r.id.slice(0, 4)} ${r.hair ?? '—'}`).join(', '));
const ok = rows.filter((r) => !r.error);
const summary = {
  cos: +(ok.reduce((s, r) => s + r.cos, 0) / ok.length).toFixed(3),
  top1: ok.filter((r) => r.rank === 1).length, top5: ok.filter((r) => r.rank <= 5).length,
  pct: +(ok.reduce((s, r) => s + 100 * (1 - (r.rank - 1) / (ids.length - 1)), 0) / ok.length).toFixed(1),
  failed: rows.length - ok.length,
};
const okId = ok.filter((r) => r.idDist);
Object.assign(summary, {
  idDist: +(okId.reduce((s, r) => s + r.idDist, 0) / okId.length).toFixed(3),
  idTop1: okId.filter((r) => r.idRank === 1).length, idTop5: okId.filter((r) => r.idRank <= 5).length, idFailed: ok.length - okId.length,
});
console.log(`\nсреднее: cos ${summary.cos}, на 1-м месте ${summary.top1}/${ok.length}, в пятёрке ${summary.top5}/${ok.length}, человек похож больше остальных в среднем на ${summary.pct} %`);
console.log(`отпечаток: расстояние ${summary.idDist}, на 1-м месте ${summary.idTop1}/${okId.length}, в пятёрке ${summary.idTop5}/${okId.length}`);
// причёска: среднее IoU по всем 24 (нет причёски на рендере при волосах на фото — 0)
const okH = ok.filter((r) => r.hair !== null && r.hair !== undefined);
summary.hair = okH.length ? +(okH.reduce((s, r) => s + r.hair, 0) / okH.length).toFixed(3) : null;
console.log(`причёска: совпадение силуэта с фото (IoU) ${summary.hair} по ${okH.length} лицам`);

// лист «фото | голова»
const sheet = await page.evaluate(async (shots) => {
  const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  const W = 150, H = 190, cols = 4, c = document.createElement('canvas');
  c.width = cols * 2 * W; c.height = Math.ceil(shots.length / cols) * H;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < shots.length; i++) {
    const x = (i % cols) * 2 * W, y = Math.floor(i / cols) * H;
    const [ph, rd] = await Promise.all([load(`/dev/portraits/${shots[i].id}.jpg`), load(shots[i].url)]);
    const fit = (im, dx) => { if (!im) return; const s = Math.max(W / im.width, H / im.height), w = im.width * s, h = im.height * s; g.save(); g.beginPath(); g.rect(dx, y, W, H); g.clip(); g.drawImage(im, dx + (W - w) / 2, y + (H - h) / 2, w, h); g.restore(); };
    fit(ph, x); fit(rd, x + W);
  }
  return c.toDataURL('image/png');
}, shots);
fs.writeFileSync(path.join(ROOT, args.find((a) => a.startsWith('--sheet='))?.slice(8) || 'dev/resemblance-sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
await browser.close();
server.close();

const result = { date: new Date().toISOString(), opts: OPTS, delegate: DELEGATE, faceApi: FA_VER, summary, faces: Object.fromEntries(ok.map((r) => [r.id, { cos: r.cos, rank: r.rank, idDist: r.idDist, idRank: r.idRank, hair: r.hair }])) };
if (saveBase) { fs.writeFileSync(BASE, JSON.stringify(result, null, 1) + '\n'); console.log(`Базовая линия записана: ${path.relative(ROOT, BASE)}`); process.exit(0); }
if (!fs.existsSync(BASE)) { console.log('Базовой линии нет: npm run test:resemblance -- --save-baseline'); process.exit(0); }
const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
if ((b.delegate || 'смешанный') !== DELEGATE) { console.log(`Базовая линия записана в другом режиме MediaPipe (${b.delegate || 'смешанный'}), сейчас ${DELEGATE}: перезапишите её — --save-baseline`); process.exit(2); }
const worst = ok.map((r) => ({ ...r, d: r.cos - (b.faces[r.id]?.cos ?? r.cos) })).sort((x, y) => x.d - y.d).slice(0, 5);
console.log(`базовая линия (${b.date.slice(0, 10)}): cos ${b.summary.cos}, в пятёрке ${b.summary.top5}; хуже всего: ` + worst.map((r) => `${r.id} ${r.d >= 0 ? '+' : ''}${r.d.toFixed(2)}`).join(', '));
if (b.summary.idDist) console.log(`  отпечаток в базовой линии: расстояние ${b.summary.idDist}, в пятёрке ${b.summary.idTop5}`);
if (b.summary.hair != null) console.log(`  причёска в базовой линии: ${b.summary.hair}`);
const bad = summary.cos < b.summary.cos - 0.03 || summary.top5 < b.summary.top5 - 1 || summary.failed > (b.summary.failed || 0) ||
  (b.summary.idDist && (summary.idDist > b.summary.idDist + 0.02 || summary.idTop5 < b.summary.idTop5 - 2 || summary.idFailed > (b.summary.idFailed || 0))) ||
  (b.summary.hair != null && summary.hair < b.summary.hair - 0.03);
console.log(bad ? '✕ Сходство упало — см. dev/resemblance-sheet.png' : '✓ Сходство не хуже базовой линии');
process.exit(bad ? 1 : 0);
