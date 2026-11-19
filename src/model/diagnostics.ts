import { diffDays, weekday } from '../lib/date'
import { normalCdf, twoSidedP } from '../lib/inference'
import { clamp } from '../lib/stats'
import { FEATURES, type FeatureId, type SkuSeries } from '../data/dataset'

export type MissingKind = 'random' | 'consecutive' | 'systematic'

export interface MissingRun {
  kind: MissingKind
  feature: FeatureId | 'demand'
  label: string
  start: string
  end: string
  indices: number[]
  length: number
  /** Run is still open at the data cut-off. */
  openEnded: boolean
}

export interface Evidence {
  label: string
  value: string
  verdict: 'supports' | 'against' | 'neutral'
}

export interface ColumnDiagnosis {
  feature: FeatureId | 'demand'
  label: string
  subtitle: string
  missing: number
  total: number
  rate: number
  runs: MissingRun[]
  longest: MissingRun | null
  kind: MissingKind | 'none'
  confidence: number
  evidence: Evidence[]
  recommended: 'impute' | 'downweight' | 'block'
  rationale: string
}

export interface DiagnosticsResult {
  columns: ColumnDiagnosis[]
  demand: ColumnDiagnosis
  runs: MissingRun[]
  missingCells: number
  totalCells: number
  overallRate: number
  kindCounts: Record<MissingKind, number>
  runBins: { label: string; random: number; consecutive: number; systematic: number }[]
  weekday: { label: string; rate: number; count: number }[]
  heat: { weekStart: string; rate: number; count: number; total: number }[]
  primaryRun: MissingRun | null
  systematicColumns: number
  consecutiveRuns: number
  randomRuns: number
  recommendation: { demand: 'impute' | 'downweight' | 'block'; covariates: Record<FeatureId, 'impute' | 'downweight' | 'block'> }
}

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const OPEN_ENDED_DAYS = 5

function collectRuns(series: SkuSeries, feature: FeatureId | 'demand', fromIdx: number, toIdx: number, label: string): MissingRun[] {
  const runs: MissingRun[] = []
  let cur: MissingRun | null = null
  for (let i = fromIdx; i <= toIdx; i++) {
    const missing = feature === 'demand' ? series.actual[i] == null : series.units[i][feature] == null
    if (!missing) {
      cur = null
      continue
    }
    if (cur && diffDays(cur.end, series.dates[i]) === 1) {
      cur.end = series.dates[i]
      cur.indices.push(i)
      cur.length = cur.indices.length
    } else {
      cur = {
        kind: 'random',
        feature,
        label,
        start: series.dates[i],
        end: series.dates[i],
        indices: [i],
        length: 1,
        openEnded: false,
      }
      runs.push(cur)
    }
  }
  for (const r of runs) {
    r.openEnded = r.end >= series.dates[toIdx] && r.length >= OPEN_ENDED_DAYS
  }
  return runs
}

/**
 * Per-run classification:
 *  - systematic: the column is unavailable by design — it covers essentially the
 *    whole window, or the run is still open at the cut-off (no recovery path), or
 *    a covariate gap has lasted more than a month (fixed, contract-level boundary).
 *  - consecutive: a contiguous block that was later recovered.
 *  - random: isolated days.
 */
function classifyRunKind(feature: FeatureId | 'demand', run: MissingRun, total: number, coversWindow: boolean): MissingKind {
  if (coversWindow || run.openEnded) return 'systematic'
  if (feature !== 'demand' && run.length >= 45) return 'systematic'
  if (run.length > 1) return 'consecutive'
  return 'random'
}

function classifyColumn(runs: MissingRun[], total: number, missing: number): MissingKind | 'none' {
  if (!runs.length) return 'none'
  if (missing / Math.max(1, total) >= 0.995) return 'systematic'
  if (runs.some((r) => r.kind === 'systematic')) return 'systematic'
  if (runs.some((r) => r.kind === 'consecutive')) return 'consecutive'
  return 'random'
}

export function diagnose(series: SkuSeries, fromDate: string, toDate: string): DiagnosticsResult {
  const fromIdx = Math.max(0, series.dates.indexOf(fromDate))
  const toIdx = series.dates.indexOf(toDate) < 0 ? series.dates.length - 1 : series.dates.indexOf(toDate)
  const total = toIdx - fromIdx + 1

  const demandRuns = collectRuns(series, 'demand', fromIdx, toIdx, '需求量')
  const allRuns: MissingRun[] = [...demandRuns]

  // ---- demand-level MCAR evidence -------------------------------------------
  const weekdayTotal = new Array(7).fill(0)
  const weekdayMissing = new Array(7).fill(0)
  const flags: number[] = []
  for (let i = fromIdx; i <= toIdx; i++) {
    const miss = series.actual[i] == null
    flags.push(miss ? 1 : 0)
    const wd = weekday(series.dates[i])
    weekdayTotal[wd]++
    if (miss) weekdayMissing[wd]++
  }
  const expected = weekdayTotal.map((t) => (t / total) * flags.reduce((a, b) => a + b, 0))
  let chi = 0
  for (let i = 0; i < 7; i++) if (expected[i] > 0) chi += (weekdayMissing[i] - expected[i]) ** 2 / expected[i]
  const weekdayP = chiSquareP(chi, 6)
  const chainZ = runsTestZ(flags)
  const chainP = Number.isFinite(chainZ) ? twoSidedP(chainZ) : 1

  const demandMissing = demandRuns.reduce((a, r) => a + r.length, 0)
  const demandLongest = demandRuns.reduce<MissingRun | null>((a, r) => (!a || r.length > a.length ? r : a), null)
  const demandCovers = demandMissing / Math.max(1, total) >= 0.995
  for (const r of demandRuns) r.kind = classifyRunKind('demand', r, total, demandCovers)
  const demandKind = classifyColumn(demandRuns, total, demandMissing)
  const demand: ColumnDiagnosis = {
    feature: 'demand',
    label: '需求量',
    subtitle: '件 / 天 · 预测目标',
    missing: demandMissing,
    total,
    rate: demandMissing / total,
    runs: demandRuns,
    longest: demandLongest,
    kind: demandKind,
    confidence: demandKind === 'none' ? 1 : demandKind === 'random' ? 0.86 : demandKind === 'consecutive' ? 0.94 : 0.98,
    evidence: [
      {
        label: '游程检验（chain test）',
        value: `${chainZ.toFixed(2)} · p=${Number.isFinite(chainP) ? chainP.toFixed(3) : '—'}`,
        verdict: chainP < 0.05 ? 'against' : 'supports',
      },
      {
        label: '星期独立性 χ²(6)',
        value: `${chi.toFixed(1)} · p=${weekdayP.toFixed(3)}`,
        verdict: weekdayP < 0.05 ? 'against' : 'supports',
      },
      {
        label: '最长连续缺失',
        value: demandLongest ? `${demandLongest.length} 天` : '0 天',
        verdict: demandLongest && demandLongest.length > 1 ? 'against' : 'neutral',
      },
      {
        label: '断点后是否持续',
        value: demandRuns.some((r) => r.openEnded) ? '是' : '否',
        verdict: 'neutral',
      },
    ],
    recommended: demandKind === 'systematic' ? 'block' : demandKind === 'consecutive' ? 'downweight' : 'impute',
    rationale:
      demandKind === 'systematic'
        ? '需求缺口延续至数据截止日，结构性不可观测，建议阻断该时段并从断点后重训。'
        : demandKind === 'consecutive'
          ? '存在连续采集中断，缺口内部无法用当日协变量解释，建议插补后降权。'
          : '缺失为零散单日，与星期和业务量无关，可按局部结构插补。',
  }

  // ---- per-covariate diagnosis ----------------------------------------------
  const columns: ColumnDiagnosis[] = []
  for (const f of FEATURES) {
    const runs = collectRuns(series, f.id, fromIdx, toIdx, f.name)
    const missing = runs.reduce((a, r) => a + r.length, 0)
    const covers = missing / Math.max(1, total) >= 0.995
    for (const r of runs) r.kind = classifyRunKind(f.id, r, total, covers)
    const kind = classifyColumn(runs, total, missing)
    const longest = runs.reduce<MissingRun | null>((a, r) => (!a || r.length > a.length ? r : a), null)

    // point-biserial: is covariate missingness associated with demand level?
    const flagVals: number[] = []
    const levelVals: number[] = []
    for (let i = fromIdx; i <= toIdx; i++) {
      const y = series.actual[i]
      if (y == null) continue
      flagVals.push(series.units[i][f.id] == null ? 1 : 0)
      levelVals.push(y)
    }
    const corr = Math.abs(pearson(flagVals, levelVals))
    const structural = kind === 'systematic'
    const evidence: Evidence[] = [
      {
        label: '覆盖区间',
        value: missing === 0 ? '完整覆盖' : `${runs[0].start} → ${runs[runs.length - 1].end}`,
        verdict: structural ? 'against' : 'neutral',
      },
      {
        label: '缺失占比',
        value: `${(100 * (missing / Math.max(1, total))).toFixed(1)}%`,
        verdict: missing > 0 ? 'against' : 'supports',
      },
      {
        label: '缺失标志 × 需求量 |r|',
        value: corr.toFixed(3),
        verdict: corr > 0.2 ? 'against' : 'neutral',
      },
      {
        label: '机制判断',
        value: structural ? '边界固定 · 结构性' : kind === 'consecutive' ? '成片中断 · 连续' : kind === 'none' ? '无缺失' : '零散 · 随机',
        verdict: structural ? 'against' : 'neutral',
      },
    ]
    columns.push({
      feature: f.id,
      label: f.name,
      subtitle: '协变量',
      missing,
      total,
      rate: missing / Math.max(1, total),
      runs,
      longest,
      kind,
      confidence: kind === 'none' ? 1 : structural ? 0.97 : kind === 'consecutive' ? 0.9 : 0.8,
      evidence,
      recommended: structural ? 'block' : kind === 'consecutive' ? 'downweight' : 'impute',
      rationale:
        kind === 'none'
          ? '窗口内完整覆盖，可直接作为模型输入。'
          : structural
            ? '缺失覆盖整个窗口且边界固定，来源为接口契约，任何插补都会制造伪信号 → 整列阻断。'
            : kind === 'consecutive'
              ? '缺失集中在固定区间，与需求水平弱相关，建议插补并对该时段降权。'
              : '零散缺失，建议直接插补。',
    })
    allRuns.push(...runs)
  }

  // ---- run-kind bins --------------------------------------------------------
  const binDefs = [
    { label: '1 天', lo: 1, hi: 1 },
    { label: '2–3 天', lo: 2, hi: 3 },
    { label: '4–6 天', lo: 4, hi: 6 },
    { label: '7–13 天', lo: 7, hi: 13 },
    { label: '≥14 天', lo: 14, hi: Infinity },
  ]
  const runBins = binDefs.map((b) => {
    const inBin = allRuns.filter((r) => r.length >= b.lo && r.length <= b.hi)
    return {
      label: b.label,
      random: inBin.filter((r) => r.kind === 'random').length,
      consecutive: inBin.filter((r) => r.kind === 'consecutive').length,
      systematic: inBin.filter((r) => r.kind === 'systematic').length,
    }
  })

  const kindCounts: Record<MissingKind, number> = { random: 0, consecutive: 0, systematic: 0 }
  for (const r of allRuns) kindCounts[r.kind]++

  // ---- calendar heat --------------------------------------------------------
  const weekMap = new Map<string, { total: number; missing: number }>()
  for (let i = fromIdx; i <= toIdx; i++) {
    const iso = series.dates[i]
    const d = new Date(`${iso}T00:00:00Z`)
    const dow = (d.getUTCDay() + 6) % 7
    const monday = new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10)
    const rec = weekMap.get(monday) ?? { total: 0, missing: 0 }
    rec.total++
    if (series.actual[i] == null) rec.missing++
    weekMap.set(monday, rec)
  }
  const heat = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, v]) => ({ weekStart, rate: v.total ? v.missing / v.total : 0, count: v.missing, total: v.total }))

  const weekdayRates = weekdayTotal.map((t, i) => ({ label: WEEK_LABELS[i], rate: t ? weekdayMissing[i] / t : 0, count: weekdayMissing[i] }))

  const totalCells = total * (FEATURES.length + 1)
  const missingCells = [demand, ...columns].reduce((a, c) => a + c.missing, 0)

  const covRecommendation = Object.fromEntries(columns.map((c) => [c.feature, c.recommended])) as Record<FeatureId, 'impute' | 'downweight' | 'block'>

  const primaryRun =
    demandRuns
      .filter((r) => r.kind !== 'random')
      .sort((a, b) => b.length - a.length)[0] ??
    demandRuns.sort((a, b) => b.length - a.length)[0] ??
    null

  return {
    columns,
    demand,
    runs: allRuns,
    missingCells,
    totalCells,
    overallRate: missingCells / Math.max(1, totalCells),
    kindCounts,
    runBins,
    weekday: weekdayRates,
    heat,
    primaryRun,
    systematicColumns: columns.filter((c) => c.kind === 'systematic').length,
    consecutiveRuns: allRuns.filter((r) => r.kind === 'consecutive').length,
    randomRuns: allRuns.filter((r) => r.kind === 'random').length,
    recommendation: { demand: demand.recommended, covariates: covRecommendation },
  }
}

function chiSquareP(chi: number, df: number): number {
  if (df <= 0) return 1
  const z = Math.cbrt(chi / df) - (1 - 2 / (9 * df))
  return 1 - normalCdf(z / Math.sqrt(2 / (9 * df)))
}

function runsTestZ(seq: number[]): number {
  const n1 = seq.filter((x) => x === 1).length
  const n2 = seq.length - n1
  if (n1 < 2 || n2 < 2) return 0
  let runs = 1
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) runs++
  const mu = (2 * n1 * n2) / (n1 + n2) + 1
  const variance = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) / ((n1 + n2) ** 2 * (n1 + n2 - 1))
  return variance > 0 ? (runs - mu) / Math.sqrt(variance) : 0
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

export { clamp }
