/** Small numerical toolkit — no dependencies, deterministic. */

export function mean(xs: number[]): number {
  if (!xs.length) return NaN
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** Median + 1.4826·MAD; robust to the outliers we are trying to find. */
export function mad(xs: number[]): number {
  const m = median(xs)
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)))
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const a = [...xs].sort((x, y) => x - y)
  const pos = (a.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return a[lo]
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  let s = 0
  for (const x of xs) s += (x - m) ** 2
  return Math.sqrt(s / (xs.length - 1))
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function round(x: number, digits = 0): number {
  const p = 10 ** digits
  return Math.round(x * p) / p
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(x * 100 >= 10 ? 0 : 1)}%`
}

export function fmtNum(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return '—'
  // Group with ASCII commas regardless of the runtime locale: zh-CN renders
  // 41,000 as "41.000", which reads as a decimal in this UI.
  const fixed = Math.abs(x).toFixed(digits)
  const [int, frac] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${x < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}

export function fmtCompact(x: number): string {
  if (!Number.isFinite(x)) return '—'
  if (Math.abs(x) >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`
  if (Math.abs(x) >= 10_000) return `${(x / 1000).toFixed(1)}K`
  return fmtNum(x)
}

/** Solve (XᵀX + λI)β = Xᵀy with Gaussian elimination + partial pivoting. */
export function solveRidge(X: number[][], y: number[], lambda: number): number[] {
  const p = X[0].length
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0))
  const b = new Array(p).fill(0)
  for (let r = 0; r < X.length; r++) {
    const xr = X[r]
    for (let i = 0; i < p; i++) {
      b[i] += xr[i] * y[r]
      for (let j = 0; j < p; j++) A[i][j] += xr[i] * xr[j]
    }
  }
  for (let i = 0; i < p; i++) A[i][i] += lambda

  for (let col = 0; col < p; col++) {
    let pivot = col
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    if (Math.abs(A[pivot][col]) < 1e-10) continue
    if (pivot !== col) {
      ;[A[pivot], A[col]] = [A[col], A[pivot]]
      ;[b[pivot], b[col]] = [b[col], b[pivot]]
    }
    const d = A[col][col]
    for (let r = col + 1; r < p; r++) {
      const f = A[r][col] / d
      if (f === 0) continue
      for (let c = col; c < p; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const beta = new Array(p).fill(0)
  for (let r = p - 1; r >= 0; r--) {
    if (Math.abs(A[r][r]) < 1e-10) continue
    let s = b[r]
    for (let c = r + 1; c < p; c++) s -= A[r][c] * beta[c]
    beta[r] = s / A[r][r]
  }
  return beta
}

/** Solve a symmetric positive-definite system via Cholesky (for the Kalman smoother). */
export function choleskySolve(A: number[][], b: number[]): number[] {
  const n = A.length
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-12))
      else L[i][j] = s / L[j][j]
    }
  }
  const y = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k]
    y[i] = s / L[i][i]
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]
    x[i] = s / L[i][i]
  }
  return x
}
