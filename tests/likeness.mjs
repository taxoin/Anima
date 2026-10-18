/**
 * Метрика сходства фото-аватара на наборе портретов: рендер головы → те же 478 точек → сравнение с фото.
 *
 *   npm run test:likeness                    портреты из docs/samples
 *   npm run test:likeness -- path/to/dir     все .jpg/.png из папки (внутри репозитория)
 *   npm run test:likeness -- --k=0,1,1.5,2.5 значения шаржа;  --realism=0.8 — основа ближе к реальным пропорциям
 * Пол для известных имён (obama, lincoln…) — мужской, иначе женский.
 *
 * Колонки: rms — расхождение точек в % расстояния глаза–рот (меньше — ближе), по зонам: овал, глаза, брови, нос, губы;
 * dir — косинус «отличия человека от среднего» ↔ «отличия головы от своей основы» (1 — идеально);
 * gain — во сколько раз отличия усилены (в идеале ≈ caricature).
 * Нужны Chrome ($CHROME) и сеть (three.js и модели MediaPipe с CDN).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const RE = +(args.find((a) => a.startsWith('--realism='))?.slice(10) || NaN);
const K = (args.find((a) => a.startsWith('--k='))?.slice(4) || '0,1,1.5,2.5').split(',').map(Number);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs/samples'));
if (!dir.startsWith(ROOT)) { console.error('Папка должна быть внутри репозитория (её раздаёт локальный сервер).'); process.exit(2); }
const photos = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => '/' + path.relative(ROOT, path.join(dir, f)).split(path.sep).join('/'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 700 });
await page.goto(`http://127.0.0.1:${server.address().port}/tests/render.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready === true', { timeout: 30000 });

const pad = (v, n = 6) => String(v ?? '—').padStart(n);
console.log(`${'фото'.padEnd(16)} ${'k'.padStart(4)} ${pad('rms')} ${pad('овал')} ${pad('глаза')} ${pad('брови')} ${pad('нос')} ${pad('губы')} ${pad('dir')} ${pad('gain')}`);
const sum = {};
for (const ph of photos) {
  for (const k of K) {
    const r = await page.evaluate(async (ph, k, re) => {
      try {
        const male = /obama|biden|clinton|einstein|lincoln|tesla|truman|gandhi|roosevelt|twain/i.test(ph), o = { caricature: k, gender: male ? 'male' : 'female' };
        if (re === re) o.realism = re;
        if (!head.portrait || head.__src !== ph) { await head.fromPhoto(ph, o); head.__src = ph; }
        else head.setPhotoOptions(o);
        return await head.likeness({ base: k !== 0 });
      } catch (e) { return { error: e.message }; }
    }, ph, k, RE);
    const name = path.basename(ph).padEnd(16);
    if (r.error) { console.log(`${name} ${pad(k, 4)}  ошибка: ${r.error}`); continue; }
    const g = r.regions;
    console.log(`${name} ${pad(k, 4)} ${pad(r.rms)} ${pad(g.oval)} ${pad(g.eyes)} ${pad(g.brows)} ${pad(g.nose)} ${pad(g.lips)} ${pad(r.direction)} ${pad(r.gain)}`);
    const s = (sum[k] ||= { n: 0, rms: 0, dir: 0, nd: 0, reg: {} });
    s.n++; s.rms += r.rms;
    for (const z in g) s.reg[z] = (s.reg[z] || 0) + g[z]; if (r.direction !== null) { s.dir += r.direction; s.nd++; }
  }
}
console.log('\nсреднее:');
for (const k of K) { const s = sum[k]; if (s) console.log(`  k=${k}: rms ${(s.rms / s.n).toFixed(2)}${s.nd ? `, dir ${(s.dir / s.nd).toFixed(3)}` : ''} | ` + Object.entries(s.reg).map(([z, v]) => `${z} ${(v / s.n).toFixed(1)}`).join(', ')); }
await browser.close();
server.close();
