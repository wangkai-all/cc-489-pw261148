import { addDays, dayRange, diffDays, nthWeekdayOfMonth, weekday } from '../lib/date'
import { mulberry32, normal } from '../lib/rng'

export type Channel = 'DTC' | 'Marketplace'
export type Scope = 'all' | Channel
export type SkuId = 'SERUM' | 'CREAM' | 'TONER'
export type FeatureId = 'promo' | 'marketing' | 'holiday' | 'organic'

export interface SkuMeta {
  id: SkuId
  name: string
  code: string
  base: number
  growth: number
  featureProfile: Record<FeatureId, number>
  fourier: Record<number, { amp: number; phase: number }>
  noise: number
  promoWindow: [string, string]
  promoLift: number
  dtcShare: number
}

export const SKUS: SkuMeta[] = [
  {
    id: 'SERUM',
    name: '焕活精华液 30ml',
    code: 'SKU-SRM-30',
    base: 1180,
    growth: 0.00034,
    featureProfile: { promo: 1, marketing: 1, holiday: 0.55, organic: 1 },
    fourier: { 1: { amp: 0.055, phase: 0.3 }, 2: { amp: 0.028, phase: 1.7 }, 3: { amp: 0.014, phase: 2.4 } },
    noise: 0.036,
    promoWindow: ['2026-09-08', '2026-09-10'],
    promoLift: 1.62,
    dtcShare: 0.58,
  },
  {
    id: 'CREAM',
    name: '屏障修护面霜 50ml',
    code: 'SKU-CRM-50',
    base: 860,
    growth: 0.00055,
    featureProfile: { promo: 1, marketing: 0.95, holiday: 0.7, organic: 1 },
    fourier: { 1: { amp: 0.07, phase: 1.1 }, 2: { amp: 0.02, phase: 0.4 } },
    noise: 0.040,
    promoWindow: ['2026-10-26', '2026-10-29'],
    promoLift: 1.48,
    dtcShare: 0.52,
  },
  {
    id: 'TONER',
    name: '平衡爽肤水 200ml',
    code: 'SKU-TNR-200',
    base: 1520,
    growth: 0.00028,
    featureProfile: { promo: 0.9, marketing: 0.8, holiday: 0.45, organic: 1 },
    fourier: { 1: { amp: 0.04, phase: 2.1 }, 2: { amp: 0.032, phase: 1.0 }, 3: { amp: 0.01, phase: 0.2 }, 4: { amp: 0.014, phase: 2.8 } },
    noise: 0.032,
    promoWindow: ['2026-08-31', '2026-09-02'],
    promoLift: 1.72,
    dtcShare: 0.45,
  },
]

export const SKU_BY_ID = Object.fromEntries(SKUS.map((s) => [s.id, s])) as Record<SkuId, SkuMeta>

export const FEATURES: { id: FeatureId; name: string; short: string }[] = [
  { id: 'promo', name: '促销折扣', short: '促销' },
  { id: 'marketing', name: '营销投放', short: '投放' },
  { id: 'holiday', name: '节假日效应', short: '节日' },
  { id: 'organic', name: '自然流量', short: '自然' },
]

export const DATASET = {
  start: '2025-06-01',
  cutoff: '2026-11-15',
  horizon: '2026-12-13',
}

export const CHANNELS: { id: Scope; name: string }[] = [
  { id: 'all', name: '全渠道合计' },
  { id: 'DTC', name: '官网直营 DTC' },
  { id: 'Marketplace', name: '第三方平台' },
]

export type UnitRow = Record<FeatureId, number | null>

export interface SkuSeries {
  dates: string[]
  actual: (number | null)[]
  expected: number[]
  units: UnitRow[]
  truth: number[]
}

/** Data-acquisition events. `channel` scopes whether the event affects DTC, Marketplace or both. */
export interface GapEvent {
  id: string
  sku: SkuId
  channel: Scope
  kind: 'random' | 'consecutive' | 'systematic'
  start: string
  end: string
  feature?: FeatureId
  note: string
}

export const GAP_EVENTS: GapEvent[] = [
  { id: 'r1', sku: 'SERUM', channel: 'all', kind: 'random', start: '2026-08-30', end: '2026-08-30', note: '上游 ETL 任务超时，单日采集失败' },
  { id: 'r2', sku: 'TONER', channel: 'DTC', kind: 'random', start: '2026-09-13', end: '2026-09-13', note: '跨时区重复写入被去重规则丢弃' },
  { id: 'r3', sku: 'CREAM', channel: 'all', kind: 'random', start: '2026-09-23', end: '2026-09-23', note: '数据源限流，单日缺口' },
  { id: 'r4', sku: 'SERUM', channel: 'all', kind: 'random', start: '2026-10-18', end: '2026-10-18', note: '数据源限流，单日缺口' },
  { id: 'r5', sku: 'CREAM', channel: 'Marketplace', kind: 'random', start: '2026-11-08', end: '2026-11-08', note: '平台接口 502，重试队列未回补' },
  { id: 'r6', sku: 'TONER', channel: 'all', kind: 'random', start: '2026-07-22', end: '2026-07-22', note: '上游 ETL 任务超时，单日采集失败' },
  { id: 'r7', sku: 'TONER', channel: 'Marketplace', kind: 'random', start: '2026-04-17', end: '2026-04-17', note: '平台接口 502，重试队列未回补' },
  { id: 'r8', sku: 'SERUM', channel: 'Marketplace', kind: 'random', start: '2026-10-30', end: '2026-10-30', note: '平台对账单延迟，单日缺口' },
  { id: 'r9', sku: 'CREAM', channel: 'DTC', kind: 'random', start: '2026-06-27', end: '2026-06-27', note: '官网埋点改版，单日无上报' },

  { id: 'c1', sku: 'SERUM', channel: 'all', kind: 'consecutive', start: '2026-09-06', end: '2026-09-20', note: '数据仓库升级，连续 15 天阻断' },
  { id: 'c2', sku: 'CREAM', channel: 'Marketplace', kind: 'consecutive', start: '2026-10-12', end: '2026-10-17', note: '平台接口迁移，连续 6 天断流' },
  { id: 'c3', sku: 'TONER', channel: 'all', kind: 'consecutive', start: '2026-10-04', end: '2026-10-08', note: '仓储系统割接，连续 5 天断流' },
  { id: 'c4', sku: 'SERUM', channel: 'DTC', kind: 'consecutive', start: '2026-06-02', end: '2026-06-06', note: '官网埋点改版，连续 5 天无上报' },
  { id: 'c5', sku: 'CREAM', channel: 'DTC', kind: 'consecutive', start: '2026-06-18', end: '2026-06-22', note: '支付回调积压，连续 5 天订单未入库' },

  { id: 's1', sku: 'SERUM', channel: 'Marketplace', kind: 'systematic', start: '2025-09-01', end: '2026-11-15', feature: 'marketing', note: '平台不提供营销投放明细（接口契约限制）' },
  { id: 's2', sku: 'CREAM', channel: 'Marketplace', kind: 'systematic', start: '2025-09-01', end: '2026-11-15', feature: 'marketing', note: '平台不提供营销投放明细（接口契约限制）' },
  { id: 's3', sku: 'TONER', channel: 'Marketplace', kind: 'systematic', start: '2025-09-01', end: '2026-11-15', feature: 'marketing', note: '平台不提供营销投放明细（接口契约限制）' },
  { id: 's4', sku: 'TONER', channel: 'all', kind: 'systematic', start: '2026-03-25', end: '2026-05-20', feature: 'promo', note: '促销账单迁移期间折扣字段缺失，恢复后被错误填充为 1.0' },
  { id: 's5', sku: 'TONER', channel: 'Marketplace', kind: 'systematic', start: '2026-10-26', end: '2026-11-15', note: '平台结算接口下线且无替代源，需求量结构性不可观测' },
]

export interface OutlierEvent {
  sku: SkuId
  channel: Scope
  date: string
  observed: string
  expected: string
  reason: string
  action: 'excluded' | 'winsorized' | 'flagged'
  /** Which column is corrupted. */
  field: FeatureId | 'demand'
  kind: 'spike' | 'dip' | 'duplicate'
}

export const OUTLIER_EVENTS: OutlierEvent[] = [
  { sku: 'SERUM', channel: 'DTC', date: '2026-07-14', observed: '2,316 件', expected: '约 1,190 件', reason: '重复上传导致双倍计量', action: 'excluded', field: 'demand', kind: 'duplicate' },
  { sku: 'SERUM', channel: 'DTC', date: '2026-07-15', observed: '2,201 件', expected: '约 1,155 件', reason: '同一批次覆盖写入未去重', action: 'excluded', field: 'demand', kind: 'spike' },
  { sku: 'CREAM', channel: 'Marketplace', date: '2026-05-03', observed: '9 件', expected: '约 780 件', reason: '单位换算错误（盒 → 件）', action: 'winsorized', field: 'demand', kind: 'dip' },
  { sku: 'CREAM', channel: 'DTC', date: '2026-02-18', observed: '41,500 元', expected: '约 3,600 元', reason: '营销账单重复计费', action: 'winsorized', field: 'marketing', kind: 'spike' },
  { sku: 'SERUM', channel: 'all', date: '2026-04-09', observed: '2', expected: '0 或 1', reason: '促销标记取值越界', action: 'flagged', field: 'promo', kind: 'spike' },
]

function holidayMultiplier(iso: string, profile: number): number {
  const day = iso.slice(5)
  const year = Number(iso.slice(0, 4))
  if (day === '01-01') return 1 + 0.4 * profile
  if (day === '07-04') return 1 + 0.3 * profile
  if (day === '11-11') return 1 + 0.85 * profile
  if (day === '12-25') return 1 + 0.25 * profile
  if (day === nthWeekdayOfMonth(year, 11, 4, 5).slice(5)) return 1 + 0.55 * profile
  if (day === nthWeekdayOfMonth(year, 5, 1, 1).slice(5)) return 1 + 0.25 * profile
  return 1
}

const WEEKDAY_FACTOR = [0.84, 0.98, 1.02, 1.03, 1.06, 1.12, 0.95]

const LEVEL_SHIFTS: Record<SkuId, { date: string; factor: number }[]> = {
  SERUM: [{ date: '2026-03-15', factor: 1.15 }],
  CREAM: [{ date: '2026-06-01', factor: 1.14 }],
  TONER: [{ date: '2026-10-09', factor: 0.86 }],
}

interface BaseSku {
  dates: string[]
  truth: number[]
  units: UnitRow[]
}

function buildBase(): Record<SkuId, BaseSku> {
  const rand = mulberry32(26_1109)
  const dates = dayRange(DATASET.start, DATASET.horizon)
  const out = {} as Record<SkuId, BaseSku>

  for (const sku of SKUS) {
    const truth: number[] = []
    const units: UnitRow[] = []
    const [promoStart, promoEnd] = sku.promoWindow
    let ar = 0
    let marketingDrift = 0

    dates.forEach((iso, i) => {
      const t = i / dates.length
      const wd = WEEKDAY_FACTOR[weekday(iso)]
      // Smooth compounding growth only: extra non-annual wobble would masquerade
      // as level shifts and make the breakpoint drill meaningless.
      const trend = 0.95 + 0.05 * Math.exp(sku.growth * i)
      let seasonal = 1
      for (const [k, { amp, phase }] of Object.entries(sku.fourier)) {
        seasonal *= 1 + amp * Math.sin((2 * Math.PI * Number(k) * i) / 365 + phase)
      }
      const holiday = holidayMultiplier(iso, sku.featureProfile.holiday)
      const inPromo = iso >= promoStart && iso <= promoEnd
      const promo = inPromo ? sku.promoLift : 1
      const pre = iso === addDays(promoStart, -1) ? 1.12 : 1
      const post = iso === addDays(promoEnd, 1) || iso === addDays(promoEnd, 2) ? 0.87 : 1

      marketingDrift += 0.0025
      const marketing = Math.round(
        (3200 + 380 * Math.sin(i / 41) + 180 * Math.sin(i / 13 + 1.2) + marketingDrift * 140) * (0.9 + 0.2 * rand()),
      )
      const organic = Math.round(sku.base * trend * seasonal * wd * (1 + 0.012 * Math.sin(i / 9)))
      ar = 0.34 * ar + normal(rand) * sku.noise
      const noise = 1 + ar
      const value = Math.max(
        60,
        Math.round(sku.base * trend * seasonal * wd * holiday * promo * pre * post * 1.00003 * (marketing - 3200) * noise * (iso >= '2026-08-01' ? 1.035 : 1)),
      )
      // correct marketing contribution (avoid double counting): 0.00005 per yuan above baseline
      // Deliberate structural level shifts (category listing, lost distributor).
      // These are real breakpoints that must be validated, not smoothed away.
      const shift = LEVEL_SHIFTS[sku.id]
      let regimeBreak = 1
      for (const e of shift) if (iso >= e.date) regimeBreak *= e.factor
      const corrected = Math.max(
        60,
        Math.round(
          sku.base * trend * seasonal * wd * holiday * promo * pre * post * (1 + 0.00005 * (marketing - 3200) * sku.featureProfile.marketing) * noise * (iso >= '2026-08-01' ? 1.035 : 1) * regimeBreak,
        ),
      )
      void value
      // promo is stored as a 0/1 flag; the lift lives in the demand generator only.
      truth.push(corrected)
      units.push({ promo: inPromo ? 1 : 0, marketing, holiday, organic })
    })
    out[sku.id] = { dates, truth, units }
  }
  return out
}

const BASE = buildBase()

function shareFor(sku: SkuMeta, i: number): number {
  return sku.dtcShare + 0.035 * Math.sin(i / 47 + 1.1)
}

export interface ChannelView {
  series: Record<SkuId, SkuSeries>
}

/**
 * Materialise one analysis scope. Gaps, outliers and structural feature absence are
 * applied here so the console can switch scope without rebuilding the world.
 */
export function buildScope(scope: Scope): ChannelView {
  const series = {} as Record<SkuId, SkuSeries>
  const rand = mulberry32(9017)

  for (const sku of SKUS) {
    const base = BASE[sku.id]
    const dates = base.dates.slice()
    const expected = base.truth.map((v, i) => Math.round(v * (scope === 'all' ? 1 : scope === 'DTC' ? shareFor(sku, i) : 1 - shareFor(sku, i))))
    const actual: (number | null)[] = expected.slice()
    const units: UnitRow[] = base.units.map((u) => ({ ...u }))

    // Marketing detail is only supplied by the DTC stack.
    // Only the Marketplace stack lacks marketing detail; the aggregate inherits the DTC spend.
    if (scope === 'Marketplace') for (const u of units) u.marketing = null

    // Structural absence (feature columns).
    for (const ev of GAP_EVENTS) {
      if (ev.sku !== sku.id || ev.kind !== 'systematic' || !ev.feature) continue
      if (ev.channel !== 'all' && ev.channel !== scope) continue
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] < ev.start || dates[i] > ev.end) continue
        units[i][ev.feature] = null
      }
    }

    // Demand gaps.
    for (const ev of GAP_EVENTS) {
      if (ev.sku !== sku.id || ev.kind === 'systematic') continue
      if (ev.channel !== 'all' && ev.channel !== scope) continue
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] < ev.start || dates[i] > ev.end) continue
        actual[i] = null
      }
    }

    // Corrupted telemetry — injected after gaps so gaps still win.
    for (const ev of OUTLIER_EVENTS) {
      if (ev.sku !== sku.id || ev.field !== 'demand') continue
      if (ev.channel !== 'all' && ev.channel !== scope) continue
      const i = dates.indexOf(ev.date)
      if (i < 0 || actual[i] == null) continue
      if (ev.kind === 'duplicate' || ev.kind === 'spike') actual[i] = Math.round(actual[i]! * 1.9)
      else actual[i] = Math.round(actual[i]! * 0.011)
    }

    // Feature outliers (unit-level) applied to the shared feature columns.
    for (const ev of OUTLIER_EVENTS) {
      if (ev.sku !== sku.id || ev.field === 'demand') continue
      if (ev.channel !== 'all' && ev.channel !== scope) continue
      const i = dates.indexOf(ev.date)
      if (i < 0) continue
      const v = units[i][ev.field]
      if (v == null) continue
      if (ev.field === 'marketing') units[i].marketing = Math.round(v * 11.5)
      else units[i].promo = 2
    }

    series[sku.id] = { dates, actual, expected, units, truth: expected.slice() }
  }
  void rand
  return { series }
}

export function featureCoverage(series: SkuSeries, startIdx: number) {
  return FEATURES.map((f) => {
    let missing = 0
    let first: string | null = null
    let last: string | null = null
    for (let i = startIdx; i < series.dates.length; i++) {
      if (series.units[i][f.id] == null) {
        missing++
        if (!first) first = series.dates[i]
        last = series.dates[i]
      }
    }
    return { ...f, missing, total: series.dates.length - startIdx, first, last }
  })
}

export { addDays, diffDays }
