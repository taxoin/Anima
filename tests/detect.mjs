/**
 * Точность детекторов по фото на размеченном наборе (tests/portraits/manifest.json).
 *
 *   npm run fetch:portraits        один раз: скачать снимки в dev/portraits/
 *   npm run test:detect            все детекторы
 *   npm run test:detect -- glasses beard    только эти
 *   npm run test:detect -- --errors         плюс список ошибок по каждому снимку
 *   npm run test:detect -- --save-baseline  записать результат как базовую линию (tests/portraits/baseline.json)
 *
 * Нужны Chrome ($CHROME) и сеть (MediaPipe: модели и wasm). Отчёт — в консоль и dev/detect-report.json.
 * Детекторы, которым нужен цвет (седина, зубы, открытый вырез), на ч/б и тонированных снимках не оцениваются.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), showErrors = args.includes('--errors'), saveBase = args.includes('--save-baseline'), only = args.filter((a) => !a.startsWith('--'));
const BASE = path.join(ROOT, 'tests/portraits/baseline.json'), base0 = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/portraits/manifest.json'), 'utf8'));
const portraits = manifest.portraits.filter((p) => fs.existsSync(path.join(ROOT, 'dev/portraits', p.id + '.jpg')));
if (!portraits.length) { console.error('Нет снимков: сначала npm run fetch:portraits'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`${base}/tests/render.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready === true', { timeout: 30000 });

// предсказания: то же, что видит fit() (детекторы photo-avatar.js)
const predict = (p) => page.evaluate(async (id, gender) => {
  try {
    await head.fromPhoto(`/dev/portraits/${id}.jpg`, { detail: 'full', gender });
    const P = head.portrait, ov = P._outfitOv(gender);
    return {
      bw: !!(P.grayscale || P.outfitRaw?.bw), yaw: P.yaw,
      glasses: !!P.glasses?.detected, hat: !!P.hat,
      beard: !!(P.beardStyle?.style && P.beardStyle.style !== 'none'),
      moustache: !!P.beardStyle?.moustache,
      gray: P.hairGray >= 1 ? 'full' : P.hairGray > 0 ? 'partial' : 'none',
      teeth: !!P.teethTone,
      outfit: ov.outfit === 'blazer' ? 'blazer' : ov.outfit === 'scoop' || ov.outfit === 'vneck' ? 'open' : 'other',
      tie: !!ov.tie,
      female: P.genderGuess ? (P.genderGuess()?.p ?? 0) > 0.5 : false, genderConfident: !!P.genderGuess?.()?.confident,
    };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}, p.id, p.labels.gender);

// детекторы: label/pred → значение; color — нужен цветной снимок
const DET = {
  glasses: { get: (o) => !!o.glasses },
  hat: { get: (o) => !!o.hat },
  beard: { get: (o) => !!o.beard },
  moustache: { get: (o) => !!o.moustache },
  gray: { get: (o) => o.gray !== 'none', color: true, multi: (o) => o.gray },
  teeth: { get: (o) => !!o.teeth, color: true },
  blazer: { get: (o) => o.outfit === 'blazer' },
  open: { get: (o) => o.outfit === 'open', color: true },
  tie: { get: (o) => !!o.tie, male: true },
  bw: { get: (o) => !!o.bw },
  female: { get: (o) => o.female === undefined ? o.gender === 'female' : !!o.female, label: (L) => L.gender === 'female' },   // пол (7.2): модель обучена на этом же наборе — цифры завышены, честная оценка в ROADMAP
};
const names = Object.keys(DET).filter((k) => !only.length || only.includes(k));

const rows = [];
let i = 0;
for (const p of portraits) {
  const pred = await predict(p);
  rows.push({ id: p.id, title: p.title, labels: p.labels, pred });
  process.stdout.write(`\r  ${++i}/${portraits.length}`);
}
process.stdout.write('\n');
await browser.close(); server.close();

const fmt = (v) => (v === null ? '  —  ' : (v * 100).toFixed(0).padStart(4) + ' %');
const report = { date: new Date().toISOString(), n: rows.length, failed: rows.filter((r) => r.pred.error).map((r) => ({ id: r.id, error: r.pred.error })), detectors: {} };
console.log(`\nСнимков: ${rows.length}, не распознано: ${report.failed.length}\n`);
console.log('детектор     n    да  точность  полнота   верно   ошибки' + (base0 ? '   Δ верно к базе' : ''));
for (const k of names) {
  const d = DET[k];
  const use = rows.filter((r) => !r.pred.error && (!d.color || !r.labels.bw) && (!d.male || r.labels.gender === 'male') && (d.label || r.labels[k === 'blazer' || k === 'open' ? 'outfit' : k] !== undefined));
  let tp = 0, fp = 0, fn = 0, tn = 0; const errs = [];
  for (const r of use) {
    const L = d.label ? d.label(r.labels) : k === 'blazer' || k === 'open' ? DET[k].get({ outfit: r.labels.outfit }) : d.get(r.labels), P = d.get(r.pred);
    if (L && P) tp++; else if (!L && P) { fp++; errs.push(`+ ${r.id} ${r.title}`); } else if (L && !P) { fn++; errs.push(`− ${r.id} ${r.title}`); } else tn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : null, rec = tp + fn ? tp / (tp + fn) : null, acc = use.length ? (tp + tn) / use.length : null;
  report.detectors[k] = { n: use.length, positives: tp + fn, tp, fp, fn, tn, precision: prec, recall: rec, accuracy: acc, errors: errs };
  const b = base0?.detectors?.[k], dAcc = b && acc !== null && b.accuracy !== null ? Math.round((acc - b.accuracy) * 100) : null;
  console.log(`${k.padEnd(10)} ${String(use.length).padStart(4)} ${String(tp + fn).padStart(5)}   ${fmt(prec)}   ${fmt(rec)}  ${fmt(acc)}   +${fp} −${fn}` + (dAcc === null ? '' : `   ${dAcc > 0 ? '+' : ''}${dAcc} п.п.`));
  if (showErrors && errs.length) console.log('    ' + errs.join('\n    '));
}
console.log('\n«+» — ложное срабатывание, «−» — пропуск. Подробно: npm run test:detect -- --errors');
fs.mkdirSync(path.join(ROOT, 'dev'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dev/detect-report.json'), JSON.stringify({ ...report, rows }, null, 1));
if (saveBase) {
  const slim = Object.fromEntries(Object.entries(report.detectors).map(([k, v]) => [k, { n: v.n, positives: v.positives, precision: v.precision, recall: v.recall, accuracy: v.accuracy, fp: v.fp, fn: v.fn }]));
  fs.writeFileSync(BASE, JSON.stringify({ date: report.date, n: report.n, detectors: { ...(base0?.detectors || {}), ...slim } }, null, 1) + '\n');
  console.log('Базовая линия записана: tests/portraits/baseline.json');
}
