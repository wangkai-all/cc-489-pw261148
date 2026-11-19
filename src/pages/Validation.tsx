import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { Badge, Modal, StatusIcon, Switch, fmtDateTime } from '../components/ui'
import { ChartCard, CoveragePlot, ErrorScatter, LineChart } from '../components/charts'
import { fmtNum, mean, pct } from '../lib/stats'
import { addDays } from '../lib/date'
import { weekdayCn } from '../components/ui'
import { summarizeBreak } from '../model/breakpoints'
import { REVISION_REASONS } from '../model/versions'

export function ValidationPage() {
  const { sku, series, cfg, backtest, engine, breakpoints, diag, versions, currentVersionId, rollbackTo, say, flags, treatment } = useApp()
  const [selectedBp, setSelectedBp] = useState<string | null>(null)
  const [rolledBack, setRolledBack] = useState<string | null>(null)
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const coverageByHorizon = backtest.byHorizon.map((h) => ({ label: `h${h.horizon}`, value: h.coverage80, n: h.count }))
  const coverage95ByHorizon = backtest.byHorizon.map((h) => ({ label: `h${h.horizon}`, value: h.coverage95, n: h.count }))

  const scatterPoints = useMemo(
    () =>
      backtest.points
        .filter((p) => (showAll ? true : p.horizon <= 7))
        .map((p) => ({ x: p.horizon, y: p.err / Math.max(1, p.actual), covered: p.covered80, label: `${p.target} · h${p.horizon} · 预测 ${Math.round(p.yhat)} / 实际 ${Math.round(p.actual)}` })),
    [backtest.points, showAll],
  )

  // One-step-ahead backtest: for each origin the model never saw the next day,
  // so the band is an honest out-of-sample interval rather than in-sample fit.
  const interval = useMemo(() => {
    const start = addDays(cfg.end, -28)
    const fromIdx = Math.max(0, series.dates.indexOf(start))
    const endIdx = series.dates.indexOf(cfg.end)
    const oneStep = new Map(backtest.points.filter((p) => p.horizon === 1).map((p) => [p.target, p]))
    const actual: { x: number; y: number | null }[] = []
    const fitted: { x: number; y: number | null }[] = []
    const up: { x: number; y: number | null }[] = []
    const lo: { x: number; y: number | null }[] = []
    for (let i = fromIdx; i <= endIdx; i++) {
      const d = series.dates[i]
      const bt = oneStep.get(d)
      actual.push({ x: i, y: series.actual[i] })
      fitted.push({ x: i, y: bt ? bt.yhat : (engine.forecast.fitted.find((f) => f.date === d)?.yhat ?? null) })
      up.push({ x: i, y: bt ? bt.hi80 : null })
      lo.push({ x: i, y: bt ? bt.lo80 : null })
    }
    const xTicks: { x: number; label: string }[] = []
    for (let i = fromIdx; i <= endIdx; i += 7) xTicks.push({ x: i, label: series.dates[i].slice(5) })
    return {
      series: [
        { id: 'actual', label: '实际', color: 'var(--ink-2)', points: actual, width: 1.6 },
        { id: 'fit', label: '一步预测', color: 'var(--s1)', points: fitted, width: 1.8 },
      ],
      bands: [{ id: '80', color: 'var(--s1)', upper: up, lower: lo, dashedEdge: true }],
      xTicks,
    }
  }, [cfg.end, series, engine.forecast, backtest.points])

  const residual: { x: number; y: number | null }[] = []
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]
    if (d < cfg.start || d > cfg.end) continue
    const a = series.actual[i]
    const f = engine.forecast.fitted.find((x) => x.date === d)
    if (a == null || !f) continue
    residual.push({ x: i, y: a - f.yhat })
  }
  const residualMean = mean(residual.map((r) => r.y ?? 0))
  const residualAbs = mean(residual.map((r) => Math.abs(r.y ?? 0)))

  const worst = [...backtest.points].sort((a, b) => Math.abs(b.err / Math.max(1, b.actual)) - Math.abs(a.err / Math.max(1, a.actual))).slice(0, 6)

  const allPass = backtest.summary.every((s) => s.status === 'pass')
  const warnCount = backtest.summary.filter((s) => s.status === 'warn').length
  const failCount = backtest.summary.filter((s) => s.status === 'fail').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">验证与回滚</h1>
          <div className="page-desc">
            滚动起点回测（{backtest.originCount} 个起点 × 14 天步长）检查误差、区间校准与偏差；断点与异常值逐条复核；最后验证模型版本回滚链路。
          </div>
        </div>
        <div className="page-meta">
          <div className="meta-block">
            <div className="k">验收结论</div>
            <div className="v">
              {failCount ? <Badge tone="crit">未通过</Badge> : warnCount ? <Badge tone="warn">有警告</Badge> : <Badge tone="good">通过</Badge>}
            </div>
          </div>
          <div className="meta-block">
            <div className="k">样本点</div>
            <div className="v mono">{fmtNum(backtest.n)}</div>
          </div>
          <div className="meta-block">
            <div className="k">当前版本</div>
            <div className="v mono">{currentVersionId ?? '草稿'}</div>
          </div>
        </div>
      </div>

      <div className="kpis section">
        <div className="kpi">
          <div className="k">MAPE</div>
          <div className="v">{pct(backtest.mape)}</div>
          <div className={`d ${backtest.mape <= backtest.baselineMape ? 'up' : 'down'}`}>
            基线（季节朴素）{pct(backtest.baselineMape)} · 改善 {pct(1 - backtest.mape / backtest.baselineMape)}
          </div>
          <div className="d dim">滚动起点 · 只计真实观测</div>
        </div>
        <div className="kpi">
          <div className="k">80% 区间覆盖</div>
          <div className="v">{pct(backtest.coverage80)}</div>
          <div className={`d ${Math.abs(backtest.coverage80 - 0.8) <= 0.06 ? 'up' : 'down'}`}>目标 80% ± 6pp</div>
          <div className="d dim">过度自信会让覆盖率塌到 60% 以下</div>
        </div>
        <div className="kpi">
          <div className="k">95% 区间覆盖</div>
          <div className="v">{pct(backtest.coverage95)}</div>
          <div className={`d ${backtest.coverage95 >= 0.9 ? 'up' : 'down'}`}>目标 ≥ 90%</div>
          <div className="d dim">远端尾部校准</div>
        </div>
        <div className="kpi">
          <div className="k">MASE</div>
          <div className="v">{Number.isFinite(backtest.mase) ? backtest.mase.toFixed(2) : '—'}</div>
          <div className={`d ${backtest.mase < 1 ? 'up' : 'down'}`}>{backtest.mase < 1 ? '优于季节朴素' : '劣于季节朴素'}</div>
          <div className="d dim">相对 7 天朴素预测的平均绝对误差</div>
        </div>
        <div className="kpi">
          <div className="k">偏差</div>
          <div className="v">{backtest.bias > 0 ? '+' : ''}{fmtNum(Math.round(backtest.bias))}<small>件/天</small></div>
          <div className={`d ${Math.abs(backtest.bias) < 0.02 * mean(backtest.points.map((p) => p.actual)) ? 'up' : 'down'}`}>
            相对均值 {pct(backtest.bias / Math.max(1, mean(backtest.points.map((p) => p.actual))))}
          </div>
          <div className="d dim">{backtest.bias > 0 ? '低估' : '高估'}为主</div>
        </div>
      </div>

      <div className="grid g2 section" style={{ alignItems: 'start' }}>
        <ChartCard
          title="滚动起点残差"
          subtitle="每个点是一次预测的误差率；橙色点为超出 80% 区间"
          legend={[
            { label: '落在 80% 区间内', color: 'var(--s1)', kind: 'rect' },
            { label: '超出区间', color: 'var(--s2)', kind: 'rect' },
          ]}
          actions={<label className="row" style={{ gap: 6, fontSize: 11 }}><Switch checked={showAll} onChange={setShowAll} label="显示全部步长" />全部 14 天</label>}
          table={{
            caption: '按步长汇总的误差与覆盖率',
            columns: ['步长', 'MAPE', '80% 覆盖', '95% 覆盖', '样本'],
            rows: backtest.byHorizon.map((h) => [`h${h.horizon}`, pct(h.mape), pct(h.coverage80), pct(h.coverage95), h.count]),
          }}
        >
          <ErrorScatter
            points={scatterPoints}
            xFormat={(v) => `h${Math.round(v)}`}
            ariaLabel="滚动起点回测的误差率散点图，按预测步长展开"
            height={236}
          />
        </ChartCard>

        <ChartCard
          title="区间覆盖率随步长"
          subtitle="越远步长越难覆盖；虚线为目标 80%"
          table={{
            columns: ['步长', '80% 覆盖', '95% 覆盖', '样本'],
            rows: coverageByHorizon.map((c, i) => [c.label, pct(c.value), pct(coverage95ByHorizon[i].value), c.n ?? 0]),
          }}
        >
          <CoveragePlot points={coverageByHorizon} target={0.8} ariaLabel="80% 预测区间覆盖率随预测步长变化" height={200} />
          <div className="stat-label" style={{ marginTop: 8 }}>95% 区间覆盖率</div>
          <CoveragePlot points={coverage95ByHorizon} target={0.9} color="var(--s3)" ariaLabel="95% 预测区间覆盖率随预测步长变化" height={150} />
        </ChartCard>
      </div>

      <div className="grid g2 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">验收状态</h3>
              <div className="card-sub">阈值与结果对照</div>
            </div>
            <div className="card-actions">
              {failCount ? <Badge tone="crit">{failCount} 项未通过</Badge> : warnCount ? <Badge tone="warn">{warnCount} 项警告</Badge> : <Badge tone="good">全部通过</Badge>}
            </div>
          </div>
          <div className="card-body">
            <table className="tbl">
              <thead><tr><th>指标</th><th>目标</th><th className="num">实测</th><th>状态</th></tr></thead>
              <tbody>
                {backtest.summary.map((s) => (
                  <tr key={s.label}>
                    <td>{s.label}</td>
                    <td className="small dim">{s.target}</td>
                    <td className="num">{s.actual}</td>
                    <td>
                      <span className="row" style={{ gap: 5 }}>
                        <StatusIcon status={s.status === 'pass' ? 'pass' : s.status === 'warn' ? 'warn' : 'fail'} />
                        {s.status === 'pass' ? '通过' : s.status === 'warn' ? '警告' : '未通过'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {allPass ? (
              <div className="callout" style={{ marginTop: 10 }}>
                <span className="mark">✓</span>
                <div>全部指标达标，可以发布。若之后回补数据，请重新运行本页验收再保存新版本。</div>
              </div>
            ) : (
              <div className="callout warn" style={{ marginTop: 10 }}>
                <span className="mark">⚠️</span>
                <div>存在未达标项。常见修复：把营销列从插补改为阻断、或在「缺失诊断」里把需求缺口改为降权策略，然后重新回测。</div>
              </div>
            )}
            <div className="stat-label" style={{ marginTop: 12 }}>误差最大的 6 个点</div>
            <div className="tbl-wrap" style={{ marginTop: 6 }}>
              <table className="tbl">
                <thead><tr><th>目标日</th><th className="num">步长</th><th className="num">预测</th><th className="num">实际</th><th className="num">误差率</th></tr></thead>
                <tbody>
                  {worst.map((p, i) => (
                    <tr key={i}>
                      <td className="mono small">{p.target}</td>
                      <td className="num">{p.horizon}</td>
                      <td className="num">{Math.round(p.yhat)}</td>
                      <td className="num">{Math.round(p.actual)}</td>
                      <td className="num">{pct(p.err / p.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <div className="stack">
          <ChartCard
            title="近 28 天拟合与区间"
            subtitle="每个点只看前一天的训练窗口，80% 区间为真正的样本外区间"
            legend={[
              { label: '实际', color: 'var(--ink-2)' },
              { label: '一步预测', color: 'var(--s1)' },
              { label: '80% 回测区间', color: 'var(--s1)', kind: 'band' },
            ]}
            table={{
              columns: ['统计量', '值'],
              rows: [
                ['残差均值', fmtNum(Math.round(residualMean))],
                ['残差绝对均值', fmtNum(Math.round(residualAbs))],
                ['插补天数', engine.forecast.imputedDays],
                ['阻断天数', engine.forecast.blockedDays],
                ['有效样本', fmtNum(Math.round(engine.forecast.effectiveN))],
              ],
            }}
          >
            <LineChart
              series={interval.series}
              bands={interval.bands}
              xTicks={interval.xTicks}
              xLabel={(x) => `${series.dates[x] ?? ''} ${series.dates[x] ? weekdayCn(series.dates[x]) : ''}`}
              formatTipY={(v) => `${fmtNum(Math.round(v))} 件`}
              height={230}
              ariaLabel="近 28 天实际值与拟合值，以及回测 80% 区间"
            />
          </ChartCard>

          <section className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">异常值验证</h3>
                <div className="card-sub">检出 {engine.quality.length} 项 · 人工保留 {(Object.values(flags).filter((f) => f === 'keep')).length} 项</div>
              </div>
            </div>
            <div className="card-body">
              {engine.quality.length === 0 ? (
                <div className="empty">无异常值待复核。</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>日期</th><th>字段</th><th className="num">倍数</th><th>决定</th></tr></thead>
                  <tbody>
                    {engine.quality.map((q) => {
                      const key = `${q.date}:${q.field}`
                      const keep = flags[key] === 'keep'
                      return (
                        <tr key={key}>
                          <td className="mono small">{q.date}</td>
                          <td>{q.field === 'demand' ? '需求' : q.field === 'marketing' ? '营销' : q.field === 'promo' ? '促销' : '节假日'}</td>
                          <td className="num">{q.expected ? (q.observed / q.expected).toFixed(2) : '—'}×</td>
                          <td>{keep ? <Badge tone="warn">保留</Badge> : <Badge tone="neutral">{q.action === 'excluded' ? '已剔除' : q.action === 'winsorized' ? '已缩尾' : q.action === 'imputed' ? '已修正' : '已标记'}</Badge>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <div className="hint" style={{ marginTop: 8 }}>在「缺失诊断」页切换「修正 / 保留」，本页状态与回测同步更新。</div>
            </div>
          </section>
        </div>
      </div>

      <div className="grid g2 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">断点验证</h3>
              <div className="card-sub">接受断点会改变训练窗口起点</div>
            </div>
            <div className="card-actions"><Badge tone="outline">{breakpoints.filter((b) => b.status === 'confirmed').length} 个已确认</Badge></div>
          </div>
          <div className="card-body">
            {breakpoints.length === 0 ? (
              <div className="empty">窗口内无显著断点。</div>
            ) : (
              <div className="vlist">
                {breakpoints.map((bp) => {
                  const isSel = selectedBp === bp.date
                  return (
                    <div key={bp.date} className="vrow" style={{ gridTemplateColumns: '1fr auto' }}>
                      <div>
                        <div className="vtitle">
                          <StatusIcon status={bp.status === 'confirmed' ? 'pass' : 'warn'} />
                          {bp.date}
                          <Badge tone={bp.status === 'confirmed' ? 'crit' : 'neutral'}>{bp.status === 'confirmed' ? '阶跃持续' : '短期波动'}</Badge>
                          <span className="dim small">z={bp.z.toFixed(1)} · {pct(bp.changePct)}</span>
                        </div>
                        <div className="vnote">{summarizeBreak(bp)}</div>
                        {isSel ? (
                          <div className="callout" style={{ marginTop: 6 }}>
                            <span className="mark">🔍</span>
                            <div>
                              前后段样本 {bp.beforeN} / {bp.afterN} 天，断点前 {Math.round(bp.before)} 件/天，断点后 {Math.round(bp.after)} 件/天；
                              {bp.persistent ? '后段中位数保持在新区间的 55% 以上，判为结构断点。' : '阶跃在 4 周内衰减，判为促销或一次性事件，不改变模型。'}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="vactions">
                        <button className="btn sm" onClick={() => setSelectedBp(isSel ? null : bp.date)}>{isSel ? '收起' : '详情'}</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="callout" style={{ marginTop: 10 }}>
              <span className="mark">📐</span>
              <div>
                断点检测同时要求：阶跃 ≥7%、z ≥ 3.6、前 6 周周中位数漂移 ≤4% 且极差 ≤12%、断点后 4 周仍在新水平。缺任一条即降级为「短期波动」。
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">模型版本回滚</h3>
              <div className="card-sub">恢复训练窗口、特征快照与策略</div>
            </div>
            <div className="card-actions"><Badge tone="s1">{currentVersionId ?? '草稿'}</Badge></div>
          </div>
          <div className="card-body">
            <div className="steps">
              <div className="step">
                <span className="strong">1</span>
                <div>
                  <b>选择目标快照</b>
                  <div className="dim small">回滚会替换当前训练窗口、模型配置、缺失策略与清洗口径；已回补的原始数据保留。</div>
                </div>
              </div>
              <div className="step">
                <span className="strong">2</span>
                <div>
                  <b>核对差异</b>
                  <div className="tbl-wrap" style={{ marginTop: 6 }}>
                    <table className="tbl diff-table">
                      <thead><tr><th>项</th><th>当前</th><th>目标</th></tr></thead>
                      <tbody>
                        {(confirmRollback ? versions.filter((v) => v.id === confirmRollback) : []).map((v) => (
                          <RollbackRows key={v.id} target={v} current={versions.find((x) => x.id === currentVersionId)} />
                        ))}
                        {!confirmRollback ? (
                          <tr><td colSpan={3} className="dim small">选择下方任一版本后在此显示逐项差异。</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="step">
                <span className="strong">3</span>
                <div>
                  <b>确认并重算</b>
                  <div className="dim small">回滚后模型立即用目标快照重算，当前版本指针切换到该快照。</div>
                </div>
              </div>
            </div>
            <div className="divider" />
            <div className="vlist" style={{ maxHeight: 260, overflow: 'auto' }}>
              {[...versions].reverse().map((v) => (
                <div key={v.id} className={`vrow ${confirmRollback === v.id ? 'current' : ''}`} style={{ gridTemplateColumns: '40px 1fr auto' }}>
                  <div className="vseq">{v.id}</div>
                  <div>
                    <div className="vtitle">
                      {v.reasonCodes.map((code) => <Badge key={code} tone="neutral">{REVISION_REASONS.find((r) => r.code === code)?.label ?? code}</Badge>)}
                      {v.id === currentVersionId ? <Badge tone="s1">当前</Badge> : null}
                    </div>
                    <div className="vmeta">{v.window.start} → {v.window.end} · MAPE {pct(v.metrics.mape)}</div>
                  </div>
                  <button className="btn sm" disabled={v.id === currentVersionId} onClick={() => setConfirmRollback(v.id)}>
                    {v.id === currentVersionId ? '当前' : '选为回滚目标'}
                  </button>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setConfirmRollback(null)} disabled={!confirmRollback}>取消</button>
              <button className="btn primary" disabled={!confirmRollback} onClick={() => { if (confirmRollback) { rollbackTo(confirmRollback); setRolledBack(confirmRollback); say(`已回滚到 <b>${confirmRollback}</b>，模型按该快照重新计算`); setConfirmRollback(null) } }}>
                执行回滚
              </button>
            </div>
            {rolledBack ? (
              <div className="callout" style={{ marginTop: 10 }}>
                <span className="mark">✅</span>
                <div>
                  已回滚到 <b>{rolledBack}</b>（{fmtDateTime(versions.find((v) => v.id === rolledBack)?.createdAt ?? '')}）。
                  当前窗口 <b>{cfg.start} → {cfg.end}</b>，需求策略 <b>{treatment.demand === 'impute' ? '插补' : treatment.demand === 'downweight' ? '降权' : '阻断'}</b>；
                  地图与图表已用回滚后的配置重算。回滚后仍可继续回补数据并保存新版本。
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card section">
        <div className="card-head">
          <div>
            <h3 className="card-title">数据质量与诊断摘要</h3>
            <div className="card-sub">跨页面对账：诊断结论应与本页验证一致</div>
          </div>
        </div>
        <div className="card-body">
          <div className="grid g3">
            <div>
              <div className="stat-label">缺失结构</div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <Badge tone="s1">随机 {diag.kindCounts.random}</Badge>
                <Badge tone="s2">连续 {diag.kindCounts.consecutive}</Badge>
                <Badge tone="crit">系统性 {diag.kindCounts.systematic}</Badge>
              </div>
              <div className="dim small" style={{ marginTop: 6 }}>需求缺口 {diag.demand.missing} 天，最长 {diag.demand.longest?.length ?? 0} 天。</div>
            </div>
            <div>
              <div className="stat-label">模型</div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                训练行 <b>{fmtNum(engine.forecast.trainN)}</b> · 插补 <b>{engine.forecast.imputedDays}</b> 天 · 阻断 <b>{engine.forecast.blockedDays}</b> 天
              </div>
              <div className="dim small" style={{ marginTop: 4 }}>设计矩阵指纹 <span className="mono">{engine.forecast.designHash}</span></div>
            </div>
            <div>
              <div className="stat-label">断点</div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                检出 <b>{breakpoints.length}</b> 个 · 已确认 <b>{breakpoints.filter((b) => b.status === 'confirmed').length}</b> 个
              </div>
              <div className="dim small" style={{ marginTop: 4 }}>{breakpoints.filter((b) => b.status === 'confirmed').map((b) => b.date).join('、') || '无'}</div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

function RollbackRows({ target, current }: { target: { window: { start: string; end: string }; treatment: { demand: string; covariates: { marketing: string } }; metrics: { mape: number }; reasonNote: string }; current?: { id: string; window: { start: string; end: string }; treatment: { demand: string; covariates: { marketing: string } }; metrics: { mape: number } } }) {
  return (
    <>
      <tr><td>训练窗口</td><td className="diff-from">{current ? `${current.window.start} → ${current.window.end}` : '—'}</td><td className="diff-to">{target.window.start} → {target.window.end}</td></tr>
      <tr><td>需求策略</td><td className="diff-from">{current?.treatment.demand ?? '—'}</td><td className="diff-to">{target.treatment.demand}</td></tr>
      <tr><td>营销列</td><td className="diff-from">{current?.treatment.covariates.marketing ?? '—'}</td><td className="diff-to">{target.treatment.covariates.marketing}</td></tr>
      <tr><td>回测 MAPE</td><td className="diff-from">{current ? pct(current.metrics.mape) : '—'}</td><td className="diff-to">{pct(target.metrics.mape)}</td></tr>
    </>
  )
}
