/**
 * Калибровка основы фото-аватара через рендер: при caricature = 0 и realism = 1 голова должна совпадать
 * со «средним лицом» (MEAN_M) по бровям, носу, губам. Ищет поправки мер для каждого портрета, усредняет
 * по полу и печатает BASE_CORR для src/photo-avatar.js.
 *
 *   node tests/calibrate.mjs dev/faces     (папка с портретами внутри репозитория; имена → пол см. MALE ниже)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(ROOT, 'docs/samples'));
const MALE = /obama|biden|clinton|einstein|lincoln|tesla|truman|gandhi|roosevelt|twain|male|man/i;
const CAL = ['browY', 'browArch', 'browTail', 'browX0', 'browX1', 'browTh', 'noseTip', 'noseW', 'mouthHW', 'lipU', 'lipL'];
const photos = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript' }[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 700 });
await page.goto(`http://127.0.0.1:${server.address().port}/tests/render.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready === true');
const acc = { female: [], male: [] };
for (const f of photos) {
  const gender = MALE.test(f) ? 'male' : 'female';
  const src = '/' + path.relative(ROOT, path.join(dir, f)).split(path.sep).join('/');
  const r = await page.evaluate(async (src, gender, CAL) => {
    const { measureFace, refineStep, MEAN_M } = await import('/src/photo-avatar.js');
    await head.fromPhoto(src, { caricature: 0, realism: 1, gender });
    head.portrait.noBase = true; head.portrait._corrV = 1;   // с нуля: без текущей BASE_CORR
    const P = head.portrait, corr = { meas: {}, widths: [0, 0, 0, 0, 0, 0] }, errs = [];
    let best = { err: Infinity, meas: {}, widths: [] };
    for (let it = 0; it < 5; it++) {
      head._rebuildRig();
      const R = measureFace(await head._shotFace());
      const snap = { meas: { ...corr.meas }, widths: [...corr.widths] };
      // цель: среднее лицо по мерам и средняя ширина овала (widths = 1 — медиана калибровочных фото)
      const e = refineStep(P, corr, R, null, 0, { target: { meas: MEAN_M, widths: [1, 1, 1, 1, 1, 1] }, meas: CAL, alpha: 0.7 });
      const ew = Math.sqrt(R.widths.slice(1).reduce((s, w) => s + (w - 1) ** 2, 0) / 5) * 10;   // ошибка ширины (×10 ≈ сопоставимо)
      errs.push(+(e + ew).toFixed(3));
      if (e + ew < best.err) best = { err: e + ew, ...snap };
      P.corr = { meas: { ...corr.meas }, widths: [...corr.widths] }; P._corrV = (P._corrV || 0) + 1;
    }
    return { errs, meas: best.meas, widths: best.widths };
  }, src, gender, CAL);
  console.log(f.padEnd(14), gender.padEnd(6), r.errs.join(' → '));
  acc[gender].push({ ...r.meas, widths: r.widths });
}
const out = {};
for (const g of ['female', 'male']) {
  out[g] = {};
  for (const k of CAL) { const v = acc[g].map((m) => m[k] || 0); if (v.length) out[g][k] = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4); }
  if (acc[g].length) out[g].widths = [0, 1, 2, 3, 4, 5].map((i) => +(acc[g].reduce((a, m) => a + (m.widths[i] || 0), 0) / acc[g].length).toFixed(4));
}
console.log('\nconst BASE_CORR = ' + JSON.stringify(out).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ') + ';');
await browser.close();
server.close();
