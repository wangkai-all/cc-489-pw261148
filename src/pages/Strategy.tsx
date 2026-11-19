import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { Badge, Segmented } from '../components/ui'
import { ChartCard, ColumnChart, HBars } from '../components/charts'
import { fmtNum, pct } from '../lib/stats'
import { DATASET, type FeatureId } from '../data/dataset'
import { fitModel, type Strategy, type TreatmentPlan } from '../model/forecast'
import { runBacktest } from '../model/backtest'

const STRATEGIES: { value: Strategy; label: string; blurb: string }[] = [
  { value: 'impute', label: '插补', blurb: '线性插值 × 星期因子补齐缺口，正常参与回归。保留信息量，但长缺口会引入平滑偏差。' },
  { value: 'downweight', label: '降权', blurb: '插补后把缺口段权重压到 0.32，模型更信任真实观测。抖动更小，但近端信息利用率下降。' },
  { value: 'block', label: '阻断', blurb: '缺口段整段剔除，只用完整观测训练。最保守，样本最少、区间最宽。' },
]

export function StrategyPage() {
  const { sku, series, cfg, treatment, setTreatment, cleaning, diag, engine, say } = useApp()
  const [focus, setFocus] = useState<Strategy>(treatment.demand)

  // 时段阻断（blockedSpans）会把整段缺口提前排除，从而掩盖列级策略之间的差异。
  // 策略对比刻意在“无时段阻断”的配置下进行，让三种需求策略真正作用于同一批缺失。
  const compareCfg = useMemo(() => ({ ...cfg, blockedSpans: [] }), [cfg])
  const spansMuted = cfg.blockedSpans.length > 0

  const comparison = useMemo(() => {
    return STRATEGIES.map((s) => {
      const plan: TreatmentPlan = { ...treatment, demand: s.value }
      const bt = runBacktest({ series: engine.cleaned, sku, cfg: compareCfg, treatment: plan, originStep: 7, horizon: 14, trainDays: 210 })
      const fc = fitModel(engine.cleaned, compareCfg, plan, horizonDates(compareCfg.end), sku)
      const horizon = fc
      const total = horizon.predictions.reduce((a, p) => a + p.yhat, 0)
      const width80 = horizon.predictions.reduce((a, p) => a + (p.hi80 - p.lo80), 0) / Math.max(1, horizon.predictions.length)
      return {
        strategy: s.value,
        label: s.label,
        mape: bt.mape,
        rmse: bt.rmse,
        coverage80: bt.coverage80,
        coverage95: bt.coverage95,
        bias: bt.bias,
        mase: bt.mase,
        horizonTotal: total,
        width80,
        trainN: fc.trainN,
        blocked: fc.blockedDays,
        imputed: fc.imputedDays,
        sigma: fc.sigma,
        baseline: bt.baselineMape,
        n: bt.n,
      }
    })
  }, [engine.cleaned, compareCfg, treatment, sku])

  const current = comparison.find((c) => c.strategy === treatment.demand) ?? comparison[0]
  const best = [...comparison].sort((a, b) => a.mape - b.mape)[0]
  const baseTotal = comparison[0]?.horizonTotal || 1

  const promote = (s: Strategy) => {
    setTreatment((prev) => ({ ...prev, demand: s }))
    say(`需求量缺失策略切换为 <b>${STRATEGIES.find((x) => x.value === s)?.label}</b>，全部版本血缘将记录该变化`)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">策略对比</h1>
          <div className="page-desc">
            对同一训练窗口分别施加插补 / 降权 / 阻断，比较回测误差、区间覆盖率与 28 天预测的位移。策略一经保存即冻结进版本。
          </div>
        </div>
        <div className="page-meta">
          <div className="meta-block">
            <div className="k">当前策略</div>
            <div className="v">{STRATEGIES.find((s) => s.value === treatment.demand)?.label}</div>
          </div>
          <div className="meta-block">
            <div className="k">回测 MAPE</div>
            <div className="v mono">{pct(current.mape)}</div>
          </div>
        </div>
      </div>

      <div className="kpis section">
        {comparison.map((c) => (
          <div key={c.strategy} className="kpi" style={c.strategy === treatment.demand ? { boxShadow: 'inset 0 0 0 1.5px var(--s1)' } : undefined}>
            <div className="k">
              {c.label}
              {c.strategy === treatment.demand ? <Badge tone="s1">当前</Badge> : null}
              {c.strategy === best.strategy && c.strategy !== treatment.demand ? <Badge tone="good">最优</Badge> : null}
            </div>
            <div className="v">{pct(c.mape)}<small>MAPE</small></div>
            <div className={`d ${c.coverage80 >= 0.74 && c.coverage80 <= 0.86 ? 'up' : 'down'}`}>
              80% 覆盖 {pct(c.coverage80)} · 95% {pct(c.coverage95)}
            </div>
            <div className="d dim">28 天合计 {fmtNum(Math.round(c.horizonTotal))} 件 · σ {fmtNum(Math.round(c.sigma))}</div>
          </div>
        ))}
        <div className="kpi">
          <div className="k">策略分歧</div>
          <div className="v">{(Math.max(...comparison.map((c) => Math.abs(c.horizonTotal / baseTotal - 1))) * 100).toFixed(1)}<small>%</small></div>
          <div className="d">28 天预测相对插补基准的最大位移</div>
          <div className="d dim">分歧越大，缺失策略越影响决策</div>
        </div>
      </div>

      <ChartCard
        title="策略差异"
        subtitle={
          spansMuted
            ? '同一预测窗口下三种需求策略的表现。对比关闭了时段阻断，否则整段缺口会先被剔除、三种策略将收敛为同一结果'
            : '同一预测窗口下三种需求策略的表现；误差越低越好，覆盖率越接近目标越好'
        }
        className="section"
        legend={[
          { label: '回测 MAPE', color: 'var(--s1)', kind: 'rect' },
          { label: '80% 区间覆盖', color: 'var(--s3)', kind: 'rect' },
        ]}
        table={{
          caption: '三种需求策略的回测与预测指标',
          columns: ['策略', 'MAPE', 'RMSE', 'MASE', '偏差', '80% 覆盖', '95% 覆盖', '28 天合计', '区间宽度/天', '训练行'],
          rows: comparison.map((c) => [
            c.label,
            pct(c.mape),
            fmtNum(Math.round(c.rmse)),
            c.mase.toFixed(2),
            pct(c.bias),
            pct(c.coverage80),
            pct(c.coverage95),
            fmtNum(Math.round(c.horizonTotal)),
            fmtNum(Math.round(c.width80)),
            fmtNum(c.trainN),
          ]),
        }}
      >
        <div className="grid g2" style={{ gap: 18 }}>
          <div>
            <div className="stat-label">回测 MAPE（越低越好）</div>
            <HBars
              items={comparison.map((c) => ({ label: c.label, value: c.mape, note: c.strategy === best.strategy ? '最优' : undefined }))}
              formatValue={(v) => pct(v)}
              color="var(--s1)"
              max={Math.max(...comparison.map((c) => c.mape)) * 1.15}
              ariaLabel="三种需求缺失策略的回测 MAPE"
            />
          </div>
          <div>
            <div className="stat-label">80% 区间实测覆盖（目标 80%）</div>
            <HBars
              items={comparison.map((c) => ({ label: c.label, value: c.coverage80 }))}
              formatValue={(v) => pct(v)}
              color="var(--s3)"
              max={1}
              ariaLabel="三种需求缺失策略的 80% 区间覆盖率"
            />
            <div className="stat-label" style={{ marginTop: 12 }}>28 天预测合计（件）</div>
            <HBars
              items={comparison.map((c) => ({ label: c.label, value: c.horizonTotal }))}
              formatValue={(v) => fmtNum(Math.round(v))}
              color="var(--s2)"
              ariaLabel="三种需求缺失策略的 28 天预测合计"
            />
          </div>
        </div>
        {spansMuted ? (
          <div className="hint" style={{ marginTop: 10 }}>
            对比未施加时段阻断（工作区当前有 {cfg.blockedSpans.length} 段：{cfg.blockedSpans.map((x) => `${x.start}→${x.end}`).join('，')}）。
            若在对比中保留该阻断，整段缺口会在进入模型前被剔除，三种策略将给出相同的训练行与预测。
          </div>
        ) : null}
      </ChartCard>

      <div className="grid g2 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">需求列策略</h3>
              <div className="card-sub">当前：{STRATEGIES.find((s) => s.value === treatment.demand)?.label}</div>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {STRATEGIES.map((s) => {
                const row = comparison.find((c) => c.strategy === s.value)!
                const on = treatment.demand === s.value
                return (
                  <button
                    key={s.value}
                    className={`reason ${on ? 'on' : ''}`}
                    style={{ textAlign: 'left' }}
                    onClick={() => setFocus(s.value)}
                    aria-pressed={on}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <b>{s.label} {on ? <Badge tone="s1">当前</Badge> : null}</b>
                      <span className="tnum small">MAPE {pct(row.mape)}</span>
                    </div>
                    <span>{s.blurb}</span>
                  </button>
                )
              })}
            </div>
            <div className="divider" />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="dim small">所选：{STRATEGIES.find((s) => s.value === focus)?.label}</span>
              <button className="btn primary" onClick={() => promote(focus)} disabled={focus === treatment.demand}>
                {focus === treatment.demand ? '已是当前策略' : `应用${STRATEGIES.find((s) => s.value === focus)?.label}`}
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">协变量策略矩阵</h3>
              <div className="card-sub">诊断推荐对比当前设置</div>
            </div>
          </div>
          <div className="card-body">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>协变量</th><th className="num">缺失率</th><th>机制</th><th>推荐</th><th>当前</th></tr>
                </thead>
                <tbody>
                  {diag.columns.map((c) => (
                    <tr key={c.feature}>
                      <td>{c.label}</td>
                      <td className="num">{c.missing ? pct(c.rate) : '—'}</td>
                      <td>{c.kind === 'none' ? <span className="dim">完整</span> : c.kind === 'systematic' ? <Badge tone="crit">系统性</Badge> : c.kind === 'consecutive' ? <Badge tone="s2">连续</Badge> : <Badge tone="s1">随机</Badge>}</td>
                      <td>{labelOf(c.recommended)}</td>
                      <td>
                        <Segmented
                          value={treatment.covariates[c.feature as FeatureId] ?? 'impute'}
                          onChange={(v) => {
                            setTreatment((prev) => ({ ...prev, covariates: { ...prev.covariates, [c.feature as FeatureId]: v } }))
                            say(`${c.label} 策略 → ${labelOf(v)}`)
                          }}
                          options={[
                            { value: 'impute', label: '插补' },
                            { value: 'downweight', label: '降权' },
                            { value: 'block', label: '阻断' },
                          ]}
                          ariaLabel={`${c.label} 缺失策略`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="callout" style={{ marginTop: 12 }}>
              <span className="mark">⚖️</span>
              <div>
                阻断一个协变量会让模型丢弃整列信息（当前 <b>{engine.forecast.droppedFeatures.length}</b> 列被剔除）；
                只在该列缺失属结构性、且缺失段与需求水平相关时才应阻断。降权适合长缺口但仍含有效信号的情形。
              </div>
            </div>
            <div className="hint">当前清洗：需求 {cleaning.demand === 'exclude' ? '剔除异常' : cleaning.demand === 'winsorize' ? '缩尾' : '关闭'}，特征 {cleaning.features === 'fix' ? '修正' : cleaning.features === 'flag' ? '仅标记' : '关闭'}。</div>
          </div>
        </section>
      </div>

      <ChartCard
        title="训练样本构成"
        subtitle="阻断会整段剔除缺口，插补/降权保留但降低权重；样本差异很小，说明本窗口的缺失不足以拉开三种策略"
        className="section"
        legend={[
          { label: '有效训练行', color: 'var(--s1)', kind: 'rect' },
          { label: '插补天数', color: 'var(--s2)', kind: 'rect' },
          { label: '阻断天数', color: 'var(--critical)', kind: 'rect' },
        ]}
        table={{
          columns: ['策略', '有效训练行', '插补天数', '阻断天数', '残差 σ'],
          rows: comparison.map((c) => [c.label, fmtNum(c.trainN), c.imputed, c.blocked, fmtNum(Math.round(c.sigma))]),
        }}
      >
        <div className="grid g2" style={{ gap: 22 }}>
          <div>
            <div className="stat-label">有效训练行（窗口内进入回归的行数）</div>
            <HBars
              items={comparison.map((c) => ({ label: c.label, value: c.trainN, note: c.strategy === treatment.demand ? '当前' : undefined }))}
              formatValue={(v) => fmtNum(v)}
              color="var(--s1)"
              max={Math.ceil(Math.max(...comparison.map((c) => c.trainN)) / 10) * 10}
              ariaLabel="三种策略的有效训练行数"
            />
          </div>
          <div>
            <div className="stat-label">缺口处理天数（插补 / 阻断）</div>
            <ColumnChart
              categories={comparison.map((c) => c.label)}
              series={[
                { id: 'imputed', label: '插补天数', color: 'var(--s2)', values: comparison.map((c) => c.imputed) },
                { id: 'blocked', label: '阻断天数', color: 'var(--critical)', values: comparison.map((c) => c.blocked) },
              ]}
              height={150}
              unit=" 天"
              ariaLabel="三种策略的插补与阻断天数分组柱状图"
            />
          </div>
        </div>
      </ChartCard>

      <div className="callout section">
        <span className="mark">📌</span>
        <div>
          演示建议：当前策略为 <b>{STRATEGIES.find((s) => s.value === treatment.demand)?.label}</b>，
          回测 MAPE <b>{pct(current.mape)}</b>、80% 覆盖 <b>{pct(current.coverage80)}</b>。
          若切换到 <b>{STRATEGIES.find((s) => s.value === best.strategy)?.label}</b>，MAPE 可到 <b>{pct(best.mape)}</b>，
          28 天合计变化 <b>{best.horizonTotal >= baseTotal ? '+' : ''}{fmtNum(Math.round(best.horizonTotal - baseTotal))}</b> 件。
          该对比会随保存的版本一起写入血缘，便于回滚后复盘。
        </div>
      </div>
    </>
  )
}

function labelOf(s: Strategy): string {
  return s === 'impute' ? '插补' : s === 'downweight' ? '降权' : '阻断'
}

function horizonDates(end: string): string[] {
  const out: string[] = []
  const d = new Date(`${end}T00:00:00Z`)
  for (let i = 0; i < 28; i++) {
    d.setUTCDate(d.getUTCDate() + 1)
    out.push(d.toISOString().slice(0, 10))
    if (out[out.length - 1] >= DATASET.horizon) break
  }
  return out
}
