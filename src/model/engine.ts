/**
 * Incremental recompute engine.
 *
 * The training window is cut into fixed 28-day segments. Each segment keeps its
 * hash and sufficient statistics (XᵀX, Xᵀy, yᵀy). A revision only re-accumulates
 * segments whose rows changed — a backfill touches the segment containing the gap
 * plus one neighbour on each side (imputation reach) — then the ridge solve and
 * the forecast horizon are refreshed. Everything else is reused verbatim.
 */
import { dayRange } from '../lib/date'
import type { SkuMeta, SkuSeries } from '../data/dataset'
import {
  accumulate,
  buildDesign,
  emptyStats,
  finalize,
  solveStats,
  type Design,
  type DesignOptions,
  type ForecastResult,
  type ModelConfig,
  type SufficientStats,
  type TreatmentPlan,
} from './forecast'
import { cleanSeries, type CleaningOptions, type FlagDecision } from './preprocess'

const SEGMENT_DAYS = 28

export interface SegmentInfo {
  index: number
  start: string
  end: string
  days: number
  hash: string
  status: 'recomputed' | 'reused'
  changedDates: string[]
}

export interface RecomputeAudit {
  mode: 'full' | 'incremental'
  segments: SegmentInfo[]
  recomputedSegments: number
  reusedSegments: number
  recomputedDays: number
  reusedDays: number
  affectedStart: string
  affectedEnd: string
  patchDates: string[]
  /** Solve path only: segment hash, accumulate, ridge solve, finalize. */
  elapsedMs: number
  /** Same scope as elapsedMs, recomputing every segment from scratch. */
  fullElapsedMs: number
  /** Design-matrix construction, shared by both paths. */
  designMs: number
  betaDelta: number
  forecastShift: number
}

export interface EngineRun {
  forecast: ForecastResult
  audit: RecomputeAudit
  design: Design
  cleaned: SkuSeries
  quality: ReturnType<typeof cleanSeries>['flags']
}

interface CacheEntry {
  hash: string
  stats: SufficientStats
  start: string
  end: string
  days: number
}

type SegmentCache = Map<number, CacheEntry>

const caches = new Map<string, SegmentCache>()
const lastRun = new Map<string, { beta: number[]; yhat: number[] }>()
/** Measured once per cache key, so the reference full rebuild is not run twice. */
const fullTimings = new Map<string, number>()

function fnv(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

const ROW_MIX = 0x9e3779b1

/**
 * Numeric rolling hash over a segment's rows. Hashing the design row directly
 * instead of its JSON serialisation is what keeps the reuse check cheaper than
 * re-accumulating the segment it guards.
 */
function hashSegment(rows: Design['rows'], names: number): string {
  let h = 2166136261 ^ names
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    // date is djb2 over the 10 chars — cheap and order-sensitive
    let dh = 5381
    const d = row.date
    for (let i = 0; i < d.length; i++) dh = ((dh << 5) + dh + d.charCodeAt(i)) | 0
    h = Math.imul(h ^ dh, ROW_MIX)
    h = Math.imul(h ^ Math.round((row.y ?? -1) * 1e4), ROW_MIX)
    h = Math.imul(h ^ Math.round(row.weight * 1e4), ROW_MIX)
    h = Math.imul(h ^ (row.blocked ? 1 : 0), ROW_MIX)
    const x = row.x
    for (let j = 0; j < x.length; j++) h = Math.imul(h ^ Math.round(x[j] * 1e6), ROW_MIX)
    h ^= h >>> 15
  }
  return (h >>> 0).toString(16)
}

export function forecastDatesFor(cfg: ModelConfig, datasetEnd: string): string[] {
  return dayRange(cfg.end, datasetEnd).slice(1)
}

export interface RunInput {
  sku: SkuMeta
  series: SkuSeries
  datasetEnd: string
  cfg: ModelConfig
  treatment: TreatmentPlan
  cleaning: CleaningOptions
  /** Dates whose observations were backfilled in this revision. */
  patchDates: string[]
  patchValues?: Record<string, number>
  /** Force a cold cache (used by the backtest / comparison panel). */
  cold?: boolean
  flagDecisions?: FlagDecision
}

export function runForecast(input: RunInput): EngineRun {
  const { sku, series, cfg, treatment, cleaning, patchDates } = input
  const cleaned = cleanSeries(series, cleaning, input.flagDecisions)
  const patched: SkuSeries = { ...cleaned.series }
  if (input.patchValues && Object.keys(input.patchValues).length) {
    patched.actual = cleaned.series.actual.slice()
    for (const [date, value] of Object.entries(input.patchValues)) {
      const i = patched.dates.indexOf(date)
      if (i >= 0) patched.actual[i] = value
    }
  }

  const tDesign = performance.now()
  const design = buildDesign(patched, cfg, treatment)
  const designMs = performance.now() - tDesign
  const names = design.names
  const cacheKey = `${sku.id}:${cfg.kind}:${cfg.start}:${cfg.end}:${cfg.seasonality}:${cfg.promotion}:${JSON.stringify(treatment)}:${JSON.stringify(cleaning)}:${names.length}`
  if (input.cold) {
    caches.delete(cacheKey)
    fullTimings.delete(cacheKey)
  }
  const cache = caches.get(cacheKey) ?? new Map<number, CacheEntry>()
  caches.set(cacheKey, cache)

  const useCov = cfg.promotion && cfg.kind !== 'nocov'
  const forecastDates = forecastDatesFor(cfg, input.datasetEnd)
  const t0 = performance.now()

  // group rows into fixed segments
  const segRows = new Map<number, typeof design.rows>()
  for (const row of design.rows) {
    const seg = Math.floor((row.index - design.startIdx) / SEGMENT_DAYS)
    const list = segRows.get(seg) ?? []
    list.push(row)
    segRows.set(seg, list)
  }

  const segments: SegmentInfo[] = []
  let stats = emptyStats(names.length)
  let recomputed = 0
  let reused = 0
  let recomputedDays = 0
  let reusedDays = 0
  let affectedStart = patchDates[0] ?? ''
  let affectedEnd = patchDates[patchDates.length - 1] ?? ''

  for (const seg of [...segRows.keys()].sort((a, b) => a - b)) {
    const rows = segRows.get(seg)!
    const hash = hashSegment(rows, names.length)
    const entry = cache.get(seg)
    const first = rows[0].date
    const last = rows[rows.length - 1].date
    let status: 'recomputed' | 'reused' = 'reused'
    if (!entry || entry.hash !== hash) {
      const segStats = accumulate(emptyStats(names.length), rows)
      cache.set(seg, { hash, stats: segStats, start: first, end: last, days: rows.length })
      status = 'recomputed'
      recomputed++
      recomputedDays += rows.length
      if (!affectedStart || first < affectedStart) affectedStart = first
      if (!affectedEnd || last > affectedEnd) affectedEnd = last
    } else {
      reused++
      reusedDays += rows.length
    }
    const cur = cache.get(seg)!
    stats = addStats(stats, cur.stats)
    segments.push({ index: seg, start: first, end: last, days: rows.length, hash, status, changedDates: status === 'recomputed' ? rows.filter((r) => r.imputed).map((r) => r.date).slice(0, 8) : [] })
  }

  const beta = solveStats(stats, cfg.lambda)
  const previous = lastRun.get(cacheKey)
  const forecastCovariates = {
    promo: 0,
    marketing: (patched.units[design.endIdx]?.marketing ?? 3200) / 1000,
    holiday: 1,
  }
  const forecast = finalize(beta, design, cfg, treatment, {
    forecastDates,
    holidayMultiplier: () => 1,
    forecastCovariates,
  })
  const elapsedMs = performance.now() - t0

  // Reference full rebuild, measured once per cache key. Both paths share the
  // design matrix, so the comparison isolates accumulation + solve + finalize —
  // exactly the work the segment cache avoids.
  let fullElapsedMs = fullTimings.get(cacheKey) ?? 0
  if (input.cold || !fullElapsedMs) {
    const t1 = performance.now()
    const fullStats = accumulate(emptyStats(names.length), design.rows)
    const fullBeta = solveStats(fullStats, cfg.lambda)
    finalize(fullBeta, design, cfg, treatment, { forecastDates, holidayMultiplier: () => 1, forecastCovariates })
    fullElapsedMs = performance.now() - t1
    fullTimings.set(cacheKey, fullElapsedMs)
  }

  const betaDelta = previous
    ? beta.reduce((a, b, i) => a + Math.abs(b - (previous.beta[i] ?? 0)), 0) /
      Math.max(1e-6, previous.beta.reduce((a, b) => a + Math.abs(b), 0))
    : 0
  const forecastShift = previous
    ? forecast.predictions.reduce((a, p, i) => a + Math.abs(p.yhat - (previous.yhat[i] ?? p.yhat)), 0) /
      Math.max(1e-6, previous.yhat.reduce((a, b) => a + Math.abs(b), 0))
    : 0
  lastRun.set(cacheKey, { beta, yhat: forecast.predictions.map((p) => p.yhat) })

  const mode: RecomputeAudit['mode'] =
    patchDates.length > 0 || reused > 0 ? 'incremental' : 'full'

  return {
    forecast,
    audit: {
      mode,
      segments,
      recomputedSegments: recomputed,
      reusedSegments: reused,
      recomputedDays,
      reusedDays,
      affectedStart: affectedStart || cfg.start,
      affectedEnd: affectedEnd || cfg.end,
      patchDates,
      elapsedMs,
      fullElapsedMs,
      designMs,
      betaDelta: betaDelta / Math.max(1, beta.length),
      forecastShift,
    },
    design,
    cleaned: patched,
    quality: cleaned.flags,
  }
}

function addStats(a: SufficientStats, b: SufficientStats): SufficientStats {
  const dim = a.dim
  const XtX = a.XtX.map((row, i) => row.map((v, j) => v + b.XtX[i][j]))
  return {
    n: a.n + b.n,
    dim,
    XtX,
    Xty: a.Xty.map((v, i) => v + b.Xty[i]),
    yty: a.yty + b.yty,
    ySum: a.ySum + b.ySum,
    days: a.days + b.days,
  }
}

/** Drop every cache entry for a SKU (used when patching rewrites history). */
export function invalidateCache(skuId: string) {
  for (const key of [...caches.keys()]) if (key.startsWith(`${skuId}:`)) caches.delete(key)
}

export type { ModelConfig, TreatmentPlan, ForecastResult, DesignOptions }
