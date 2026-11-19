/**
 * Console report for the deterministic model stack: diagnostics per scope,
 * backtest acceptance, breakpoints, outlier flags, and the incremental
 * recompute audit before/after a backfill. Run with `npm run model:stats`.
 */
import { DATASET, SKUS, buildScope, type Scope } from '../src/data/dataset'
import { diagnose } from '../src/model/diagnostics'
import { detectBreakpoints } from '../src/model/breakpoints'
import { defaultConfig, defaultTreatment } from '../src/model/forecast'
import { cleanSeries } from '../src/model/preprocess'
import { runBacktest } from '../src/model/backtest'
import { runForecast } from '../src/model/engine'
import { pct } from '../src/lib/stats'

const scopes: Scope[] = ['all', 'DTC', 'Marketplace']
const cfg = { ...defaultConfig(), blockedSpans: [{ start: '2026-09-06', end: '2026-09-20' }] }
const treatment = defaultTreatment()
const cleaning = { demand: 'exclude' as const, features: 'fix' as const }

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

for (const scope of scopes) {
  console.log(`\n=== 渠道：${scope} ===`)
  const built = buildScope(scope)
  for (const sku of SKUS) {
    const series = built.series[sku.id]
    const diag = diagnose(series, cfg.start, cfg.end)
    const cleaned = cleanSeries(series, cleaning)
    const bps = detectBreakpoints(cleaned.series, { start: cfg.start, end: cfg.end, excluded: new Set() })
    const bt = runBacktest({ series: cleaned.series, sku, cfg, treatment, originStep: 7, horizon: 14, trainDays: 210 })
    const cold = runForecast({ sku, series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [], cold: true })
    const gapDate = series.dates.find((d, i) => d <= cfg.end && series.actual[i] == null)
    let line = `${pad(sku.name, 4)} 缺失 ${pad(pct(diag.overallRate), 6)} 随机/连续/系统 ${diag.kindCounts.random}/${diag.kindCounts.consecutive}/${diag.kindCounts.systematic}`
    line += `  MAPE ${pct(bt.mape)} (基线 ${pct(bt.baselineMape)})  80%覆盖 ${pct(bt.coverage80)}  95% ${pct(bt.coverage95)}`
    line += `  断点 ${bps.map((b) => `${b.date}${b.status === 'confirmed' ? '✓' : '?'}`).join(',') || '无'}`
    line += `  异常 ${cleaned.flags.length}`
    line += `  冷启动 ${cold.audit.recomputedSegments}/${cold.audit.segments.length} 段 ${cold.audit.elapsedMs.toFixed(1)}ms`
    console.log(line)

    if (gapDate) {
      const i = series.dates.indexOf(gapDate)
      const value = Math.round((series.expected[i] ?? 0) * 1.0) || 1000
      const warm = runForecast({ sku, series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates: [] })
      const patched = runForecast({
        sku, series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning,
        patchDates: [gapDate], patchValues: { [gapDate]: value },
      })
      console.log(
        `      回补 ${gapDate}: 重算 ${patched.audit.recomputedSegments}/${patched.audit.segments.length} 段 · ` +
          `影响 ${patched.audit.affectedStart}→${patched.audit.affectedEnd} · ` +
          `${patched.audit.elapsedMs.toFixed(1)}ms vs 全量 ${patched.audit.fullElapsedMs.toFixed(1)}ms · ` +
          `β 变化 ${patched.audit.betaDelta.toFixed(4)} · 预测位移 ${(patched.audit.forecastShift * 100).toFixed(2)}%` +
          (warm.audit.mode === 'incremental' ? ' [warm]' : ''),
      )
    }
  }
}

console.log('\n=== 验收（SERUM · 全渠道） ===')
const serum = buildScope('all').series.SERUM
const cleaned = cleanSeries(serum, cleaning)
const bt = runBacktest({ series: cleaned.series, sku: SKUS[0], cfg, treatment, originStep: 7, horizon: 14, trainDays: 210 })
for (const s of bt.summary) console.log(`  ${pad(s.label, 12)} ${pad(s.actual, 10)} 目标 ${s.target}  ${s.status}`)
console.log(`  样本 ${bt.n} 点 · ${bt.originCount} 个起点`)

// Timing — the audited window itself. At 533 days every stage is sub-millisecond,
// so the meaningful number is how much work the cache avoids: one segment's
// XᵀX/Xᵀy versus the full 20-segment accumulation, plus the ridge solve.
{
  const series = buildScope('all').series.SERUM
  const gapDate = series.dates.find((d, i) => d <= cfg.end && series.actual[i] == null)!
  const i = series.dates.indexOf(gapDate)
  const value = Math.round(series.expected[i])
  const run = (patchDates: string[], patchValues?: Record<string, number>) =>
    runForecast({ sku: SKUS[0], series, datasetEnd: DATASET.horizon, cfg, treatment, cleaning, patchDates, patchValues })
  run([], {})
  const iters = 30
  const bench = (fn: () => void) => {
    const t = performance.now()
    for (let k = 0; k < iters; k++) fn()
    return (performance.now() - t) / iters
  }
  const inc = bench(() => run([gapDate], { [gapDate]: value }))
  const warm = bench(() => run([], {}))
  const a = run([gapDate], { [gapDate]: value }).audit
  console.log(`\n=== 重算审计（均值 ${iters} 次） ===`)
  console.log(`  回补 1 天: 重算 ${a.recomputedSegments}/${a.segments.length} 段（${a.recomputedDays} 天）· 复用 ${a.reusedDays} 天 · 窗口内求解 ${a.elapsedMs.toFixed(2)} ms vs 全量重解 ${a.fullElapsedMs.toFixed(2)} ms`)
  console.log(`  端到端 ${inc.toFixed(2)} ms/次（含清洗与设计矩阵，两条路径共用）`)
  console.log(`  无回补  : 全部 20 段复用 · 端到端 ${warm.toFixed(2)} ms/次`)
}
