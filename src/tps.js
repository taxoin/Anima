/** tps.js — тонкопластинчатый сплайн (thin-plate spline) на плоскости: проекция фото на голову и деформация по точкам лица. */

/** Тонкопластинчатый сплайн R² → R²: src[i] ↦ dst[i]. */
export function thinPlate(src, dst, lambda = 1e-5) {
  const n = src.length, N = n + 3;
  const A = Array.from({ length: N }, () => new Float64Array(N + 2));
  const U = (r2) => (r2 > 1e-12 ? r2 * Math.log(r2) : 0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U((src[i].x - src[j].x) ** 2 + (src[i].y - src[j].y) ** 2) + (i === j ? lambda : 0);
    A[i][n] = 1; A[i][n + 1] = src[i].x; A[i][n + 2] = src[i].y;
    A[n][i] = 1; A[n + 1][i] = src[i].x; A[n + 2][i] = src[i].y;
    A[i][N] = dst[i].x; A[i][N + 1] = dst[i].y;
  }
  // Гаусс с выбором главного элемента, две правые части
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k < N + 2; k++) A[r][k] -= f * A[c][k];
    }
  }
  const wx = new Float64Array(N), wy = new Float64Array(N);
  for (let i = 0; i < N; i++) { wx[i] = A[i][N] / A[i][i]; wy[i] = A[i][N + 1] / A[i][i]; }
  const sx = Float64Array.from(src, (p) => p.x), sy = Float64Array.from(src, (p) => p.y);
  return (x, y, out) => {
    let u = wx[n] + wx[n + 1] * x + wx[n + 2] * y, v = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const k = U((x - sx[i]) ** 2 + (y - sy[i]) ** 2);
      u += wx[i] * k; v += wy[i] * k;
    }
    out.x = u; out.y = v;
    return out;
  };
}

