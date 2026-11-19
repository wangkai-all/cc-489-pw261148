/**
 * Level-shift (breakpoint) detection on observed demand.
 *
 * Local interrupted-time-series test: in a ±42-day neighbourhood we fit
 *
 *     y_t = a + b·t + weekday_t + c·1{t ≥ τ} + ε_t
 *
 * Over a nine-week window the annual seasonal curve is close to linear, so the
 * local trend absorbs it; weekday dummies remove the calendar rhythm; c is the
 * level jump. A candidate is kept when the jump is ≥7%, statistically strong,
 * and the *following month* stays on the new level (a real step, not a spike or
 * a slow seasonal drift). Known outages and corrected outliers never qualify.
 */
import { diffDays } from '../lib/date'
import { mean } from '../lib/stats'
import { median } from './robust'
import type { SkuSeries } from '../data/dataset'

export interface Breakpoint {
  date: string
  before: number
  after: number
  changePct: number
  z: number
  beforeN: number
  afterN: number
  persistent: boolean
  status: 'confirmed' | 'transient'
  note: string
}

export interface BreakpointOptions {
  start: string
  end: string
  excluded: Set<string>
  trailingDays?: number
}

const SIDE = 42
const MIN_PERSIST = 21
const MIN_CHANGE = 0.07
const MIN_Z = 3.6

export function detectBreakpoints(series: SkuSeries, opts: BreakpointOptions): Breakpoint[] {
  const toIdx = series.dates.indexOf(opts.end) < 0 ? series.dates.length - 1 : series.dates.indexOf(opts.end)
  const trailing = opts.trailingDays ?? 365
  const fromIdx = Math.max(series.dates.indexOf(opts.start), toIdx - trailing)
  if (toIdx - fromIdx < SIDE * 2) return []

  const usable = (j: number) => series.actual[j] != null && !opts.excluded.has(series.dates[j])
  const candidates: Breakpoint[] = []

  for (let i = fromIdx + SIDE; i <= toIdx - MIN_PERSIST; i++) {
    if (!usable(i)) continue
    const ts: number[] = []
    const ys: number[] = []
    const post: number[] = []
    for (let j = i - SIDE; j < i + SIDE; j++) {
      if (j > toIdx || !usable(j)) continue
      ts.push(j - i)
      ys.push(series.actual[j] as number)
      post.push(j >= i ? 1 : 0)
    }
    const n = ys.length
    if (n < SIDE * 1.5) continue
    const cols: number[][] = [ts.map(() => 1), ts]
    for (let d = 1; d < 7; d++) {
      const dummies: number[] = []
      for (let j = i - SIDE; j < i + SIDE; j++) {
        if (j > toIdx || !usable(j)) continue
        dummies.push(new Date(`${series.dates[j]}T00:00:00Z`).getUTCDay() === d ? 1 : 0)
      }
      cols.push(dummies)
    }
    cols.push(post)
    const fit = ols(cols, ys)
    if (!fit) continue
    const { beta, se } = fit
    const c = beta[beta.length - 1]
    const z = c / Math.max(1e-9, se[se.length - 1])
    const preVals = ys.filter((_, k) => post[k] === 0)
    const level = mean(preVals)
    const change = c / Math.abs(level)
    if (Math.abs(change) < MIN_CHANGE || Math.abs(z) < MIN_Z) continue
    // Pre-period stability: fit a line through the 6 pre-weeks' medians. Allow
    // ordinary trend (<3%/week) but reject a ramp whose slope is a large share of
    // the claimed jump.
    const weekly: number[] = []
    for (let w = 0; w < 6; w++) {
      const lo = i - (6 - w) * 7
      const vals: number[] = []
      for (let j = lo; j < lo + 7; j++) if (usable(j)) vals.push(series.actual[j] as number)
      if (vals.length >= 4) weekly.push(median(vals))
    }
    if (weekly.length >= 5) {
      const macd = median(weekly.slice(-3)) / median(weekly.slice(0, 2)) - 1
      // allow ordinary trend drift (≤4%) but a step cannot hide inside a ramp
      if (Math.abs(macd) > 0.04) continue
      const spread = (Math.max(...weekly) - Math.min(...weekly)) / Math.abs(level)
      if (spread > 0.12) continue
    }

    // persistence: compare the 3 weeks *after* the transition month with the
    // pre-period level — a real step stays put, a one-off campaign decays.
    const settle: number[] = []
    const beginSettle = i + 28
    for (let j = beginSettle; j < Math.min(toIdx + 1, beginSettle + MIN_PERSIST); j++) if (usable(j)) settle.push(series.actual[j] as number)
    const lateLevel = settle.length >= 10 ? median(settle) : NaN
    const persistent =
      Number.isFinite(lateLevel) && Math.abs(lateLevel / level - 1) > Math.abs(change) * 0.55

    candidates.push({
      date: series.dates[i],
      before: level,
      after: level + c,
      changePct: change,
      z,
      beforeN: preVals.length,
      afterN: post.filter((p) => p === 1).length,
      persistent,
      status: persistent ? 'confirmed' : 'transient',
      note: persistent
        ? '阶跃在断点后持续，列入结构断点候选'
        : '阶跃快速回归，判定为短期波动，不改变模型',
    })
  }

  candidates.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  const chosen: Breakpoint[] = []
  for (const c of candidates) {
    if (chosen.some((x) => Math.abs(diffDays(x.date, c.date)) < 42)) continue
    chosen.push(c)
    if (chosen.length >= 3) break
  }
  return chosen.sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Small dense OLS with coefficient standard errors (Gaussian elimination). */
function ols(X: number[][], y: number[]): { beta: number[]; se: number[] } | null {
  const p = X.length
  const n = y.length
  if (n <= p + 3) return null
  const A = Array.from({ length: p }, (_, r) =>
    Array.from({ length: p }, (_, c) => {
      let s = 0
      for (let k = 0; k < n; k++) s += X[r][k] * X[c][k]
      return s
    }),
  )
  const b = X.map((row) => row.reduce((s, v, k) => s + v * y[k], 0))
  const inv = invert(A)
  if (!inv) return null
  const beta = inv.map((row) => row.reduce((s, v, k) => s + v * b[k], 0))
  let sse = 0
  for (let k = 0; k < n; k++) {
    let pred = 0
    for (let j = 0; j < p; j++) pred += beta[j] * X[j][k]
    sse += (y[k] - pred) ** 2
  }
  const s2 = sse / Math.max(1, n - p)
  const se = inv.map((row, j) => Math.sqrt(Math.max(1e-12, s2 * row[j])))
  return { beta, se }
}

function invert(m: number[][]): number[][] | null {
  const n = m.length
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-10) return null
    ;[a[pivot], a[col]] = [a[col], a[pivot]]
    const d = a[col][col]
    for (let c = 0; c < 2 * n; c++) a[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = a[r][col]
      if (!f) continue
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[col][c]
    }
  }
  return a.map((row) => row.slice(n))
}

export function summarizeBreak(bp: Breakpoint): string {
  const dir = bp.changePct > 0 ? '上升' : '下降'
  return `${bp.date} 起水平${dir} ${Math.abs(bp.changePct * 100).toFixed(1)}%（z=${bp.z.toFixed(1)}）`
}
