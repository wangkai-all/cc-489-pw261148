import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { Badge, Modal, Segmented, Stat, Switch, fmtDateCn, weekdayCn } from '../components/ui'
import { ChartCard, ColumnChart, LineChart, TipRow } from '../components/charts'
import { addDays, diffDays } from '../lib/date'
import { fmtNum, pct } from '../lib/stats'
import type { RecomputeAudit } from '../model/engine'
import { REVISION_REASONS } from '../model/versions'
import { DATASET } from '../data/dataset'

type RangeKey = '90' | '180' | 'all'
const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '90', label: '近 90 天' },
  { value: '180', label: '近 180 天' },
  { value: 'all', label: '训练窗口' },
]

export function ForecastPage() {
  const {
    sku,
    series,
    cfg,
    setCfg,
    engine,
    backtest,
    diag,
    breakpoints,
    patches,
    applyPatch,
    saveVersion,
    currentVersionId,
    versions,
    treatment,
    cleaning,
    say,
    channel,
  } = useApp()

  const [range, setRange] = useState<RangeKey>('180')
  const [showBand, setShowBand] = useState(true)
  const [showActual, setShowActual] = useState(true)
  const [showImputed, setShowImputed] = useState(true)
  const [saveOpen, setSaveOpen] = useState(false)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [manualDate, setManualDate] = useState('')
  const [manualValue, setManualValue] = useState('')

  const forecast = engine.forecast

  const chartData = useMemo(() => {
    const lastIdx = cfg.end
    const span = range === 'all' ? 365 : Number(range)
    const from = addDays(lastIdx, -span)
    const fromIdx = series.dates.indexOf(from)
    const endIdx = series.dates.indexOf(cfg.end)
    const imputedSet = new Set(forecast.imputations.map((i) => i.date))
    const fittedByDate = new Map(forecast.fitted.map((f) => [f.date, f]))
    const patchedDates = new Map<string, number>()
    for (const p of patches) for (const [d, v] of Object.entries(p.values)) patchedDates.set(d, v)
    const actualPts: { x: number; y: number | null }[] = []
    const imputedPts: { x: number; y: number | null }[] = []
    const historyFitted: { x: number; y: number | null }[] = []
    const backfillPts: { x: number; y: number | null }[] = []
    for (let i = Math.max(0, fromIdx); i <= endIdx; i++) {
      const patchValue = patchedDates.get(series.dates[i])
      const v = patchValue ?? series.actual[i]
      const fit = fittedByDate.get(series.dates[i])
      actualPts.push({ x: i, y: v == null ? null : v })
      if (patchValue != null) backfillPts.push({ x: i, y: patchValue })
      imputedPts.push({ x: i, y: v == null && imputedSet.has(series.dates[i]) ? (fit?.yhat ?? null) : null })
      historyFitted.push({ x: i, y: imputedSet.has(series.dates[i]) ? null : (fit?.yhat ?? null) })
    }
    const predPts = forecast.predictions.map((p, k) => ({ x: endIdx + 1 + k, y: p.yhat }))
    const joinPoint = actualPts[actualPts.length - 1]
    if (joinPoint && joinPoint.y != null && predPts.length) predPts.unshift({ x: endIdx, y: joinPoint.y })
    const upper80 = forecast.predictions.map((p, k) => ({ x: endIdx + 1 + k, y: p.hi80 }))
    const lower80 = forecast.predictions.map((p, k) => ({ x: endIdx + 1 + k, y: p.lo80 }))
    const upper95 = forecast.predictions.map((p, k) => ({ x: endIdx + 1 + k, y: p.hi95 }))
    const lower95 = forecast.predictions.map((p, k) => ({ x: endIdx + 1 + k, y: p.lo95 }))
    const series_ = []
    if (showActual) series_.push({ id: 'actual', label: '实际需求', color: 'var(--ink-2)', points: actualPts, width: 1.4 })
    if (backfillPts.length) series_.push({ id: 'backfill', label: '回补值', color: 'var(--s3)', points: backfillPts, width: 2.4 })
    if (showImputed) series_.push({ id: 'imputed', label: '插补值（缺失）', color: 'var(--s2)', points: imputedPts, dashed: true, width: 1.6 })
    // Fitted and forecast are one entity (the model), so they share a hue; the
    // in-sample half is drawn thinner so the eye lands on the forecast.
    series_.push({ id: 'fitted', label: '模型拟合', color: 'var(--s1)', points: historyFitted, width: 1.1, dashed: false })
    series_.push({ id: 'forecast', label: '预测中位数', color: 'var(--s1)', points: predPts, width: 2.2 })
    const bands = showBand
      ? [
          { id: 'b95', color: 'var(--s1)', upper: upper95, lower: lower95, dashedEdge: true },
          { id: 'b80', color: 'var(--s1)', upper: upper80, lower: lower80, dashedEdge: false },
        ]
      : []
    const xTicks: { x: number; label: string }[] = []
    const startX = Math.max(0, fromIdx)
    const total = endIdx + forecast.predictions.length - startX
    const step = Math.max(1, Math.round(total / 7 / 7) * 7)
    for (let i = startX; i <= endIdx + forecast.predictions.length; i += step) {
      const d = i <= endIdx ? series.dates[i] : addDays(cfg.end, i - endIdx)
      xTicks.push({ x: i, label: d.slice(5).replace('-', '/') })
    }
    const markers = breakpoints
      .map((bp) => ({ bp, x: series.dates.indexOf(bp.date) }))
      .filter(({ x }) => x >= startX && x <= endIdx)
      .slice(0, 2)
      .map(({ bp, x }) => ({
        x,
        label: `断点 ${bp.date.slice(5)}`,
        color: bp.status === 'confirmed' ? 'var(--critical)' : 'var(--muted)',
        kind: 'line' as const,
        width: 1,
      }))
    return { series: series_, bands, xTicks, markers }
  }, [series, cfg, range, forecast, showBand, showActual, showImputed, breakpoints, patches])

  const gapStrip = useMemo(() => {
    const out: { x: number; color: string; label: string }[] = []
    const from = range === 'all' ? 365 : Number(range)
    const startIdx = Math.max(0, series.dates.indexOf(addDays(cfg.end, -from)))
    for (let i = startIdx; i <= series.dates.indexOf(cfg.end); i++) {
      if (series.actual[i] == null) {
        out.push({ x: i, color: 'var(--s2)', label: `${series.dates[i]} 缺失` })
      }
    }
    return out
  }, [series, cfg.end, range])

  const horizonTotal = forecast.predictions.reduce((a, p) => a + p.yhat, 0)
  const horizonPrevWeek = forecast.predictions.slice(0, 7).reduce((a, p) => a + p.yhat, 0)
  const lastWeek = series.actual.slice(series.dates.indexOf(cfg.end) - 6, series.dates.indexOf(cfg.end) + 1).filter((v): v is number => v != null)
  const lastWeekSum = lastWeek.reduce((a, b) => a + b, 0)
  const wow = lastWeekSum ? (horizonPrevWeek - lastWeekSum) / lastWeekSum : 0

  const totalGaps = diag.kindCounts

  const onSave = (reasonCodes: string[], note: string, tag: string) => {
    saveVersion({ reasonCodes, reasonNote: note, tag: tag.trim() || undefined })
    setSaveOpen(false)
  }

  const gapDates = useMemo(() => {
    const patched = new Set(patches.flatMap((p) => p.dates))
    return series.dates.filter((d, i) => d <= cfg.end && series.actual[i] == null && !patched.has(d) && !isBlocked(cfg.blockedSpans, d))
  }, [series, cfg.end, cfg.blockedSpans, patches])

  const openBackfill = () => {
    setManualDate(gapDates[0] ?? '')
    setManualValue('')
    setBackfillOpen(true)
  }

  const submitBackfill = () => {
    if (!manualDate || !manualValue || Number.isNaN(Number(manualValue))) return
    // Backfill every missing day in the same contiguous run so the demo shows a real revision.
    const runDates: string[] = []
    let i = series.dates.indexOf(manualDate)
    if (i < 0) return
    while (i >= 0 && series.actual[i] == null) i--
    i++
    while (i < series.dates.length && series.actual[i] == null && series.dates[i] <= cfg.end) {
      runDates.push(series.dates[i])
      i++
    }
    const values: Record<string, number> = {}
    for (const d of runDates.length ? runDates : [manualDate]) {
      const base = Number(manualValue)
      values[d] = Math.round(base * (0.94 + 0.12 * ((d.charCodeAt(9) % 7) / 7)))
    }
    applyPatch({ dates: Object.keys(values), values, note: `回补 ${runDates.length || 1} 天观测` })
    setBackfillOpen(false)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{sku.name} · 预测工作台</h1>
          <div className="page-desc">
            预测版本保存训练窗口、特征快照与修订原因；补数后只重算受影响时间段的充分统计量，未变化的段落直接复用。
          </div>
        </div>
        <div className="page-meta">
          <div className="meta-block">
            <div className="k">数据截止</div>
            <div className="v">{fmtDateCn(cfg.end)}</div>
          </div>
          <div className="meta-block">
            <div className="k">当前版本</div>
            <div className="v mono">{currentVersionId ?? '未保存'}</div>
          </div>
          <div className="meta-block">
            <div className="k">渠道</div>
            <div className="v">{channel === 'all' ? '全渠道' : channel === 'DTC' ? 'DTC' : '平台'}</div>
          </div>
        </div>
      </div>

      <div className="kpis section">
        <Stat
          label="未来 28 天预测合计"
          value={fmtNum(Math.round(horizonTotal))}
          unit="件"
          delta={<span>{wow >= 0 ? '↑' : '↓'} {pct(Math.abs(wow))} 对比上周实际</span>}
          deltaTone={wow >= 0 ? 'good' : 'bad'}
          foot="中位数轨迹"
        />
        <Stat
          label="80% 预测区间宽度"
          value={fmtNum(Math.round(forecast.predictions.reduce((a, p) => a + (p.hi80 - p.lo80), 0) / Math.max(1, forecast.predictions.length)))}
          unit="件/天"
          foot={`σ = ${fmtNum(Math.round(forecast.sigma))} 件 · 随步长扩张`}
        />
        <Stat
          label="回测 MAPE"
          value={(backtest.mape * 100).toFixed(1)}
          unit="%"
          delta={<span>80% 区间覆盖 {pct(backtest.coverage80)}</span>}
          foot={`${backtest.originCount} 个起点 · 14 天步长`}
        />
        <Stat
          label="缺失率"
          value={`${(diag.overallRate * 100).toFixed(1)}`}
          unit="%"
          delta={
            <span>
              随机 {totalGaps.random} · 连续 {totalGaps.consecutive} · 系统 {totalGaps.systematic}
            </span>
          }
          foot={`${diag.missingCells} / ${diag.totalCells} 个单元格`}
        />
        <Stat
          label="训练窗口"
          value={fmtNum(diffDays(cfg.start, cfg.end) + 1)}
          unit="天"
          delta={<span>{cfg.kind === 'window' ? '断点后重训' : cfg.kind === 'nocov' ? '稳健子模型' : '全量历史'}</span>}
          foot={`${fmtNum(forecast.trainN)} 行有效样本 · ${forecast.imputedDays} 行插补`}
        />
      </div>

      <div className="grid g-2-1 section" style={{ alignItems: 'start' }}>
        <div className="stack">
        <ChartCard
          title="需求与预测区间"
          subtitle={`实际观测、插补、拟合与未来 28 天预测；阴影为 80% / 95% 区间`}
          actions={
            <div className="row" style={{ gap: 10 }}>
              <Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} ariaLabel="时间范围" />
            </div>
          }
          legend={[
            { label: '实际需求', color: 'var(--ink-2)' },
            { label: '模型（拟合 → 预测）', color: 'var(--s1)' },
            { label: '插补值', color: 'var(--s2)', kind: 'dash' },
            ...(patches.length ? [{ label: '回补值', color: 'var(--s3)' }] : []),
            { label: '80% / 95% 区间', color: 'var(--s1)', kind: 'band' },
          ]}
          table={{
            caption: '逐日预测（前 40 行）与区间',
            columns: ['日期', '预测', '80% 下限', '80% 上限', '95% 下限', '95% 上限'],
            rows: forecast.predictions.slice(0, 40).map((p) => [p.date, fmtNum(Math.round(p.yhat)), fmtNum(Math.round(p.lo80)), fmtNum(Math.round(p.hi80)), fmtNum(Math.round(p.lo95)), fmtNum(Math.round(p.hi95))]),
          }}
        >
          <LineChart
            series={chartData.series}
            bands={chartData.bands}
            markers={chartData.markers}
            xTicks={chartData.xTicks}
            xLabel={(x) => {
              const idx = x
              const d = idx <= series.dates.indexOf(cfg.end) ? series.dates[idx] : addDays(cfg.end, idx - series.dates.indexOf(cfg.end))
              return `${d} ${weekdayCn(d)}`
            }}
            formatTipY={(v) => `${fmtNum(Math.round(v))} 件`}
            height={340}
            gapStrip={gapStrip}
            ariaLabel="需求实际、拟合、插补与预测区间折线图"
          />
          <div className="row" style={{ marginTop: 10, gap: 16, fontSize: 11, color: 'var(--muted)' }}>
            <span><span className="swatch" style={{ display: 'inline-block', background: 'var(--s2)', verticalAlign: 'middle', marginRight: 5 }} />底部条带标记缺失日</span>
            <span><span className="swatch" style={{ display: 'inline-block', background: 'var(--critical)', width: 2, height: 10, verticalAlign: 'middle', marginRight: 5 }} />断点</span>
            <span className="spacer" />
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <Switch checked={showBand} onChange={setShowBand} label="显示预测区间" />区间
            </label>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <Switch checked={showImputed} onChange={setShowImputed} label="显示插补值" />插补
            </label>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <Switch checked={showActual} onChange={setShowActual} label="显示实际值" />实际
            </label>
          </div>
        </ChartCard>
        <AuditStrip audit={engine.audit} />
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">当前配置</h3>
                <div className="card-sub">所有参数随版本一并冻结</div>
              </div>
              <div className="card-actions">
                <Badge tone="s1">{currentVersionId ?? '草稿'}</Badge>
              </div>
            </div>
            <div className="card-body">
              <dl className="kv">
                <dt>训练窗口</dt>
                <dd>{cfg.start} → {cfg.end}</dd>
                <dt>窗口长度</dt>
                <dd>{diffDays(cfg.start, cfg.end) + 1} 天</dd>
                <dt>模型规格</dt>
                <dd>{cfg.kind === 'full' ? '全历史 + 协变量' : cfg.kind === 'nocov' ? '全历史 · 剔除协变量' : '断点后短窗口'}</dd>
                <dt>岭正则 λ</dt>
                <dd>{cfg.lambda.toFixed(2)}</dd>
                <dt>季节项</dt>
                <dd>{cfg.seasonality ? '年周期 3 阶傅里叶' : '关闭'}</dd>
                <dt>阻断区间</dt>
                <dd>{cfg.blockedSpans.length ? cfg.blockedSpans.map((s) => `${s.start}→${s.end}`).join('，') : '无'}</dd>
                <dt>需求策略</dt>
                <dd>{labelStrategy(treatment.demand)}</dd>
                <dt>清洗</dt>
                <dd>{cleaning.demand === 'exclude' ? '剔除异常' : cleaning.demand === 'winsorize' ? '缩尾' : '关闭'} · 特征 {cleaning.features === 'fix' ? '修正' : '标记'}</dd>
                <dt>指纹</dt>
                <dd className="mono">{engine.forecast.designHash}</dd>
              </dl>
              <div className="divider" />
              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" onClick={() => setSaveOpen(true)}>保存预测版本</button>
                <button className="btn" onClick={openBackfill}>回补数据</button>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">模型健康度</h3>
                <div className="card-sub">拟合窗口内</div>
              </div>
            </div>
            <div className="card-body">
              <dl className="kv">
                <dt>样本内 MAPE</dt>
                <dd>{(forecast.mapeInSample * 100).toFixed(2)}%</dd>
                <dt>残差 σ</dt>
                <dd>{fmtNum(Math.round(forecast.sigma))} 件</dd>
                <dt>R²</dt>
                <dd>{forecast.diagnostics.r2.toFixed(3)}</dd>
                <dt>残差 lag-1</dt>
                <dd>{forecast.diagnostics.lag1.toFixed(3)}</dd>
                <dt>Durbin–Watson</dt>
                <dd>{forecast.diagnostics.durbinWatson.toFixed(2)}</dd>
                <dt>最大 |z|</dt>
                <dd>{forecast.diagnostics.maxAbsZ.toFixed(1)}</dd>
                <dt>有效样本</dt>
                <dd>{fmtNum(Math.round(forecast.effectiveN))}（加权）</dd>
              </dl>
            </div>
          </section>
        </div>
      </div>

      <div className="grid g2 section">
        <ChartCard
          title="特征贡献"
          subtitle="按系数绝对值归一化；协变量被阻断时不会出现"
          table={{
            columns: ['特征块', '贡献占比'],
            rows: Object.entries(forecast.featureShare).map(([k, v]) => [k, `${(v * 100).toFixed(1)}%`]),
          }}
        >
          <ColumnBars shares={forecast.featureShare} />
        </ChartCard>

        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">修订记录</h3>
              <div className="card-sub">版本保存训练窗口、特征快照与原因</div>
            </div>
            <div className="card-actions">
              <Badge tone="outline">{versions.length} 个版本</Badge>
            </div>
          </div>
          <div className="card-body">
            {versions.slice(-4).reverse().map((v) => (
              <div key={v.id} className="vrow" style={{ gridTemplateColumns: '40px 1fr' }}>
                <div className="vseq">{v.id}</div>
                <div>
                  <div className="vtitle">
                    {v.reasonCodes.map((code) => (
                      <Badge key={code} tone="neutral">{REVISION_REASONS.find((r) => r.code === code)?.label ?? code}</Badge>
                    ))}
                    {v.id === currentVersionId ? <Badge tone="s1">当前</Badge> : null}
                  </div>
                  <div className="vnote">{v.reasonNote}</div>
                  <div className="vmetrics">
                    <span>窗口 <b>{v.window.start.slice(5)} → {v.window.end.slice(5)}</b></span>
                    <span>MAPE <b>{(v.metrics.mape * 100).toFixed(1)}%</b></span>
                    <span>重算 <b>{v.recompute.recomputedDays} 天</b></span>
                  </div>
                </div>
              </div>
            ))}
            {versions.length === 0 ? <div className="empty">尚无保存版本</div> : null}
          </div>
        </section>
      </div>

      {saveOpen ? <SaveVersionModal onClose={() => setSaveOpen(false)} onSave={onSave} /> : null}

      {backfillOpen ? (
        <Modal
          title="回补缺失观测"
          subtitle={`将只重算 ${manualDate ? '该日所在分段的相邻段' : '受影响分段'}，其余分段的充分统计量复用。`}
          onClose={() => setBackfillOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setBackfillOpen(false)}>取消</button>
              <button className="btn primary" onClick={submitBackfill} disabled={!manualDate || !manualValue}>应用回补并重算</button>
            </>
          }
        >
          <div className="form-row">
            <label>目标日期</label>
            <select value={manualDate} onChange={(e) => setManualDate(e.target.value)}>
              {gapDates.map((d) => <option key={d} value={d}>{d} {weekdayCn(d)}</option>)}
            </select>
            <div className="hint">
              选择缺口中的任意一天，会连同同一连续缺口一起回补。
              {gapDates.length === 0 ? '当前窗口已无未回补缺口。' : `剩余 ${gapDates.length} 个可回补日。`}
            </div>
          </div>
          <div className="form-row">
            <label>回补的日均值（件）</label>
            <input type="number" className="input" value={manualValue} onChange={(e) => setManualValue(e.target.value)} placeholder="例如 1320" />
          </div>
          <div className="callout">
            <span className="mark">ℹ️</span>
            <div>
              回补后引擎按 <b>28 天分段</b> 比对哈希：只有包含被改行的分段（以及相邻一天用于插补边界）会被重新累积，然后重解岭回归并刷新预测区间；其余分段沿用缓存的 XᵀX、Xᵀy。
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

function isBlocked(spans: { start: string; end: string }[], date: string): boolean {
  return spans.some((s) => date >= s.start && date <= s.end)
}

function labelStrategy(s: string): string {
  return s === 'impute' ? '插补' : s === 'downweight' ? '降权' : '阻断'
}

function ColumnBars({ shares }: { shares: Record<string, number> }) {
  const entries = Object.entries(shares).sort((a, b) => b[1] - a[1])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 52px', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{k}</span>
          <span style={{ height: 10, background: 'var(--surface-3)', borderRadius: 3, position: 'relative', display: 'block' }}>
            <span style={{ position: 'absolute', inset: 0, width: `${(v * 100).toFixed(1)}%`, background: 'var(--s1)', borderRadius: 3 }} />
          </span>
          <span className="tnum" style={{ textAlign: 'right', fontSize: 11, color: 'var(--ink)' }}>{(v * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

function SaveVersionModal({ onClose, onSave }: { onClose: () => void; onSave: (codes: string[], note: string, tag: string) => void }) {
  const { engine, cfg, breakpoints, patches } = useApp()
  const [codes, setCodes] = useState<string[]>(patches.length ? ['backfill'] : breakpoints.some((b) => b.status === 'confirmed') ? ['breakpoint'] : [])
  const [note, setNote] = useState('')
  const [tag, setTag] = useState('')
  return (
    <Modal
      title="保存预测版本"
      subtitle="版本冻结训练窗口、特征快照、缺失策略与修订原因，可随时回滚。"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => onSave(codes.length ? codes : ['manual'], note || '常规修订', tag)} disabled={codes.length === 0 && !note}>
            保存并设为当前
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>修订原因 <span className="dim">（可多选）</span></label>
        <div className="reason-grid">
          {REVISION_REASONS.map((r) => (
            <button
              key={r.code}
              className={`reason ${codes.includes(r.code) ? 'on' : ''}`}
              onClick={() => setCodes((prev) => (prev.includes(r.code) ? prev.filter((c) => c !== r.code) : [...prev, r.code]))}
            >
              <b>{r.label}</b>
              <span>{r.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>修订说明</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：10 月 12–17 日平台断流已回补，重算后 28 天预测中位数上调 38 件/天" />
        <div className="hint">说明会写入版本血缘，回滚与审计时原样展示。</div>
      </div>
      <div className="form-row">
        <label>标签 <span className="dim">（可选）</span></label>
        <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="例如：双十一预案" />
      </div>
      <div className="callout">
        <span className="mark">🔒</span>
        <div>
          将冻结：训练窗口 <b>{cfg.start} → {cfg.end}</b>、特征快照、策略，
          指纹 <span className="mono">{engine.forecast.designHash}</span>。
        </div>
      </div>
    </Modal>
  )
}

function AuditStrip({ audit }: { audit: RecomputeAudit }) {
  const totalDays = audit.segments.reduce((a, s) => a + s.days, 0)
  return (
    <section className="card" aria-label="增量重算审计">
      <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18 }}>
        <div>
          <div className="stat-label">最近一次重算</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
            {audit.mode === 'incremental' ? '增量' : '全量'} · {audit.recomputedSegments}/{audit.segments.length} 分段 · {audit.recomputedDays} 天
          </div>
        </div>
        <div>
          <div className="stat-label">受影响区间</div>
          <div className="mono" style={{ fontSize: 12, marginTop: 2 }}>
            {audit.recomputedDays < totalDays ? `${audit.affectedStart || '—'} → ${audit.affectedEnd || '—'}` : '整个训练窗口'}
          </div>
        </div>
        <div>
          <div className="stat-label">求解用时</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <b>{audit.elapsedMs.toFixed(1)} ms</b> <span className="dim">/ 全量重解 {audit.fullElapsedMs.toFixed(1)} ms</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="segbar" role="img" aria-label={`训练窗口 ${audit.segments.length} 个分段中 ${audit.recomputedSegments} 个被重算`}>
            {audit.segments.map((s) => (
              <span key={s.index} className={`cell ${s.status === 'recomputed' ? 'hit' : 'miss'}`} style={{ flex: 1 }} title={`${s.start} → ${s.end}：${s.status === 'recomputed' ? '重算' : '复用缓存'}`} />
            ))}
          </div>
          <div className="dim small" style={{ marginTop: 4 }}>
            <span className="swatch" style={{ background: 'var(--s2)', display: 'inline-block', marginRight: 4 }} />重算
            <span className="swatch" style={{ background: 'var(--surface-3)', display: 'inline-block', margin: '0 4px 0 12px' }} />复用缓存 · {audit.reusedDays} 天未重算
          </div>
        </div>
      </div>
    </section>
  )
}
