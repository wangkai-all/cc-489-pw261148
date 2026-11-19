/**
 * Structural demand model: weighted ridge regression over calendar, Fourier
 * seasonality and promotion covariates.
 *
 * The file is split into a design builder, a weighted solver and a "finalize"
 * step so the incremental engine (engine.ts) can reuse cached sufficient
 * statistics for segments that did not change.
 */
import { weekday } from '../lib/date'
import { clamp, mean, solveRidge, stdev } from '../lib/stats'
import { mulberry32 } from '../lib/rng'
import type { FeatureId, SkuMeta, SkuSeries } from '../data/dataset'

export type Strategy = 'impute' | 'downweight' | 'block'
export type ModelKind = 'full' | 'nocov' | 'window'

export interface TreatmentPlan {
  demand: Strategy
  covariates: Record<FeatureId, Strategy>
}

export interface ModelConfig {
  kind: ModelKind
  start: string
  end: string
  lambda: number
  seasonality: boolean
  promotion: boolean
  /** Training rows inside these spans are excluded and never imputed. */
  blockedSpans: { start: string; end: string }[]
}

export interface DesignRow {
  date: string
  index: number
  x: number[]
  y: number | null
  weight: number
  /** true when y came from imputation rather than an observation. */
  imputed: boolean
  /** true when the row is excluded from the fit (blocked). */
  blocked: boolean
}

export interface Design {
  rows: DesignRow[]
  names: string[]
  covariateNames: string[]
  droppedFeatures: FeatureId[]
  imputations: { date: string; method: string; value: number }[]
  blockedDays: number
  imputedDays: number
  startIdx: number
  endIdx: number
  holidayProfile: number
}

export interface ForecastPoint {
  date: string
  yhat: number
  lo80: number
  hi80: number
  lo95: number
  hi95: number
  width80: number
}

export interface ForecastResult {
  predictions: ForecastPoint[]
  fitted: { date: string; yhat: number; actual: number | null; imputed: boolean }[]
  config: ModelConfig
  treatment: TreatmentPlan
  trainN: number
  effectiveN: number
  blockedDays: number
  imputedDays: number
  beta: number[]
  names: string[]
  sigma: number
  mapeInSample: number
  biasInSample: number
  featureShare: Record<string, number>
  imputations: { date: string; method: string; value: number }[]
  droppedFeatures: FeatureId[]
  diagnostics: { lag1: number; r2: number; maxAbsZ: number; durbinWatson: number }
  designHash: string
}

export const FORECAST_END = '2026-12-13'
export const DEFAULT_WINDOW = { start: '2025-06-01', end: '2026-11-15' }

export function defaultConfig(): ModelConfig {
  return {
    kind: 'full',
    start: DEFAULT_WINDOW.start,
    end: DEFAULT_WINDOW.end,
    lambda: 1.2,
    seasonality: true,
    promotion: true,
    blockedSpans: [],
  }
}

export function defaultTreatment(): TreatmentPlan {
  return {
    demand: 'impute',
    covariates: { promo: 'downweight', marketing: 'block', holiday: 'impute', organic: 'impute' },
  }
}

export function hashString(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function designNames(cfg: ModelConfig): string[] {
  const names = ['截距', '趋势', '趋势²']
  for (let d = 1; d < 7; d++) names.push(`周${['日', '一', '二', '三', '四', '五', '六'][d]}`)
  if (cfg.seasonality) for (const k of [1, 2, 3]) names.push(`季节sin${k}`, `季节cos${k}`)
  return names
}

/** All candidate covariate columns, in a fixed order so betas can be interpreted. */
export const MODEL_COVARIATES: { id: FeatureId; label: string }[] = [
  { id: 'promo', label: '促销折扣' },
  { id: 'marketing', label: '营销投放' },
  { id: 'holiday', label: '节假日' },
]

export interface DesignOptions {
  /** Imputed covariate columns (same length as series.dates). */
  overrides?: Partial<Record<FeatureId, (number | null)[]>>
  /** Values supplied by a replenishment patch for demand. */
  demandPatch?: Record<string, number>
}

export function buildDesign(series: SkuSeries, cfg: ModelConfig, treatment: TreatmentPlan, opts: DesignOptions = {}): Design {
  const dates = series.dates
  const startIdx = Math.max(0, dates.indexOf(cfg.start))
  const endIdx = Math.max(startIdx, dates.indexOf(cfg.end))
  const blocked = (iso: string) => cfg.blockedSpans.some((s) => iso >= s.start && iso <= s.end)
  const useCov = cfg.promotion && cfg.kind !== 'nocov'

  const droppedFeatures: FeatureId[] = MODEL_COVARIATES.filter((c) => treatment.covariates[c.id] === 'block').map((c) => c.id)
  const kept = MODEL_COVARIATES.filter((c) => !droppedFeatures.includes(c.id))
  const covariateNames = kept.map((c) => c.label)
  const names = [...designNames(cfg), ...(useCov ? covariateNames : [])]

  const demand: (number | null)[] = series.actual.slice()
  for (const [date, value] of Object.entries(opts.demandPatch ?? {})) {
    const i = dates.indexOf(date)
    if (i >= 0) demand[i] = value
  }

  const imputations: Design['imputations'] = []
  let blockedDays = 0
  let imputedDays = 0

  // Covariate columns, with per-feature treatment.
  const covValues: Record<string, (number | null)[]> = {}
  for (const c of kept) {
    const col = (opts.overrides?.[c.id] ?? series.units.map((u) => u[c.id])) as (number | null)[]
    covValues[c.id] = col
  }

  const weekdayFactor = (i: number): number => {
    const wd = weekday(dates[i])
    const ratios: number[] = []
    for (let j = startIdx; j <= endIdx; j++) {
      if (j === i || j < i - 21 || j > i + 21) continue
      if (weekday(dates[j]) !== wd) continue
      const v = demand[j]
      const p = demand[j - 1]
      const n = demand[j + 1]
      if (v == null || p == null || n == null) continue
      ratios.push(v / ((p + n) / 2))
    }
    if (!ratios.length) return 1
    const s = [...ratios].sort((a, b) => a - b)
    return clamp(s[s.length >> 1], 0.75, 1.3)
  }

  const fillDemand = (i: number): { value: number; method: string } => {
    let left = i - 1
    while (left >= startIdx && demand[left] == null) left--
    let right = i + 1
    while (right <= endIdx && demand[right] == null) right++
    const lv = left >= startIdx ? demand[left] : null
    const rv = right <= endIdx ? demand[right] : null
    if (lv != null && rv != null) {
      const ratio = (i - left) / (right - left)
      const linear = lv + (rv - lv) * ratio
      return { value: Math.max(10, linear * weekdayFactor(i)), method: '线性插值 × 星期系数' }
    }
    if (lv != null) return { value: lv, method: '前向填充' }
    if (rv != null) return { value: rv, method: '后向填充' }
    return { value: 500, method: '窗口均值' }
  }

  const rows: DesignRow[] = []
  for (let i = startIdx; i <= endIdx; i++) {
    const iso = dates[i]
    const isBlocked = blocked(iso)
    let y = demand[i]
    let imputed = false
    if (isBlocked) {
      blockedDays++
      rows.push({ date: iso, index: i, x: [], y: null, weight: 0, imputed: false, blocked: true })
      continue
    }
    if (y == null) {
      if (treatment.demand === 'block') {
        blockedDays++
        rows.push({ date: iso, index: i, x: [], y: null, weight: 0, imputed: false, blocked: true })
        continue
      }
      const f = fillDemand(i)
      y = f.value
      imputed = true
      imputedDays++
      imputations.push({ date: iso, method: f.method, value: Math.round(f.value) })
    }

    const t = (i - startIdx) / 365
    const x: number[] = [1, t, t * t]
    const wd = weekday(iso)
    for (let d = 1; d < 7; d++) x.push(wd === d ? 1 : 0)
    if (cfg.seasonality) {
      for (const k of [1, 2, 3]) {
        x.push(Math.sin((2 * Math.PI * k * i) / 365), Math.cos((2 * Math.PI * k * i) / 365))
      }
    }

    let weight = 1
    if (imputed) {
      weight = treatment.demand === 'downweight' ? 0.32 : 0.8
      if (treatment.demand === 'block') weight = 1
    }
    if (cfg.kind === 'window') {
      weight *= 0.5 + 0.5 * ((i - startIdx) / Math.max(1, endIdx - startIdx))
    }

    if (useCov) {
      for (const c of kept) {
        const raw = covValues[c.id][i]
        let value: number
        if (raw == null) {
          // Treatment for a missing covariate: block drops the column (handled above);
          // impute fills a neutral value; downweight fills and penalises the row.
          value = c.id === 'promo' ? 0 : c.id === 'marketing' ? 3.2 : 1
        } else {
          value = c.id === 'marketing' ? raw / 1000 : raw
        }
        if (c.id === 'marketing') weight *= Math.sqrt(treatment.covariates[c.id] === 'downweight' ? 0.55 : 1)
        if (c.id === 'holiday') weight *= Math.sqrt(treatment.covariates[c.id] === 'downweight' ? 0.85 : 1)
        x.push(value)
      }
    }

    rows.push({ date: iso, index: i, x, y, weight, imputed, blocked: false })
  }

  const holidayProfile = 0
  return {
    rows,
    names,
    covariateNames,
    droppedFeatures,
    imputations,
    blockedDays,
    imputedDays,
    startIdx,
    endIdx,
    holidayProfile,
  }
}

export interface SufficientStats {
  n: number
  dim: number
  XtX: number[][]
  Xty: number[]
  yty: number
  ySum: number
  days: number
}

export function emptyStats(dim: number): SufficientStats {
  return {
    n: 0,
    dim,
    XtX: Array.from({ length: dim }, () => new Array(dim).fill(0)),
    Xty: new Array(dim).fill(0),
    yty: 0,
    ySum: 0,
    days: 0,
  }
}

export function accumulate(stats: SufficientStats, rows: DesignRow[]): SufficientStats {
  const out: SufficientStats = {
    n: stats.n,
    dim: stats.dim,
    XtX: stats.XtX.map((r) => [...r]),
    Xty: [...stats.Xty],
    yty: stats.yty,
    ySum: stats.ySum,
    days: stats.days,
  }
  for (const row of rows) {
    if (row.blocked || row.y == null) continue
    const s = Math.sqrt(row.weight)
    const x = row.x
    const y = row.y * s
    for (let a = 0; a < x.length; a++) {
      const xa = x[a] * s
      out.Xty[a] += xa * y
      for (let b = a; b < x.length; b++) out.XtX[a][b] += xa * x[b] * s
    }
    out.yty += y * y
    out.ySum += y
    out.n++
    out.days++
  }
  for (let a = 0; a < out.dim; a++) for (let b = 0; b < a; b++) out.XtX[a][b] = out.XtX[b][a]
  return out
}

/** Centre unscaled? No — ridge on raw features, with the intercept unpenalised. */
export function solveStats(stats: SufficientStats, lambda: number): number[] {
  const p = stats.dim
  const XtX = stats.XtX.map((r) => [...r])
  for (let i = 1; i < p; i++) XtX[i][i] += lambda
  XtX[0][0] += 1e-8
  const beta = new Array(p).fill(0)
  // build a fake design matrix? no: solve directly with Gaussian elimination
  const A = XtX
  const b = [...stats.Xty]
  for (let col = 0; col < p; col++) {
    let pivot = col
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    if (Math.abs(A[pivot][col]) < 1e-12) continue
    if (pivot !== col) {
      ;[A[pivot], A[col]] = [A[col], A[pivot]]
      ;[b[pivot], b[col]] = [b[col], b[pivot]]
    }
    const d = A[col][col]
    for (let r = col + 1; r < p; r++) {
      const f = A[r][col] / d
      if (!f) continue
      for (let c = col; c < p; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  for (let r = p - 1; r >= 0; r--) {
    if (Math.abs(A[r][r]) < 1e-12) continue
    let s = b[r]
    for (let c = r + 1; c < p; c++) s -= A[r][c] * beta[c]
    beta[r] = s / A[r][r]
  }
  return beta
}

function lag1Coefficient(residuals: number[]): number {
  if (residuals.length < 3) return 0
  const a = residuals.slice(1)
  const b = residuals.slice(0, -1)
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export interface FinalizeOptions {
  forecastDates: string[]
  holidayMultiplier: (iso: string) => number
  forecastCovariates: { promo: number; marketing: number; holiday: number }
}

export function finalize(
  beta: number[],
  design: Design,
  cfg: ModelConfig,
  treatment: TreatmentPlan,
  opts: FinalizeOptions,
): ForecastResult {
  const rows = design.rows.filter((r) => !r.blocked && r.y != null)
  const fitted = rows.map((r) => {
    const yhat = dot(r.x, beta)
    return { date: r.date, yhat, actual: r.y, imputed: r.imputed }
  })
  const observedResiduals: number[] = []
  const allResiduals: number[] = []
  for (const r of rows) {
    const err = (r.y as number) - dot(r.x, beta)
    allResiduals.push(err)
    if (!r.imputed) observedResiduals.push(err)
  }
  const base = observedResiduals.length > 4 ? observedResiduals : allResiduals
  const sigma = stdev(base) || mean(base.map(Math.abs)) || 1
  let mapeSum = 0
  let biasSum = 0
  let mapeN = 0
  for (const r of rows) {
    if (r.imputed || r.y == null || r.y <= 0) continue
    const err = r.y - dot(r.x, beta)
    mapeSum += Math.abs(err) / r.y
    biasSum += err
    mapeN++
  }

  const { startIdx } = design
  const predictions: ForecastPoint[] = opts.forecastDates.map((iso, k) => {
    const i = startIdx + (design.endIdx - design.startIdx) + k + 1
    const t = (i - startIdx) / 365
    const x: number[] = [1, t, t * t]
    const wd = weekday(iso)
    for (let d = 1; d < 7; d++) x.push(wd === d ? 1 : 0)
    if (cfg.seasonality) {
      for (const kk of [1, 2, 3]) {
        x.push(Math.sin((2 * Math.PI * kk * i) / 365), Math.cos((2 * Math.PI * kk * i) / 365))
      }
    }
    if (design.covariateNames.length) {
      for (const name of design.covariateNames) {
        if (name === '促销折扣') x.push(opts.forecastCovariates.promo)
        else if (name === '营销投放') x.push(opts.forecastCovariates.marketing)
        else x.push(opts.holidayMultiplier(iso))
      }
    }
    const yhat = Math.max(20, dot(x, beta))
    const h = k + 1
    // Long-run variance inflation: residuals are not white (AR-ish), so a plain
    // residual sd understates the forecast error. Cap the factor to stay honest.
    const rho = clamp(lag1Coefficient(observedResiduals), -0.2, 0.85)
    const lrv = Math.sqrt((1 + rho) / (1 - rho))
    const widen = Math.sqrt(1 + 1 / Math.max(8, rows.length)) * Math.sqrt(1 + h / 120) * clamp(Math.sqrt(lrv), 1, 1.35)
    const sigmaAdj = sigma * widen
    return {
      date: iso,
      yhat,
      lo80: yhat - 1.2816 * sigmaAdj,
      hi80: yhat + 1.2816 * sigmaAdj,
      lo95: yhat - 1.96 * sigmaAdj,
      hi95: yhat + 1.96 * sigmaAdj,
      width80: 2 * 1.2816 * sigmaAdj,
    }
  })

  // Residual diagnostics on observed rows only.
  const n = observedResiduals.length
  const r2 = (() => {
    const ys = rows.filter((r) => !r.imputed).map((r) => r.y as number)
    if (!ys.length) return 0
    const m = mean(ys)
    const ssTot = ys.reduce((a, v) => a + (v - m) ** 2, 0)
    const ssRes = observedResiduals.reduce((a, r) => a + r * r, 0)
    return ssTot ? 1 - ssRes / ssTot : 0
  })()
  const lag1 = (() => {
    if (observedResiduals.length < 3) return 0
    const a = observedResiduals.slice(1)
    const b = observedResiduals.slice(0, -1)
    const ma = mean(a)
    const mb = mean(b)
    let num = 0
    let da = 0
    let db = 0
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb)
      da += (a[i] - ma) ** 2
      db += (b[i] - mb) ** 2
    }
    return da && db ? num / Math.sqrt(da * db) : 0
  })()
  const durbinWatson = (() => {
    if (observedResiduals.length < 3) return 2
    let num = 0
    let den = 0
    for (let i = 0; i < observedResiduals.length; i++) {
      if (i > 0) num += (observedResiduals[i] - observedResiduals[i - 1]) ** 2
      den += observedResiduals[i] ** 2
    }
    return den ? num / den : 2
  })()

  // Coefficient importance, reported by feature block.
  const absSum = beta.slice(1).reduce((a, b) => a + Math.abs(b), 0) || 1
  const share = (from: number, to: number) =>
    beta.slice(from, to).reduce((a, b) => a + Math.abs(b), 0) / absSum
  const featureShare: Record<string, number> = {
    趋势: share(1, 3),
    星期: share(3, 9),
  }
  if (cfg.seasonality) featureShare['季节'] = share(9, 15)
  if (design.covariateNames.length) {
    const off = cfg.seasonality ? 15 : 9
    design.covariateNames.forEach((name, k) => {
      featureShare[name] = Math.abs(beta[off + k] ?? 0) / absSum
    })
  }

  const maxAbsZ = observedResiduals.length ? Math.max(...observedResiduals.map((r) => Math.abs(r / sigma))) : 0

  return {
    predictions,
    fitted,
    config: cfg,
    treatment,
    trainN: rows.length,
    effectiveN: rows.reduce((a, r) => a + r.weight, 0),
    blockedDays: design.blockedDays,
    imputedDays: design.imputedDays,
    beta,
    names: design.names,
    sigma,
    mapeInSample: mapeN ? mapeSum / mapeN : NaN,
    biasInSample: mapeN ? biasSum / mapeN : NaN,
    featureShare,
    imputations: design.imputations,
    droppedFeatures: design.droppedFeatures,
    diagnostics: { lag1, r2, maxAbsZ, durbinWatson },
    designHash: hashString(
      JSON.stringify([cfg, treatment, design.rows.map((r) => [r.date, r.y, r.weight]), design.blockedDays]),
    ),
    nObserved: n,
  } as ForecastResult & { nObserved: number }
}

/** Full (non-incremental) fit — used for strategy previews and backtests. */
export function fitModel(
  series: SkuSeries,
  cfg: ModelConfig,
  treatment: TreatmentPlan,
  forecastDates: string[],
  sku: SkuMeta,
  opts: DesignOptions = {},
): ForecastResult {
  const design = buildDesign(series, cfg, treatment, opts)
  const stats = accumulate(emptyStats(design.names.length), design.rows)
  const beta = solveStats(stats, cfg.lambda)
  const lastIdx = design.endIdx
  const marketingLast = (series.units[lastIdx]?.marketing ?? 3200) / 1000
  const forecastCovariates = {
    // no promotion is scheduled in the forecast horizon (promo is a 0/1 flag).
    promo: 0,
    marketing: marketingLast,
    holiday: 1,
  }
  return finalize(beta, design, cfg, treatment, {
    forecastDates,
    holidayMultiplier: (iso) => holidayValue(iso, sku),
    forecastCovariates,
  })
}

export function holidayValue(iso: string, sku: SkuMeta): number {
  const day = iso.slice(5)
  const p = sku.featureProfile.holiday
  if (day === '01-01') return 1 + 0.4 * p
  if (day === '07-04') return 1 + 0.3 * p
  if (day === '11-11') return 1 + 0.85 * p
  if (day === '12-25') return 1 + 0.25 * p
  if (day === '11-27') return 1 + 0.55 * p
  if (day === '12-02') return 1 + 0.2 * p
  return 1
}

/** Deterministic pseudo-random used for the promotion response simulation. */
export function skuJitter(sku: SkuMeta): number {
  return 0.9 + mulberry32(sku.code.length * 97 + 11)() * 0.2
}
