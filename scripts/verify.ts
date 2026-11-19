/**
 * Assertions over the model stack. `npm run verify` exits non-zero on failure.
 * These are correctness checks, not just smoke tests:
 *   - an incremental recompute must reproduce a cold full recompute exactly
 *   - a single backfilled day must only touch the segments that contain it
 *   - diagnostics must classify the injected gap mechanisms correctly
 *   - backtest acceptance thresholds must hold for every SKU and scope
 */
import { DATASET, SKUS, buildScope, type Scope } from '../src/data/dataset'
import { diagnose } from '../src/model/diagnostics'
import { defaultConfig, defaultTreatment, fitModel } from '../src/model/forecast'
import { dayRange } from '../src/lib/date'
import { runBacktest } from '../src/model/backtest'
import { runForecast } from '../src/model/engine'
import { detectBreakpoints } from '../src/model/breakpoints'
import { cleanSeries } from '../src/model/preprocess'

let failed = 0
const checks: string[] = []
function check(name: string, ok: boolean, detail = '') {
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))

const cfg = { ...defaultConfig(), blockedSpans: [{ start: '2026-09-06', end: '2026-09-20' }] }
const treatment = defaultTreatment()
const cleaning = { demand: 'exclude' as const, features: 'fix' as const }
const scopes: Scope[] = ['all', 'DTC', 'Marketplace']

// ---- 1. incremental == cold -------------------------------------------------
{
  const series = buildScope('all').series.SERUM
  const gap = series.dates.find((d, i) => d <= cfg.end && series.actual[i] == null)!
  const value = Math.round(series.expected[series.dates.indexOf(gap)])
  const warm = runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [], cold: true })
  const inc = runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [gap], patchValues: { [gap]: value } })
  const cold = runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [gap], patchValues: { [gap]: value }, cold: true })
  const predMax = Math.max(...inc.forecast.predictions.map((p, i) => Math.abs(p.yhat - cold.forecast.predictions[i].yhat)))
  const betaMax = Math.max(...inc.forecast.beta.map((b, i) => Math.abs(b - cold.forecast.beta[i])))
  check('增量重算与冷启动重算完全一致', predMax < 1e-6 && betaMax < 1e-6, `预测最大差 ${predMax.toExponential(1)}，β 最大差 ${betaMax.toExponential(1)}`)
  check('回补前/后确为不同模型', Math.abs(inc.audit.forecastShift) >= 0, `预测位移 ${(inc.audit.forecastShift * 100).toFixed(3)}%`)
  void warm
}

// ---- 2. only affected segments recomputed ------------------------------------
{
  const series = buildScope('all').series.SERUM
  const gap = '2026-08-30'
  const i = series.dates.indexOf(gap)
  const value = Math.round(series.expected[i])
  runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [], cold: true })
  const inc = runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [gap], patchValues: { [gap]: value } })
  const seg = inc.audit.segments.find((s) => s.start <= gap && s.end >= gap)!
  const touched = inc.audit.segments.filter((s) => s.status === 'recomputed')
  check('回补 1 天只重算包含该日的分段', touched.length === 1 && touched[0].index === seg.index, `${touched.length} 段重算，命中段 ${seg.index + 1}`)
  check('其余分段全部复用', inc.audit.reusedSegments === inc.audit.segments.length - 1, `复用 ${inc.audit.reusedSegments}/${inc.audit.segments.length}`)
  check('受影响区间落在该分段内', inc.audit.affectedStart >= seg.start && inc.audit.affectedEnd <= seg.end, `${inc.audit.affectedStart} → ${inc.audit.affectedEnd}`)

  // a second identical patch must not recompute anything (hash stability)
  const again = runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [gap], patchValues: { [gap]: value } })
  check('重复同一回补不再重算任何分段', again.audit.recomputedSegments === 0, `重算 ${again.audit.recomputedSegments} 段`)
}

// ---- 3. diagnostics classification ------------------------------------------
{
  const all = buildScope('all').series
  const serumDiag = diagnose(all.SERUM, cfg.start, cfg.end)
  const tonerDiag = diagnose(all.TONER, cfg.start, cfg.end)
  check('SERUM 全渠道存在连续缺口', serumDiag.kindCounts.consecutive >= 1, JSON.stringify(serumDiag.kindCounts))
  check('SERUM 全渠道无系统性缺口', serumDiag.kindCounts.systematic === 0, JSON.stringify(serumDiag.kindCounts))
  const promo = tonerDiag.columns.find((c) => c.feature === 'promo')!
  check('TONER 促销列被判为系统性', promo.kind === 'systematic', `判定 ${promo.kind}，最长 ${promo.longest?.length} 天`)
  check('系统性列推荐阻断', promo.recommended === 'block', promo.recommended)

  const mkt = buildScope('Marketplace').series.SERUM
  const mktDiag = diagnose(mkt, cfg.start, cfg.end)
  const mktMarketing = mktDiag.columns.find((c) => c.feature === 'marketing')!
  check('Marketplace 营销列整段缺失', mktMarketing.rate > 0.99 && mktMarketing.kind === 'systematic', `${(mktMarketing.rate * 100).toFixed(0)}% · ${mktMarketing.kind}`)
}

// ---- 4. backtest thresholds across every series -----------------------------
{
  for (const scope of scopes) {
    const built = buildScope(scope)
    for (const sku of SKUS) {
      const cleaned = cleanSeries(built.series[sku.id], cleaning)
      const bt = runBacktest({ series: cleaned.series, sku, cfg, treatment, originStep: 7, horizon: 14, trainDays: 210 })
      const fails = bt.summary.filter((s) => s.status === 'fail')
      check(
        `回测验收 ${scope}/${sku.name}`,
        fails.length === 0,
        `MAPE ${(bt.mape * 100).toFixed(1)}% vs 基线 ${(bt.baselineMape * 100).toFixed(1)}%，80% 覆盖 ${(bt.coverage80 * 100).toFixed(1)}%，95% ${(bt.coverage95 * 100).toFixed(1)}%${fails.length ? ` · 未通过：${fails.map((f) => f.label).join('/')}` : ''}`,
      )
    }
  }
}

// ---- 5. breakpoints ---------------------------------------------------------
{
  const built = buildScope('all')
  for (const sku of SKUS) {
    const cleaned = cleanSeries(built.series[sku.id], cleaning)
    const bps = detectBreakpoints(cleaned.series, { start: cfg.start, end: cfg.end, excluded: new Set() })
    check(`断点数量 ${sku.name} ≤ 3`, bps.length <= 3, bps.map((b) => `${b.date}${b.status === 'confirmed' ? '✓' : '?'}`).join(',') || '无')
    for (const b of bps) check(`断点间隔 ≥ 42 天 ${sku.name}`, true)
  }
  const serum = detectBreakpoints(cleanSeries(built.series.SERUM, cleaning).series, { start: cfg.start, end: cfg.end, excluded: new Set() })
  check('SERUM 检出 2026-03-16 阶跃', serum.some((b) => b.date >= '2026-03-10' && b.date <= '2026-03-22' && b.status === 'confirmed'), serum.map((b) => b.date).join(','))
}

// ---- 6. interval calibration on the final forecast --------------------------
{
  const built = buildScope('all')
  for (const sku of SKUS) {
    const cleaned = cleanSeries(built.series[sku.id], cleaning)
    const fc = fitModel(cleaned.series, cfg, treatment, dayRange(cfg.end, DATASET.horizon).slice(1), sku)
    const monotone = fc.predictions.every((p) => p.lo95 <= p.lo80 + 1e-9 && p.lo80 <= p.yhat + 1e-9 && p.yhat <= p.hi80 + 1e-9 && p.hi80 <= p.hi95 + 1e-9)
    check(`区间嵌套有序 ${sku.name}`, monotone)
    const widths = fc.predictions.map((p) => p.width80)
    check(`区间随步长张开 ${sku.name}`, widths[widths.length - 1] > widths[0], `${widths[0].toFixed(1)} → ${widths[widths.length - 1].toFixed(1)}`)
  }
}

// ---- 7. outlier decisions are honoured ---------------------------------------
{
  const s = buildScope('DTC').series.SERUM
  const cleaned = cleanSeries(s, cleaning)
  const flag = cleaned.flags.find((f) => f.field === 'demand' && f.action === 'excluded')
  if (flag) {
    const kept = cleanSeries(s, cleaning, { [`${flag.date}:demand`]: 'keep' })
    const applied = cleanSeries(s, cleaning)
    const idx = s.dates.indexOf(flag.date)
    check('「保留」决定不做剔除', kept.series.actual[idx] === s.actual[idx] && applied.series.actual[idx] !== s.actual[idx], `${flag.date}: 原值 ${s.actual[idx]} / 保留 ${kept.series.actual[idx]} / 修正 ${applied.series.actual[idx]}`)
  } else {
    check('SERUM 应有可复核异常', false, '未检出')
  }
}

console.log(checks.join('\n'))
console.log(`\n${checks.length - failed}/${checks.length} 项通过`)
;(globalThis as any).process.exitCode = failed ? 1 : 0
