/**
 * Statistical inference helpers used by the diagnostics and backtest.
 * Implemented here (not imported) so the console stays dependency-free and auditable.
 */

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax)
  return sign * y
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Two-sided p-value under the standard normal. */
export function twoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)))
}

export function linreg(xs: number[], ys: number[]): { slope: number; intercept: number; se: number; t: number; p: number } {
  const n = xs.length
  if (n < 3) return { slope: 0, intercept: 0, se: NaN, t: NaN, p: 1 }
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = my - slope * mx
  let sse = 0
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2
  const se = sxx === 0 ? NaN : Math.sqrt(sse / Math.max(1, n - 2) / sxx)
  const t = se > 0 ? slope / se : 0
  const p = Number.isFinite(t) ? twoSidedP(t) : 1
  return { slope, intercept, se, t, p }
}

/** Four-parameter logistic for the promotion campaign fit. */
export function logisticFit(xs: number[], ys: number[]): { base: number; top: number; mid: number; k: number } {
  // coarse grid search + local refinement. small data, so this is cheap and robust.
  let best = { base: 0, top: 0, mid: 0, k: 0 }
  let bestErr = Infinity
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  for (let base = minY * 0.9; base <= minY * 1.02; base += Math.max(1, minY * 0.01)) {
    for (let top = maxY * 0.98; top <= maxY * 1.15; top += Math.max(1, maxY * 0.02)) {
      for (let mid = 0.6; mid <= 3.2; mid += 0.08) {
        for (let k = 0.8; k <= 3.4; k += 0.08) {
          let err = 0
          for (let i = 0; i < xs.length; i++) {
            const pred = base + (top - base) / (1 + Math.exp(-k * (xs[i] - mid)))
            err += (pred - ys[i]) ** 2
          }
          if (err < bestErr) {
            bestErr = err
            best = { base, top, mid, k }
          }
        }
      }
    }
  }
  return best
}

export function logisticValue(x: number, p: { base: number; top: number; mid: number; k: number }): number {
  return p.base + (p.top - p.base) / (1 + Math.exp(-p.k * (x - p.mid)))
}
