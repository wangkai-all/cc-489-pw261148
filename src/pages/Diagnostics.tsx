import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { Badge, StatusIcon, fmtDateCn } from '../components/ui'
import { ChartCard, ColumnChart, HBars, Heatmap } from '../components/charts'
import { pct } from '../lib/stats'
import { addDays } from '../lib/date'
import type { ColumnDiagnosis, MissingKind } from '../model/diagnostics'
import type { FeatureId } from '../data/dataset'
import type { Strategy } from '../model/forecast'
import { summarizeBreak } from '../model/breakpoints'

const KIND_META: Record<MissingKind, { label: string; short: string; tone: 's1' | 's2' | 'crit'; color: string; detail: string }> = {
  random: { label: '随机缺失', short: 'MCAR', tone: 's1', color: 'var(--s1)', detail: '零散单日、与星期和量级无关，可按局部结构插补。' },
  consecutive: { label: '连续缺失', short: 'MAR', tone: 's2', color: 'var(--s2)', detail: '成片采集中断，缺口内协变量不可得，插补后应降权。' },
  systematic: { label: '系统性缺失', short: '结构性', tone: 'crit', color: 'var(--critical)', detail: '边界固定或延续至截止日，属接口契约缺口，插补会制造伪信号。' },
}

const STRATEGY_LABEL: Record<Strategy, string> = { impute: '插补', downweight: '降权', block: '阻断' }

export function DiagnosticsPage() {
  const { sku, series, cfg, setCfg, diag, treatment, setTreatment, breakpoints, flags, setFlags, engine, say, patches } = useApp()
  const [active, setActive] = useState<string>('demand')

  const columns = useMemo(() => [diag.demand, ...diag.columns], [diag])

  const current = columns.find((c) => c.feature === active) ?? diag.demand

  const heat = useMemo(() => {
    // 7 rows (weekday) × ISO weeks, demand missing rate per weekday-week cell
    const weeks = diag.heat
    const values: number[][] = Array.from({ length: 7 }, () => weeks.map(() => 0))
    const byWeek = new Map(weeks.map((w, i) => [w.weekStart, i]))
    for (let idx = 0; idx < series.dates.length; idx++) {
      const d = series.dates[idx]
      if (d < cfg.start || d > cfg.end) continue
      if (series.actual[idx] != null) continue
      const dt = new Date(`${d}T00:00:00Z`)
      const dow = dt.getUTCDay() === 0 ? 6 : dt.getUTCDay() - 1
      const monday = addDays(d, -dow)
      const wi = byWeek.get(monday)
      if (wi == null) continue
      values[dow][wi] += 1
    }
    return { rows: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], columns: weeks.map((w) => ({ key: w.weekStart, label: w.weekStart.slice(5) })), values }
  }, [diag.heat, series, cfg.start, cfg.end])

  const retrainFrom = (date: string) => {
    setCfg((prev) => ({ ...prev, kind: 'window', start: date }))
    say(`训练窗口起点顺延到断点 <b>${date}</b>，模型按新体制重训`)
  }

  const setStrategy = (feature: FeatureId | 'demand', s: Strategy) => {
    setTreatment((prev) =>
      feature === 'demand' ? { ...prev, demand: s } : { ...prev, covariates: { ...prev.covariates, [feature]: s } },
    )
    say(`<b>${feature === 'demand' ? '需求量' : diag.columns.find((c) => c.feature === feature)?.label}</b> 策略 → ${STRATEGY_LABEL[s]}，模型已重算`)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">缺失诊断</h1>
          <div className="page-desc">
            {sku.name} · {cfg.start} → {cfg.end}。按列识别缺失机制，用游程检验、星期独立性 χ² 与缺失—需求相关性取证，再为每列选择插补 / 降权 / 阻断。
          </div>
        </div>
        <div className="page-meta">
          <div className="meta-block">
            <div className="k">缺失单元格</div>
            <div className="v mono">{diag.missingCells} / {diag.totalCells}</div>
          </div>
          <div className="meta-block">
            <div className="k">整体缺失率</div>
            <div className="v mono">{pct(diag.overallRate)}</div>
          </div>
        </div>
      </div>

      <div className="kpis section">
        <div className="kpi">
          <div className="k">随机缺失</div>
          <div className="v">{diag.kindCounts.random}<small>段</small></div>
          <div className="d"><Badge tone="s1">MCAR</Badge> 单日缺口，插补</div>
        </div>
        <div className="kpi">
          <div className="k">连续缺失</div>
          <div className="v">{diag.kindCounts.consecutive}<small>段</small></div>
          <div className="d"><Badge tone="s2">MAR</Badge> 成片缺口，降权</div>
        </div>
        <div className="kpi">
          <div className="k">系统性缺失</div>
          <div className="v">{diag.kindCounts.systematic}<small>段</small></div>
          <div className="d"><Badge tone="crit">结构性</Badge> 阻断整列</div>
        </div>
        <div className="kpi">
          <div className="k">需求缺口</div>
          <div className="v">{diag.demand.missing}<small>天</small></div>
          <div className="d">最长 {diag.demand.longest?.length ?? 0} 天 · {diag.demand.longest ? KIND_META[diag.demand.longest.kind].short : '—'}</div>
        </div>
        <div className="kpi">
          <div className="k">不可观测列</div>
          <div className="v">{diag.systematicColumns}<small>列</small></div>
          <div className="d">{diag.systematicColumns ? '已在推荐策略中阻断' : '所有列可用'}</div>
        </div>
      </div>

      <ChartCard
        title="缺失分布 · 日历热力"
        subtitle="行 = 星期，列 = ISO 周；颜色越深代表当周缺失天数越多"
        table={{
          caption: '按周汇总的需求缺失天数',
          columns: ['周起始', '缺失天数', '统计天数'],
          rows: diag.heat.map((w) => [w.weekStart, w.count, w.total]),
        }}
        actions={<span className="dim small">需求列</span>}
      >
        <Heatmap
          rows={heat.rows}
          columns={heat.columns}
          values={heat.values}
          ariaLabel="需求缺失按星期与周的日历热力图"
          formatCell={(v, row, col) => `${col} 当周 ${row}：缺失 ${v} 天`}
          legendLabel="缺失天数"
          cellHeight={15}
        />
      </ChartCard>

      <div className="grid g2 section">
        <ChartCard
          title="缺失游程长度 × 机制"
          subtitle="按连续缺失天数分箱；长游程更可能是采集中断而非偶然丢点"
          legend={[
            { label: '随机', color: 'var(--s1)', kind: 'rect' },
            { label: '连续', color: 'var(--s2)', kind: 'rect' },
            { label: '系统性', color: 'var(--critical)', kind: 'rect' },
          ]}
          table={{
            caption: '游程长度 × 机制的段数',
            columns: ['游程长度', '随机', '连续', '系统性'],
            rows: diag.runBins.map((b) => [b.label, b.random, b.consecutive, b.systematic]),
          }}
        >
          <ColumnChart
            categories={diag.runBins.map((b) => b.label)}
            series={[
              { id: 'random', label: '随机', color: 'var(--s1)', values: diag.runBins.map((b) => b.random) },
              { id: 'consecutive', label: '连续', color: 'var(--s2)', values: diag.runBins.map((b) => b.consecutive) },
              { id: 'systematic', label: '系统性', color: 'var(--critical)', values: diag.runBins.map((b) => b.systematic) },
            ]}
            stacked
            height={214}
            unit=" 段"
            ariaLabel="缺失游程长度按机制分组的堆叠柱状图"
          />
        </ChartCard>
        <ChartCard
          title="星期缺失率"
          subtitle="χ²(6) 检验缺失是否与星期有关；差异大意味着非随机"
          table={{
            columns: ['星期', '缺失率', '缺失天数'],
            rows: diag.weekday.map((w) => [`周${w.label}`, pct(w.rate), w.count]),
          }}
        >
          <HBars
            items={diag.weekday.map((w) => ({ label: `周${w.label}`, value: w.rate }))}
            formatValue={(v) => pct(v)}
            color="var(--s1)"
            max={Math.max(0.01, ...diag.weekday.map((w) => w.rate)) * 1.1}
            ariaLabel="按星期的需求缺失率水平条形图"
          />
        </ChartCard>
      </div>

      <ChartCard
        className="section"
        title="各列缺失概况"
            subtitle="% 为窗口内缺失率；右侧徽标为机制判定"
            table={{
              columns: ['列', '缺失天数', '缺失率', '最长游程', '机制', '当前策略'],
              rows: columns.map((c) => [c.label, c.missing, pct(c.rate), c.longest?.length ?? 0, c.kind === 'none' ? '无缺失' : KIND_META[c.kind].label, STRATEGY_LABEL[strategyOf(c, treatment)]]),
            }}
        >
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>列</th>
                    <th className="num">缺失</th>
                    <th className="num">缺失率</th>
                    <th className="num">最长游程</th>
                    <th>机制</th>
                    <th>策略</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.feature} onClick={() => setActive(c.feature)} style={{ cursor: 'pointer' }} className={active === c.feature ? 'sel' : ''}>
                      <td>
                        <b>{c.label}</b>
                        <span className="dim small"> · {c.subtitle}</span>
                      </td>
                      <td className="num">{c.missing}</td>
                      <td className="num">{c.missing ? pct(c.rate) : '—'}</td>
                      <td className="num">{c.longest?.length ?? 0}</td>
                      <td>{c.kind === 'none' ? <Badge tone="good">完整</Badge> : <Badge tone={KIND_META[c.kind].tone}>{KIND_META[c.kind].label}</Badge>}</td>
                      <td>{STRATEGY_LABEL[strategyOf(c, treatment)]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
      </ChartCard>

      <section className="card section">
        <div className="card-head">
          <div>
            <h3 className="card-title">逐列诊断与策略</h3>
            <div className="card-sub">证据 → 机制判定 → 推荐策略。修改后立即重解模型。</div>
          </div>
          <div className="card-actions">
            <div className="seg" role="tablist" aria-label="选择列">
              {columns.map((c) => (
                <button key={c.feature} role="tab" aria-selected={active === c.feature} className={active === c.feature ? 'on' : ''} onClick={() => setActive(c.feature)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="grid g-1-2" style={{ alignItems: 'start' }}>
            <div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 14 }}>{current.label}</h4>
                  <div className="dim small">{current.subtitle} · {current.total} 天窗口</div>
                </div>
                {current.kind === 'none' ? <Badge tone="good">完整覆盖</Badge> : <Badge tone={KIND_META[current.kind].tone}>{KIND_META[current.kind].label}</Badge>}
              </div>
              <div className="callout" style={{ marginTop: 10 }}>
                <span className="mark">{current.kind === 'none' ? '✓' : current.kind === 'systematic' ? '⛔' : current.kind === 'consecutive' ? '⏸' : '≈'}</span>
                <div>{current.rationale}</div>
              </div>
              <dl className="kv" style={{ marginTop: 10 }}>
                <dt>缺失 / 窗口</dt>
                <dd>{current.missing} / {current.total} 天（{pct(current.rate)}）</dd>
                <dt>游程数量</dt>
                <dd>{current.runs.length} 段</dd>
                <dt>最长游程</dt>
                <dd>{current.longest ? `${current.longest.start} → ${current.longest.end}（${current.longest.length} 天${current.longest.openEnded ? ' · 未闭合' : ''}）` : '无'}</dd>
                <dt>判定置信度</dt>
                <dd>{pct(current.confidence)}</dd>
                <dt>模型内录入</dt>
                <dd>
                  {current.feature === 'demand'
                    ? `${engine.forecast.imputedDays} 天插补 · ${engine.forecast.blockedDays} 天阻断`
                    : treatment.covariates[current.feature as FeatureId] === 'block'
                      ? '整列阻断（不参与回归）'
                      : `${STRATEGY_LABEL[treatment.covariates[current.feature as FeatureId]]} 可用`}
                </dd>
              </dl>
              <div className="divider" />
              <div className="seg" role="radiogroup" aria-label={`${current.label} 缺失策略`} style={{ width: '100%' }}>
                {(['impute', 'downweight', 'block'] as Strategy[]).map((s) => (
                  <button
                    key={s}
                    role="radio"
                    aria-checked={strategyOf(current, treatment) === s}
                    className={strategyOf(current, treatment) === s ? 'on' : ''}
                    onClick={() => setStrategy(current.feature, s)}
                  >
                    {STRATEGY_LABEL[s]}
                    {s === current.recommended ? <span className="reco" title="推荐">推荐</span> : null}
                  </button>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {current.recommended === strategyOf(current, treatment) ? '当前策略与诊断推荐一致。' : `诊断推荐 ${STRATEGY_LABEL[current.recommended]}；偏离推荐会改变区间宽度与偏差，请到「策略对比」复核。`}
              </div>
            </div>

            <div>
              <div className="stat-label">证据</div>
              <div className="tbl-wrap" style={{ marginTop: 6 }}>
                <table className="tbl">
                  <thead>
                    <tr><th>检验 / 证据</th><th className="num">取值</th><th>方向</th></tr>
                  </thead>
                  <tbody>
                    {current.evidence.map((e) => (
                      <tr key={e.label}>
                        <td>{e.label}</td>
                        <td className="num mono">{e.value}</td>
                        <td>
                          <span className="row" style={{ gap: 5 }}>
                            <StatusIcon status={e.verdict === 'supports' ? 'pass' : e.verdict === 'against' ? 'fail' : 'info'} />
                            {e.verdict === 'supports' ? '支持随机' : e.verdict === 'against' ? '拒绝随机' : '中性'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="stat-label" style={{ marginTop: 12 }}>本列游程</div>
              <div className="tbl-wrap" style={{ marginTop: 6, maxHeight: 190, overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr><th>区间</th><th className="num">天数</th><th>机制</th></tr>
                  </thead>
                  <tbody>
                    {current.runs.length === 0 ? (
                      <tr><td colSpan={3} className="dim">无缺失</td></tr>
                    ) : (
                      current.runs.map((r, i) => (
                        <tr key={i}>
                          <td className="mono small">{r.start} → {r.end}{r.openEnded ? ' ⏳' : ''}</td>
                          <td className="num">{r.length}</td>
                          <td><Badge tone={KIND_META[r.kind].tone}>{KIND_META[r.kind].label}</Badge></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid g2 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">断点验证</h3>
              <div className="card-sub">局部中断时间序列 · 前 6 周平稳 + 断点后持续</div>
            </div>
            <div className="card-actions"><Badge tone="outline">{breakpoints.length} 个候选</Badge></div>
          </div>
          <div className="card-body">
            {breakpoints.length === 0 ? (
              <div className="empty">窗口内未检出显著水平位移。断点检测要求 ≥7% 阶跃、z≥3.6，且断点后 3 周仍在新区间。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {breakpoints.map((bp) => (
                  <div key={bp.date} className="vrow" style={{ gridTemplateColumns: '1fr' }}>
                    <div>
                      <div className="vtitle">
                        <StatusIcon status={bp.status === 'confirmed' ? 'pass' : 'warn'} />
                        <b>{fmtDateCn(bp.date)}</b>
                        <Badge tone={bp.status === 'confirmed' ? 'crit' : 'neutral'}>{bp.status === 'confirmed' ? '结构断点' : '短期波动'}</Badge>
                        <span className="dim small">z = {bp.z.toFixed(1)}</span>
                      </div>
                      <div className="vnote">{summarizeBreak(bp)}。断点前 {Math.round(bp.before)} 件/天 → 断点后 {Math.round(bp.after)} 件/天。</div>
                      <div className="vmetrics">
                        <span>前段样本 <b>{bp.beforeN}</b></span>
                        <span>后段样本 <b>{bp.afterN}</b></span>
                        <span>{bp.persistent ? '后段稳定在新区间' : '阶跃衰减'}</span>
                      </div>
                      {bp.status === 'confirmed' && cfg.start <= bp.date ? (
                        <div className="row" style={{ marginTop: 8 }}>
                          <button className="btn sm" onClick={() => retrainFrom(bp.date)}>
                            断点后重训（窗口起点 {bp.date}）
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="callout" style={{ marginTop: 10 }}>
              <span className="mark">🧭</span>
              <div>
                断点若被确认为结构变化，可把训练窗口起点顺延到断点日；旧的季节项与水平不会污染新体制的估计。当前起点 <b>{cfg.start}</b>。
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">异常值复核</h3>
              <div className="card-sub">因果检测：只用当日之前 28 天建立水平</div>
            </div>
            <div className="card-actions"><Badge tone="outline">{flags ? Object.keys(flags).length : 0} 项人工决定</Badge></div>
          </div>
          <div className="card-body">
            {engine.quality.length === 0 ? (
              <div className="empty">未检出需要处理的异常值。</div>
            ) : (
              <div className="tbl-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr><th>日期</th><th>字段</th><th className="num">观测</th><th className="num">期望</th><th>处理</th><th aria-label="人工决定" /></tr>
                  </thead>
                  <tbody>
                    {engine.quality.map((q) => {
                      const key = `${q.date}:${q.field}`
                      const decision = flags[key] ?? 'apply'
                      return (
                        <tr key={key}>
                          <td className="mono small">{q.date}</td>
                          <td>{q.field === 'demand' ? '需求' : q.field === 'marketing' ? '营销' : q.field === 'promo' ? '促销' : '节假日'}</td>
                          <td className="num">{Math.round(q.observed)}</td>
                          <td className="num">{Math.round(q.expected)}</td>
                          <td>
                            <Badge tone={decision === 'keep' ? 'warn' : 'neutral'}>
                              {decision === 'keep' ? '保留原值' : q.action === 'excluded' ? '剔除' : q.action === 'winsorized' ? '缩尾' : q.action === 'imputed' ? '修正' : '标记'}
                            </Badge>
                          </td>
                          <td>
                            <div className="seg" role="radiogroup" aria-label={`${q.date} ${q.field} 处理决定`}>
                              <button role="radio" aria-checked={decision === 'apply'} className={decision === 'apply' ? 'on' : ''} onClick={() => setFlags((p) => ({ ...p, [key]: 'apply' }))}>修正</button>
                              <button role="radio" aria-checked={decision === 'keep'} className={decision === 'keep' ? 'on' : ''} onClick={() => setFlags((p) => ({ ...p, [key]: 'keep' }))}>保留</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="hint" style={{ marginTop: 8 }}>
              标记后决定立即写入模型：被修正的行不参与回归，「保留」的行会以其原始量级进入拟合（适合真实促销尖峰）。{patches.length ? ` 已有 ${patches.length} 条回补记录。` : ''}
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

function strategyOf(c: ColumnDiagnosis, t: ReturnType<typeof useApp>['treatment']): Strategy {
  return c.feature === 'demand' ? t.demand : (t.covariates[c.feature as FeatureId] ?? 'impute')
}
