/**
 * Скачивает размеченный набор портретов (tests/portraits/manifest.json) в dev/portraits/ (не в git).
 *
 *   npm run fetch:portraits
 *
 * Снимки — с Wikimedia Commons, свободные лицензии (общественное достояние, CC0, CC BY, CC BY-SA); источник,
 * автор и лицензия каждого — в манифесте. Берутся превью шириной 640 px. Уже скачанные файлы не перекачиваются.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/portraits/manifest.json'), 'utf8'));
const DIR = path.join(ROOT, 'dev/portraits');
fs.mkdirSync(DIR, { recursive: true });
const UA = { 'User-Agent': 'AnimaBench/0.1 (portrait test set; https://github.com/taxoin/Anima)' };

let got = 0, have = 0, failed = 0;
for (const p of manifest.portraits) {
  const file = path.join(DIR, p.id + '.jpg');
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) { have++; continue; }
  try {
    const r = await fetch(p.thumb, { headers: UA });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    got++;
    await new Promise((res) => setTimeout(res, 150));          // бережно к Commons
  } catch (e) { failed++; console.error(`  ✗ ${p.id} ${p.title}: ${e.message}`); }
}
console.log(`Портреты: скачано ${got}, уже было ${have}, ошибок ${failed} (всего ${manifest.portraits.length}) → dev/portraits/`);
process.exit(failed ? 1 : 0);
