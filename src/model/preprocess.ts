/**
 * Data-quality stage: causal (trailing-only) detection of corrupted demand and
 * covariate values. Runs before diagnostics/fitting so one bad row cannot
 * redefine a whole model.
 */
import { MAD_SCALE, median } from './robust'
import type { FeatureId, SkuSeries, UnitRow } from '../data/dataset'

export type CleanMode = 'off' | 'winsorize' | 'exclude'

export interface QualityFlag {
  date: string
  field: FeatureId | 'demand'
  observed: number
  expected: number
  /** Robust z score of the deviation. */
  z: number
  kind: 'spike' | 'dip' | 'duplicate' | 'invalid-code'
  action: 'excluded' | 'winsorized' | 'flagged' | 'imputed'
}

export interface CleaningOptions {
  demand: CleanMode
  features: 'off' | 'fix' | 'flag'
}

/** Reviewer overrides: a flag the analyst rejected is never applied. */
export type FlagDecision = Record<string, 'apply' | 'keep'>

export interface CleaningResult {
  series: SkuSeries
  flags: QualityFlag[]
}

const WINDOW = 28

/** Causal local level: median of the previous WINDOW observed days + same-weekday correction. */
function trailingLevel(values: (number | null)[], weekdays: number[], i: number): number {
  const peers: number[] = []
  const sameWeekday: number[] = []
  for (let j = Math.max(0, i - WINDOW); j < i; j++) {
    const v = values[j]
    if (v == null) continue
    peers.push(v)
    if (weekdays[j] === weekdays[i]) sameWeekday.push(v)
  }
  const base = peers.length ? median(peers) : NaN
  if (!sameWeekday.length) return base
  const wd = median(sameWeekday)
  return Number.isFinite(base) && Number.isFinite(wd) ? (base * 0.55 + wd * 0.45) : base
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

export function cleanSeries(series: SkuSeries, opts: CleaningOptions, decisions: FlagDecision = {}): CleaningResult {
  const decided = (date: string, field: string) => decisions[`${date}:${field}`] === 'keep'
  const demand: (number | null)[] = series.actual.slice()
  const units: UnitRow[] = series.units.map((u) => ({ ...u }))
  const flags: QualityFlag[] = []
  const weekdays = series.dates.map(weekdayOf)
  // Local levels are causal, so each one is a pure function of days before it.
  // Cache them; when a row is nulled, only later levels can change.
  const levelCache = new Map<number, number>()
  const levelOf = (j: number) => {
    let v = levelCache.get(j)
    if (v === undefined) {
      v = trailingLevel(demand, weekdays, j)
      levelCache.set(j, v)
    }
    return v
  }
  const invalidateAfter = (i: number) => {
    for (const k of levelCache.keys()) if (k > i) levelCache.delete(k)
  }

  if (opts.demand !== 'off') {
    for (let i = 16; i < demand.length; i++) {
      const y = demand[i]
      if (y == null) continue
      const level = levelOf(i)
      if (!Number.isFinite(level) || level <= 0) continue
      // robust scale from the last 3 weeks of residuals against the trailing level
      const resid: number[] = []
      for (let j = Math.max(1, i - 21); j < i; j++) {
        const v = demand[j]
        if (v == null) continue
        const lv = levelOf(j)
        if (Number.isFinite(lv)) resid.push(v - lv)
      }
      const scale = median(resid.map((r) => Math.abs(r))) * MAD_SCALE || Math.max(8, level * 0.08)
      const z = (y - level) / scale
      const ratio = y / level
      const dup = i > 0 && demand[i - 1] != null && y === demand[i - 1] && z > 4
      if (Math.abs(z) > 6 && (ratio > 1.7 || ratio < 0.5 || dup)) {
        const action = opts.demand === 'exclude' ? 'excluded' : 'winsorized'
        flags.push({
          date: series.dates[i],
          field: 'demand',
          observed: y,
          expected: level,
          z,
          kind: dup ? 'duplicate' : z > 0 ? 'spike' : 'dip',
          action,
        })
        if (!decided(series.dates[i], 'demand')) {
          if (opts.demand === 'exclude') demand[i] = null
          else demand[i] = Math.round(Math.min(level * 1.7, Math.max(level * 0.6, y)))
          invalidateAfter(i)
        }
      }
    }
  }

  if (opts.features !== 'off') {
    // Marketing spend: a single duplicate billing row is orders of magnitude off.
    const spends = units.map((u) => u.marketing).filter((v): v is number => v != null)
    if (spends.length > 10) {
      const med = median(spends)
      for (let i = 0; i < units.length; i++) {
        const v = units[i].marketing
        if (v == null) continue
        if (v > med * 6) {
          flags.push({
            date: series.dates[i],
            field: 'marketing',
            observed: v,
            expected: med,
            z: (v - med) / (median(spends.map((x) => Math.abs(x - med))) * MAD_SCALE || 1),
            kind: 'spike',
            action: opts.features === 'fix' ? 'winsorized' : 'flagged',
          })
          if (opts.features === 'fix' && !decided(series.dates[i], 'marketing')) units[i].marketing = Math.round(med)
        }
      }
    }
    // Promo flag is binary; anything else is an invalid code.
    for (let i = 0; i < units.length; i++) {
      const p = units[i].promo
      if (p == null) continue
      if (p !== 0 && p !== 1) {
        flags.push({
          date: series.dates[i],
          field: 'promo',
          observed: p,
          expected: 1,
          z: NaN,
          kind: 'invalid-code',
          action: opts.features === 'fix' ? 'imputed' : 'flagged',
        })
        if (opts.features === 'fix' && !decided(series.dates[i], 'promo')) units[i].promo = null
      }
    }
  }

  return {
    series: { ...series, actual: demand, units },
    flags,
  }
}

/** Exposed for the data-quality table: first and last flagged dates per field. */
export function summarizeFlags(flags: QualityFlag[]) {
  const byField = new Map<string, QualityFlag[]>()
  for (const f of flags) {
    const arr = byField.get(f.field) ?? []
    arr.push(f)
    byField.set(f.field, arr)
  }
  return [...byField.entries()].map(([field, list]) => ({
    field,
    count: list.length,
    dates: list.map((f) => f.date),
    action: list[0].action,
  }))
}
