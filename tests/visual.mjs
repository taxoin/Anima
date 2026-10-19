/**
 * Визуальные регрессионные тесты: рендерим набор состояний головы и сравниваем со снимками-эталонами.
 *
 *   npm run test:visual            сравнить с tests/visual/ref/*.png
 *   npm run test:visual -- --update   перезаписать эталоны
 *   npm run test:visual -- smile      только кейсы, в имени которых есть «smile»
 *
 * Нужен Chrome/Chromium (путь: $CHROME, по умолчанию /usr/bin/google-chrome) и npm i (puppeteer-core).
 * Рендер идёт через SwiftShader, поэтому эталоны не зависят от видеокарты. three.js грузится с CDN.
 * Различия: пиксель «другой», если max |ΔRGB| > 24; кейс падает, если таких пикселей > 0,4 %.
 * Карты различий пишутся в tests/visual/out/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = path.join(ROOT, 'tests/visual/ref'), OUT = path.join(ROOT, 'tests/visual/out');
const args = process.argv.slice(2), update = args.includes('--update'), filter = args.filter((a) => !a.startsWith('--'));
const PIX_TOL = 24, FAIL_FRAC = 0.004;

const SMILE = { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, jawOpen: 0.18, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.3 };
const AA = { jawOpen: 0.55, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 };
export const CASES = [
  { name: 'female-neutral', gender: 'female' },
  { name: 'male-neutral', gender: 'male' },
  { name: 'female-smile', gender: 'female', channels: SMILE, framing: 'close' },
  { name: 'male-aa', gender: 'male', channels: AA, framing: 'close' },
  { name: 'female-look-down', gender: 'female', pose: { eyePitch: -0.35 }, framing: 'close' },
  { name: 'male-look-up-left', gender: 'male', pose: { eyePitch: 0.3, eyeYaw: 0.4 }, framing: 'close' },
  { name: 'female-tongue', gender: 'female', channels: { jawOpen: 0.45, tongueOut: 0.7 }, framing: 'close' },
  { name: 'female-porcelain-blue', gender: 'female', look: { skin: 'porcelain', iris: 'blue' } },
  { name: 'male-deep-heterochromia', gender: 'male', look: { skin: 'deep', iris: 'amber', irisRight: 'green' }, framing: 'close' },
  { name: 'female-eyes-round-glasses', gender: 'female', look: { eyeShape: 'round', glasses: 'round' }, framing: 'close' },
  { name: 'male-eyes-downturned-rect', gender: 'male', look: { eyeShape: 'downturned', glasses: 'rect' }, framing: 'close', pose: { yaw: 0.35 } },
  { name: 'female-tongue-up', gender: 'female', channels: { jawOpen: 0.3, tongueUp: 0.9 }, framing: 'close' },
  { name: 'female-makeup-evening-hoops', gender: 'female', look: { makeup: 'evening', earrings: 'hoop', hairStyle: 'bob' }, framing: 'close' },
  { name: 'male-full-beard-smile', gender: 'male', look: { beard: 'full', hair: '#5a3a24', age: 0.6 }, channels: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, jawOpen: 0.3 }, framing: 'close' },
  { name: 'male-walrus-fedora', gender: 'male', look: { beard: 'walrus', hat: 'fedora', hair: '#c8c4bc' } },
  { name: 'female-afro-freckles', gender: 'female', look: { hairStyle: 'afro', freckles: 0.7, skin: 'brown', eyeShape: 'monolid' } },
  { name: 'female-ponytail-side', gender: 'female', look: { hairStyle: 'ponytail', earrings: 'drop' }, pose: { yaw: 0.9 } },
  { name: 'avatar-truman-glasses', avatar: '/tests/fixtures/truman.anima.json', gender: 'male' },
  { name: 'avatar-lincoln', avatar: '/tests/fixtures/lincoln.anima.json', gender: 'male' },
  { name: 'avatar-monalisa-smile', avatar: '/tests/fixtures/monalisa.anima.json', channels: SMILE, framing: 'close' },
  // волна 4: деформация по точкам, нос, убор, пряди со спины (губы не просвечивают), роговица сбоку
  { name: 'avatar-lincoln-shape', avatar: '/tests/fixtures/lincoln-shape.anima.json', gender: 'male' },
  { name: 'male-roman-nose-profile', gender: 'male', look: { noseShape: 'roman' }, pose: { yaw: 1.25 } },
  { name: 'female-snub-bowler', gender: 'female', look: { noseShape: 'snub', hat: 'bowler', hairStyle: 'bob' }, pose: { yaw: 0.5 } },
  { name: 'female-bob-back', gender: 'female', look: { hairStyle: 'bob', hair: '#a87a4a' }, pose: { yaw: 2.6 } },
  { name: 'female-cornea-side', gender: 'female', framing: 'close', pose: { yaw: -0.6, eyeYaw: 0.45 } },
  // детализация для телефонов
  { name: 'male-medium-beard', gender: 'male', detail: 'medium', look: { beard: 'full' }, channels: SMILE },
  { name: 'avatar-lincoln-low', avatar: '/tests/fixtures/lincoln-shape.anima.json', gender: 'male', detail: 'low' },
  { name: 'female-low-contempt-jaw', gender: 'female', detail: 'low', channels: { mouthDimpleRight: 0.7, mouthSmileRight: 0.38, noseSneerRight: 0.1, jawOpen: 0.3, jawLeft: 0.5, mouthFunnel: 0.4 }, framing: 'close' },
  { name: 'female-bob-streaks', gender: 'female', look: { hair: '#8a6a3a', hairStreaks: 0.8, hairStyle: 'bob' }, pose: { yaw: 0.5 } },
  { name: 'male-gray-salt-pepper-beard', gender: 'male', look: { hair: '#2a1f18', hairGray: 0.45, beard: 'full' } },
  { name: 'female-pupil-dilated-side', gender: 'female', channels: { pupil: 1.5 }, framing: 'close', pose: { yaw: 0.45 } },
  { name: 'male-pupil-constricted-nocornea', gender: 'male', look: { cornea: false, iris: 'blue' }, channels: { pupil: -1 }, framing: 'close' },
  { name: 'female-eye-asymmetry', gender: 'female', look: { eyeOpenL: 1.15, eyeOpenR: 0.87, eyeLiftL: 3, eyeLiftR: -3 }, framing: 'close' },
  { name: 'female-lip-asymmetry', gender: 'female', look: { mouthCornerL: 0.015, mouthCornerR: -0.01, lipLAsym: 0.25, lipLoShape: 3.5 }, framing: 'close' },
  { name: 'female-braces-smile', gender: 'female', look: { braces: true }, channels: { ...SMILE, jawOpen: 0.22, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3 }, framing: 'close' },
  { name: 'male-gap-crooked-yellow', gender: 'male', look: { teethGap: 1, teethCrooked: 1, teethColor: 'yellow' }, channels: AA, framing: 'close' },
  { name: 'female-lips-protruding-profile', gender: 'female', look: { lipProfile: 'protruding' }, pose: { yaw: 1.2 } },
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=600,700'],
});
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/GL Driver|favicon/.test(m.text()) && errors.push(m.text()));
await page.goto(`${base}/tests/render.html`, { waitUntil: 'networkidle0' });
try { await page.waitForFunction('window.ready === true', { timeout: 30000 }); }
catch (e) { console.error('Стенд не загрузился:\n  ' + (errors.join('\n  ') || e.message)); await browser.close(); server.close(); process.exit(2); }

fs.mkdirSync(REF, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const c of CASES.filter((c) => !filter.length || filter.some((f) => c.name.includes(f)))) {
  const png = await page.evaluate((c) => window.renderCase(c), c);
  const buf = Buffer.from(png.split(',')[1], 'base64');
  const refFile = path.join(REF, c.name + '.png');
  if (update || !fs.existsSync(refFile)) { fs.writeFileSync(refFile, buf); console.log(`  ✎ ${c.name} — эталон записан`); continue; }
  const ref = 'data:image/png;base64,' + fs.readFileSync(refFile).toString('base64');
  const r = await page.evaluate(async (a, b, tol) => {
    const load = async (u) => createImageBitmap(await (await fetch(u)).blob());
    const [A, B] = await Promise.all([load(a), load(b)]);
    if (A.width !== B.width || A.height !== B.height) return { frac: 1, size: true };
    const w = A.width, h = A.height, cv = new OffscreenCanvas(w, h), g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, w, h).data;
    g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, w, h);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db.data[i]), Math.abs(da[i + 1] - db.data[i + 1]), Math.abs(da[i + 2] - db.data[i + 2]));
      if (d > tol) { bad++; db.data[i] = 255; db.data[i + 1] = 0; db.data[i + 2] = 255; }
      else { const l = (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 9; db.data[i] = db.data[i + 1] = db.data[i + 2] = l; }
    }
    g.putImageData(db, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    const diff = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    return { frac: bad / (w * h), diff };
  }, png, ref, PIX_TOL);
  fs.writeFileSync(path.join(OUT, c.name + '.png'), buf);
  if (r.diff) fs.writeFileSync(path.join(OUT, c.name + '.diff.png'), Buffer.from(r.diff.split(',')[1], 'base64'));
  const ok = r.frac <= FAIL_FRAC;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name} — ${(r.frac * 100).toFixed(2)} % пикселей отличается${r.size ? ' (другой размер)' : ''}`);
}
await browser.close();
server.close();
if (errors.length) { console.log('Ошибки страницы:\n  ' + errors.join('\n  ')); failed++; }
console.log(failed ? `\n${failed} проблем(ы). Карты различий: tests/visual/out/` : '\nВсё совпадает.');
process.exit(failed ? 1 : 0);
