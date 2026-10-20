/**
 * Подгонка глубины по профилю (7.5) без браузера: контур модели с известными параметрами, повёрнутый и
 * масштабированный в «пиксели», с шумом — как снимок; подгонка от стандартной головы должна вернуть параметры.
 *
 *   npm run test:profile
 */
import { modelCurve, fitProfile, PROFILE_PARAMS } from '../src/profile.js';

const CASES = [
  { gender: 'male', truth: { nose: 0.22, noseRoot: -0.6, noseHump: 0.6, noseUp: 0, lipPro: 0.5, lipDepthL: 0.6, chin: 0.13 }, ang: 0.1 },
  { gender: 'female', truth: { nose: 0.1, noseRoot: 0.8, noseHump: -0.5, noseUp: 0.8, lipPro: -0.6, lipDepthL: -0.4, chin: 0.02 }, ang: -0.08 },
  { gender: 'female', truth: { nose: 0.18, noseRoot: 0, noseHump: 0, noseUp: 0, lipPro: 1.0, lipDepthL: 1.0, chin: 0.16 }, ang: 0.05 },
];
// допуск по параметру — доля диапазона; хорошо определяются нос, горбинка, губы, подбородок; вздёрнутость слабее
const TOL = { nose: 0.08, noseRoot: 0.15, noseHump: 0.12, noseUp: 0.25, lipPro: 0.12, lipDepthL: 0.25, chin: 0.08 };

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
let fails = 0;
for (const [i, c] of CASES.entries()) {
  const s = 320, cs = Math.cos(c.ang), sn = Math.sin(c.ang);
  const photo = modelCurve(c.gender, c.truth).filter((_, k) => k % 2 === 0).reverse()
    .map(([y, z]) => [(cs * y - sn * z) * s + 40 + rnd() * 1.5, (sn * y + cs * z) * s - 900 + rnd() * 1.5, 1]);
  const t0 = performance.now(), r = fitProfile(photo, c.gender, {}), ms = performance.now() - t0;
  const bad = PROFILE_PARAMS.filter(([k, lo, hi]) => Math.abs(r.params[k] - c.truth[k]) > TOL[k] * (hi - lo));
  console.log(`${bad.length ? '✗' : '✓'} случай ${i + 1}: невязка ${r.rms0.toFixed(4)} → ${r.rms.toFixed(4)}, ${ms.toFixed(0)} мс` + (r.reliable ? '' : ' (ненадёжно)'));
  for (const [k] of PROFILE_PARAMS) console.log(`    ${k.padEnd(10)} ${String(c.truth[k]).padStart(5)} → ${String(r.params[k]).padStart(6)}${bad.some((b) => b[0] === k) ? '  ✗' : ''}`);
  if (bad.length || !r.reliable) fails++;
}
console.log(fails ? `\n${fails} из ${CASES.length} случаев не прошли` : '\nВсе параметры восстановлены.');
process.exit(fails ? 1 : 0);
