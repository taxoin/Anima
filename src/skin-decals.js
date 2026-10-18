/**
 * skin-decals.js — слой рисунка поверх кожи процедурной головы: макияж, веснушки, родинки, морщины, щетина.
 *
 * Рисуется в canvas в координатах головы (фронтальная проекция x, y) и умножается на цвет кожи в шейдере
 * (см. ProceduralHead._applyDecals). Работает и поверх фото-текстуры. Морфы и мимику не мешают: UV привязаны к вершинам.
 *
 *   look: { makeup: 'evening' | { blush, contour, eyeshadow, eyeliner, lipstick, gloss },
 *           freckles: 0..1, moles: 3 | [[x, y, r], …], age: 0..1, stubble: 0..1 }
 */
import { LAYOUT } from './head-model.js';

export const DECAL_BOUNDS = { x0: -1.2, x1: 1.2, y0: -1.4, y1: 1.2 };

/** Пресеты макияжа. Цвета умножаются на кожу (затемняют и окрашивают). */
export const MAKEUP = {
  natural: { blush: ['#e88a8a', 0.35], eyeshadow: ['#b08a7a', 0.25], eyeliner: 0.25, lipstick: null, gloss: 0.3 },
  day: { blush: ['#e67a80', 0.45], eyeshadow: ['#a8786a', 0.4], eyeliner: 0.45, lipstick: '#b85a64', gloss: 0.4 },
  evening: { blush: ['#d86070', 0.5], contour: 0.4, eyeshadow: ['#6a4a5a', 0.6], eyeliner: 0.85, wing: 0.7, lipstick: '#9a2438', gloss: 0.6 },
  smoky: { blush: ['#c87878', 0.3], contour: 0.35, eyeshadow: ['#3a3438', 0.8], eyeliner: 1, wing: 0.4, lipstick: '#9a6a68', gloss: 0.2 },
  bold: { blush: ['#e05a6a', 0.55], contour: 0.3, eyeshadow: ['#5a3a8a', 0.6], eyeliner: 0.9, wing: 1, lipstick: '#c21a3a', gloss: 0.8 },
};

/** Нужен ли слой вообще. */
export function hasDecals(P) {
  return !!(P.makeup || P.freckles || P.moles || P.age || P.stubble > 0.45);
}

/** Макияж из пресета/объекта → нормализованный объект или null. */
export function resolveMakeup(m) {
  if (!m) return null;
  if (typeof m === 'string') return MAKEUP[m] ? { ...MAKEUP[m] } : null;
  return { ...m };
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
};
/** Детерминированный ГПСЧ (веснушки и щетина одинаковы при каждой сборке). */
function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param {object} P   параметры головы (после resolveLook)
 * @param {object} E   глаз { x, y, r, rs }
 * @param {number} [size=1024]
 * @returns {HTMLCanvasElement}  белый фон = «без изменений» (умножение)
 */
export function drawDecals(P, E, size = 1024) {
  const B = DECAL_BOUNDS, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  const sx = size / (B.x1 - B.x0), sy = size / (B.y1 - B.y0);
  const X = (x) => (x - B.x0) * sx, Y = (y) => (B.y1 - y) * sy, R = (r) => r * sx;
  const MY = LAYOUT.mouthY, ex = E.x, ey = E.y;
  const blob = (x, y, rx, ry, color, a, rot = 0) => {
    g.save(); g.translate(X(x), Y(y)); g.rotate(rot); g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, R(rx));
    gr.addColorStop(0, rgba(color, a)); gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R(rx), 0, Math.PI * 2); g.fill(); g.restore();
  };
  const both = (fn) => { fn(1); fn(-1); };

  // ---- макияж
  const M = resolveMakeup(P.makeup);
  if (M) {
    if (M.blush) { const [col, a] = Array.isArray(M.blush) ? M.blush : ['#e07a80', M.blush]; both((s) => blob(s * 0.4, -0.2, 0.16, 0.11, col, a, s * -0.35)); }
    if (M.contour) both((s) => { blob(s * 0.5, -0.36, 0.2, 0.06, '#8a6a5a', M.contour * 0.5, s * 0.45); blob(s * 0.075, -0.08, 0.025, 0.14, '#9a7a6a', M.contour * 0.3); });
    if (M.eyeshadow) {                                         // на коже глазницы над веком (само веко красится в head-model)
      const [col, a] = Array.isArray(M.eyeshadow) ? M.eyeshadow : ['#8a6a7a', M.eyeshadow];
      both((s) => { blob(s * (ex + 0.02), ey + E.rs * 0.95, E.rs * 1.25, E.rs * 0.7, col, a * 0.9); blob(s * (ex + E.rs * 0.8), ey + E.rs * 0.5, E.rs * 0.6, E.rs * 0.45, col, a * 0.6); });
    }
    if (M.eyeliner && M.wing) {                                // «стрелка» за внешним углом глаза
      both((s) => {
        g.strokeStyle = rgba('#120c0c', clamp(M.eyeliner, 0, 1)); g.lineCap = 'round'; g.lineWidth = R(0.006 + 0.008 * M.eyeliner);
        // от края оболочки века (там кончается линия ресниц) вверх-наружу, к концу тоньше
        const x0 = s * (ex + E.rs * 0.98), y0 = ey + E.rs * 0.06, x1 = s * (ex + E.rs * (1.25 + 0.3 * M.wing)), y1 = ey + E.rs * (0.3 + 0.35 * M.wing);
        for (let k = 0; k < 3; k++) {
          g.lineWidth = R((0.009 + 0.006 * M.eyeliner) * (1 - k * 0.3));
          const t = k / 3, xa = x0 + (x1 - x0) * t * 0.5, ya = y0 + (y1 - y0) * t * 0.4;
          g.beginPath(); g.moveTo(X(xa), Y(ya)); g.quadraticCurveTo(X((x0 + x1) / 2), Y(y0 + (y1 - y0) * 0.35), X(x1), Y(y1)); g.stroke();
        }
      });
    }
  }

  // ---- веснушки: нос и щёки
  if (P.freckles > 0) {
    const r = rng(P.freckleSeed ?? 11), n = Math.round(260 * P.freckles);
    for (let i = 0; i < n; i++) {
      const s = r() < 0.5 ? -1 : 1, u = r(), v = r();
      // распределение: «бабочка» через переносицу на щёки
      const x = s * (0.02 + u * 0.42), y = -0.05 - v * 0.22 + 0.12 * Math.exp(-((x / 0.1) ** 2)) * (r() - 0.3);
      if (Math.abs(x) > 0.1 && Math.abs(x) < ex + 0.1 && y > ey - E.r * 1.2) continue;   // не на глазах
      const rr = 0.003 + r() * 0.006;
      g.fillStyle = rgba('#a0603c', (0.25 + r() * 0.35) * clamp(P.freckles * 1.5, 0.4, 1));
      g.beginPath(); g.ellipse(X(x), Y(y), R(rr), R(rr * (0.7 + r() * 0.5)), r() * 3, 0, Math.PI * 2); g.fill();
    }
  }

  // ---- родинки
  if (P.moles) {
    const r = rng(P.moleSeed ?? 5);
    const list = Array.isArray(P.moles) ? P.moles
      : Array.from({ length: Math.min(12, P.moles | 0) }, () => [(r() - 0.5) * 1.1, -0.85 + r() * 1.1, 0.006 + r() * 0.006]);
    for (const [x, y, rr = 0.008] of list) {
      g.fillStyle = rgba('#3a2418', 0.85); g.beginPath(); g.arc(X(x), Y(y), R(rr), 0, Math.PI * 2); g.fill();
      blob(x, y, rr * 1.8, rr * 1.8, '#5a3a28', 0.3);
    }
  }

  // ---- морщины (возраст): лоб, «гусиные лапки», под глазами, носогубка, у рта
  if (P.age > 0) {
    const a = clamp(P.age, 0, 1), line = (pts, w, al) => {
      g.strokeStyle = rgba('#6a4434', al * a); g.lineWidth = R(w); g.lineCap = 'round'; g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke();
    };
    g.filter = `blur(${Math.max(1, R(0.003))}px)`;
    for (let i = 0; i < 4; i++) { const y = 0.42 + i * 0.075; line([[-0.42, y - 0.01], [-0.2, y + 0.012], [0, y], [0.2, y + 0.012], [0.42, y - 0.01]], 0.005, 0.32 - i * 0.04); }
    both((s) => {
      for (let i = -1; i <= 1; i++) line([[s * (ex + E.rs * 1.05), ey + i * 0.02], [s * (ex + E.rs * 1.45), ey + i * 0.045 - 0.005]], 0.004, 0.35);
      line([[s * (ex - E.rs * 0.7), ey - E.rs * 1.05], [s * ex, ey - E.rs * 1.25], [s * (ex + E.rs * 0.7), ey - E.rs * 1.05]], 0.004, 0.28);
      line([[s * 0.1, -0.24], [s * 0.17, -0.36], [s * 0.24, -0.5], [s * 0.26, -0.58]], 0.007, 0.45);
      line([[s * 0.2, MY - 0.06], [s * 0.18, MY - 0.16]], 0.005, 0.3);
    });
    g.filter = 'none';
  }

  // ---- щетина: точки-волоски в зоне бороды (поверх затемнения вершинами)
  if (P.stubble > 0.45) {
    // лёгкая щетина (≤ 0.4) — только затемнение вершинами; точки-волоски нарастают с густотой
    const r = rng(P.stubbleSeed ?? 3), n = Math.round(9000 * clamp((P.stubble - 0.4) / 0.7, 0, 1.5));
    const col = P.beardColor || P.hair || '#2a1e18';
    for (let i = 0; i < n; i++) {
      const x = (r() - 0.5) * 1.3, y = -0.15 - r() * 1.05, ax = Math.abs(x);
      const lineY = -0.3 + 0.28 * Math.min(1, Math.max(0, (ax - 0.3) / 0.42));
      let m = y < lineY ? Math.min(1, (lineY - y) / 0.1) : 0;
      m = Math.max(m, Math.exp(-(((x) / 0.16) ** 2 + ((y + 0.42) / 0.045) ** 2) * 0.5));                  // усы
      if (Math.abs(x) < P.mouthHW * 1.02 && y < MY + (P.lipU || 0.04) + 0.008 && y > MY - (P.lipL || 0.06) - 0.008) m = 0;   // губы
      if (r() > m) continue;
      g.fillStyle = rgba(col, 0.22 + r() * 0.28);
      g.fillRect(X(x), Y(y), Math.max(1, R(0.0025)), Math.max(1, R(0.0025)));
    }
  }
  return c;
}
