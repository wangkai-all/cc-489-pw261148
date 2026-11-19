import { addDays, dayRange } from '../lib/date'
import { mean } from '../lib/stats'
import type { SkuMeta, SkuSeries } from '../data/dataset'
import type { ModelConfig, TreatmentPlan } from './forecast'
import { fitModel } from './forecast'

export interface BacktestPoint {
  origin: string
  target: string
  horizon: number
  actual: number
  yhat: number
  lo80: number
  hi80: number
  lo95: number
  hi95: number
  covered80: boolean
  covered95: boolean
  err: number
  /** Origin was inside a gap — the fit for that origin leaned on imputation. */
  imputedOrigin: boolean
}

export interface BacktestResult {
  points: BacktestPoint[]
  byHorizon: { horizon: number; mape: number; coverage80: number; coverage95: number; count: number }[]
  mape: number
  rmse: number
  mase: number
  bias: number
  coverage80: number
  coverage95: number
  n: number
  baselineMape: number
  originCount: number
  summary: { label: string; target: string; actual: string; status: 'pass' | 'warn' | 'fail' }[]
}

export interface BacktestOptions {
  series: SkuSeries
  sku: SkuMeta
  cfg: ModelConfig
  treatment: TreatmentPlan
  originStep: number
  horizon: number
  trainDays: number
}

/** Rolling-origin evaluation against the truthful series (gaps never score). */
export function runBacktest(opts: BacktestOptions): BacktestResult {
  const { series, sku, cfg, treatment, originStep, horizon, trainDays } = opts
  const points: BacktestPoint[] = []
  const baselineErr: { e: number; a: number }[] = []
  const modelErr: { e: number; a: number }[] = []
  const endIdx = series.dates.indexOf(cfg.end)
  let origins = 0

  if (endIdx < 80) {
    return {
      points,
      byHorizon: [],
      mape: NaN,
      rmse: NaN,
      mase: NaN,
      bias: NaN,
      coverage80: 0,
      coverage95: 0,
      n: 0,
      baselineMape: NaN,
      originCount: 0,
      summary: [],
    }
  }

  const startIdx = Math.max(0, series.dates.indexOf(cfg.start))
  // A short rollback window (e.g. 56 days from a breakpoint restart) cannot support
  // a 210-day training block. Shrink the block so the window still gets honest
  // out-of-sample points instead of silently producing zero origins.
  const span = endIdx - startIdx
  const train = Math.min(trainDays, Math.max(28, Math.floor(span * 0.5)))
  const firstOrigin = Math.max(startIdx + train, 60)

  for (let origin = firstOrigin; origin <= endIdx; origin += originStep) {
    origins++
    const trainStart = Math.max(startIdx, origin - train)
    const backCfg: ModelConfig = {
      ...cfg,
      start: series.dates[trainStart],
      end: series.dates[origin],
      kind: 'full',
    }
    const horizonDates: string[] = []
    for (let h = 1; h <= horizon; h++) {
      if (origin + h >= series.dates.length) break
      horizonDates.push(series.dates[origin + h])
    }
    if (!horizonDates.length) break
    const res = fitModel(series, backCfg, treatment, horizonDates, sku)
    const originImputed = series.actual[origin] == null
    res.predictions.forEach((p, k) => {
      const idx = series.dates.indexOf(p.date)
      const actual = series.actual[idx]
      if (actual == null) return
      const err = actual - p.yhat
      points.push({
        origin: series.dates[origin],
        target: p.date,
        horizon: k + 1,
        actual,
        yhat: p.yhat,
        lo80: p.lo80,
        hi80: p.hi80,
        lo95: p.lo95,
        hi95: p.hi95,
        covered80: actual >= p.lo80 && actual <= p.hi80,
        covered95: actual >= p.lo95 && actual <= p.hi95,
        err,
        imputedOrigin: originImputed,
      })
      modelErr.push({ e: err, a: actual })
      const bIdx = idx - 7
      const b = bIdx >= 0 ? series.actual[bIdx] : null
      if (b != null) baselineErr.push({ e: actual - b, a: actual })
    })
  }

  const mapeOf = (errs: { e: number; a: number }[]) => {
    const ok = errs.filter((x) => x.a > 0)
    return ok.length ? mean(ok.map((x) => Math.abs(x.e) / x.a)) : NaN
  }
  const n = points.length
  const mape = mapeOf(modelErr)
  const baselineMape = mapeOf(baselineErr)
  const rmse = Math.sqrt(mean(modelErr.map((e) => e.e ** 2)))
  const bias = mean(modelErr.map((e) => e.e))
  const coverage80 = n ? points.filter((p) => p.covered80).length / n : 0
  const coverage95 = n ? points.filter((p) => p.covered95).length / n : 0

  const byHorizon = []
  for (let h = 1; h <= horizon; h++) {
    const pts = points.filter((p) => p.horizon === h)
    const errs = pts.map((p) => ({ e: p.err, a: p.actual }))
    byHorizon.push({
      horizon: h,
      mape: mapeOf(errs),
      coverage80: pts.length ? pts.filter((p) => p.covered80).length / pts.length : 0,
      coverage95: pts.length ? pts.filter((p) => p.covered95).length / pts.length : 0,
      count: pts.length,
    })
  }

  const naive: number[] = []
  for (let i = startIdx + 7; i <= endIdx; i++) {
    const a = series.actual[i]
    const b = series.actual[i - 7]
    if (a != null && b != null) naive.push(Math.abs(a - b))
  }
  const mase = mean(modelErr.map((e) => Math.abs(e.e))) / (mean(naive) || 1)

  const status = (ok: boolean, warn: boolean): 'pass' | 'warn' | 'fail' => (ok ? 'pass' : warn ? 'warn' : 'fail')
  const summary = [
    {
      label: 'MAPE',
      target: '≤ 基线 −10%',
      actual: Number.isFinite(mape) ? `${(mape * 100).toFixed(1)}%` : '—',
      status: status(mape <= baselineMape * 0.9, mape <= baselineMape),
    },
    {
      label: '80% 区间覆盖',
      target: '80% ± 6pp',
      actual: `${(coverage80 * 100).toFixed(1)}%`,
      status: status(Math.abs(coverage80 - 0.8) <= 0.06, Math.abs(coverage80 - 0.8) <= 0.12),
    },
    {
      label: '95% 区间覆盖',
      target: '≥ 90%',
      actual: `${(coverage95 * 100).toFixed(1)}%`,
      status: status(coverage95 >= 0.9, coverage95 >= 0.85),
    },
    {
      label: 'MASE',
      target: '< 1.0',
      actual: mase.toFixed(2),
      status: status(mase < 1, mase < 1.2),
    },
    {
      label: '偏差',
      target: '|bias| < 2% 均值',
      actual: `${bias > 0 ? '+' : ''}${bias.toFixed(0)} 件/天`,
      status: status(Math.abs(bias) < 0.02 * mean(modelErr.map((e) => e.a)), Math.abs(bias) < 0.05 * mean(modelErr.map((e) => e.a))),
    },
  ]

  void addDays
  void dayRange
  return { points, byHorizon, mape, rmse, mase, bias, coverage80, coverage95, n, baselineMape, originCount: origins, summary }
}
