import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { Badge, Modal, fmtDateTime } from '../components/ui'
import { diffDays } from '../lib/date'
import { fmtNum, pct } from '../lib/stats'
import { REVISION_REASONS, type PredictionVersion } from '../model/versions'
import type { ModelConfig, TreatmentPlan } from '../model/forecast'

const REASON_TONE: Record<string, 'good' | 'warn' | 'crit' | 's1' | 's2' | 's3' | 'neutral' | 'outline'> = {
  backfill: 's1',
  outlier: 's3',
  breakpoint: 'crit',
  strategy: 's2',
  model: 'neutral',
  manual: 'warn',
}

export function VersionsPage() {
  const { sku, versions, currentVersionId, rollbackTo, restoreConfig, cfg, treatment, engine, patches, saveVersion, say } = useApp()
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)

  const list = [...versions].sort((a, b) => b.seq - a.seq)
  const current = versions.find((v) => v.id === currentVersionId) ?? null
  // 未选历史版本时，右侧详情默认展示最近一次保存的快照（工作区为草稿时也仍有内容可看）
  const detail = versions.find((v) => v.id === selected) ?? current ?? list[0] ?? null

  const diff = useMemo(() => (detail ? diffVersions(detail, cfg, treatment) : []), [detail, cfg, treatment])

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">预测版本</h1>
          <div className="page-desc">
            每个版本冻结训练窗口、特征快照、缺失策略、清洗口径与修订原因。回滚会恢复当时的窗口与策略，并把版本链重新指向该快照。
          </div>
        </div>
        <div className="page-meta">
          <div className="meta-block">
            <div className="k">当前版本</div>
            <div className="v mono">{currentVersionId ?? '草稿（未保存）'}</div>
          </div>
          <div className="meta-block">
            <div className="k">版本总数</div>
            <div className="v mono">{list.length}</div>
          </div>
          <div className="page-actions" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn primary" onClick={() => setSaveOpen(true)}>保存新版本</button>
          </div>
        </div>
      </div>

      <div className="grid g-2-1 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">版本链</h3>
              <div className="card-sub">{sku.name} · 按时间倒序</div>
            </div>
            <div className="card-actions"><Badge tone="outline">{list.length} 个快照</Badge></div>
          </div>
          <div className="card-body">
            <div className="vlist">
              {list.map((v) => (
                <div
                  key={v.id}
                  className={`vrow ${v.id === currentVersionId ? 'current' : ''} ${v.id === detail?.id ? 'sel' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(v.id)}
                >
                  <div className="vseq">{v.id}</div>
                  <div>
                    <div className="vtitle">
                      {v.reasonCodes.map((code) => (
                        <Badge key={code} tone={REASON_TONE[code] ?? 'neutral'}>
                          {REVISION_REASONS.find((r) => r.code === code)?.label ?? code}
                        </Badge>
                      ))}
                      {v.id === currentVersionId ? <Badge tone="s1">当前</Badge> : null}
                      {v.rolledBackFrom ? <Badge tone="warn">回滚自 {v.rolledBackFrom}</Badge> : null}
                      {v.tags.filter((t) => t !== '当前').map((t) => <Badge key={t} tone="outline">{t}</Badge>)}
                    </div>
                    <div className="vnote">{v.reasonNote}</div>
                    <div className="vmetrics">
                      <span>{v.window.start.slice(5)} → {v.window.end.slice(5)} · <b>{v.window.days} 天</b></span>
                      <span>MAPE <b>{pct(v.metrics.mape)}</b></span>
                      <span>80% 覆盖 <b>{pct(v.metrics.coverage80)}</b></span>
                      <span>指纹 <b className="mono">{v.fingerprint}</b></span>
                    </div>
                    <div className="vmeta">{fmtDateTime(v.createdAt)} · {v.author}</div>
                  </div>
                  <div className="vactions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => { restoreConfig(v); say(`已载入 <b>${v.id}</b> 的配置与特征快照（尚未切换当前版本）`) }}>载入配置</button>
                    <button className="btn sm" onClick={() => setConfirm(v.id)} disabled={v.id === currentVersionId}>回滚</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">快照详情</h3>
                <div className="card-sub">{detail ? `${detail.id} · ${fmtDateTime(detail.createdAt)}` : '—'}</div>
              </div>
              {detail && detail.id === currentVersionId ? <Badge tone="s1">当前</Badge> : detail && !selected && !currentVersionId ? <Badge tone="outline">最近快照</Badge> : <Badge tone="outline">历史</Badge>}
            </div>
            <div className="card-body">
              {detail ? (
                <>
                  <dl className="kv">
                    <dt>训练窗口</dt>
                    <dd>{detail.window.start} → {detail.window.end}</dd>
                    <dt>窗口长度</dt>
                    <dd>{detail.window.days} 天 · {detail.window.kind === 'window' ? '短窗重训' : detail.window.kind === 'nocov' ? '无协变量' : '全量历史'}</dd>
                    <dt>岭正则 λ</dt>
                    <dd>{detail.config.lambda.toFixed(2)}</dd>
                    <dt>季节项 / 促销项</dt>
                    <dd>{detail.config.seasonality ? '开' : '关'} / {detail.config.promotion ? '开' : '关'}</dd>
                    <dt>需求策略</dt>
                    <dd>{labelOf(detail.treatment.demand)}</dd>
                    <dt>清洗</dt>
                    <dd>{detail.cleaning.demand === 'exclude' ? '剔除异常' : detail.cleaning.demand === 'winsorize' ? '缩尾' : '关闭'} · 特征 {detail.cleaning.features === 'fix' ? '修正' : detail.cleaning.features === 'flag' ? '仅标记' : '关闭'}</dd>
                    <dt>回测 MAPE</dt>
                    <dd>{pct(detail.metrics.mape)}</dd>
                    <dt>残差 σ</dt>
                    <dd>{fmtNum(Math.round(detail.metrics.sigma))} 件</dd>
                    <dt>指纹</dt>
                    <dd className="mono">{detail.fingerprint}</dd>
                  </dl>
                  <div className="divider" />
                  <div className="stat-label">特征快照</div>
                  <div className="tbl-wrap" style={{ marginTop: 6 }}>
                    <table className="tbl">
                      <thead><tr><th>特征</th><th>策略</th><th className="num">覆盖率</th><th>机制</th></tr></thead>
                      <tbody>
                        {detail.features.map((f) => (
                          <tr key={f.id}>
                            <td>{f.label}</td>
                            <td>{f.available ? labelOf(f.strategy) : <Badge tone="crit">阻断</Badge>}</td>
                            <td className="num">{pct(f.coverage)}</td>
                            <td className="small">{f.note === 'none' ? '完整' : f.note === 'systematic' ? '系统性' : f.note === 'consecutive' ? '连续' : f.note === 'random' ? '随机' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="empty">尚无版本。</div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">与当前工作区差异</h3>
                <div className="card-sub">{detail ? `${detail.id} → ${currentVersionId ? '当前版本' : '草稿'}` : '—'}</div>
              </div>
            </div>
            <div className="card-body">
              {diff.length === 0 ? (
                <div className="empty">该版本的配置与当前工作区一致。</div>
              ) : (
                <table className="tbl diff-table">
                  <thead><tr><th>项</th><th>版本值</th><th>当前值</th></tr></thead>
                  <tbody>
                    {diff.map((d) => (
                      <tr key={d.key}>
                        <td>{d.key}</td>
                        <td className="diff-from">{d.from}</td>
                        <td className="diff-to">{d.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="grid g2 section">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">重算审计</h3>
              <div className="card-sub">本次运行触达的分段 vs 复用缓存</div>
            </div>
          </div>
          <div className="card-body">
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <div><div className="stat-label">模式</div><div style={{ fontSize: 15, fontWeight: 600 }}>{engine.audit.mode === 'incremental' ? '增量重算' : '全量构建'}</div></div>
              <div><div className="stat-label">重算分段</div><div style={{ fontSize: 15, fontWeight: 600 }}>{engine.audit.recomputedSegments} / {engine.audit.segments.length}</div></div>
              <div><div className="stat-label">重算天数</div><div style={{ fontSize: 15, fontWeight: 600 }}>{engine.audit.recomputedDays} 天</div></div>
              <div><div className="stat-label">用时</div><div style={{ fontSize: 15, fontWeight: 600 }}>{engine.audit.elapsedMs.toFixed(1)} ms <span className="dim small">/ 全量 {engine.audit.fullElapsedMs.toFixed(1)} ms</span></div></div>
            </div>
            <div className="segbar" style={{ marginTop: 12 }} role="img" aria-label="训练窗口分段重算与复用分布">
              {engine.audit.segments.map((s) => (
                <span
                  key={s.index}
                  className={`cell ${s.status === 'recomputed' ? 'hit' : 'miss'}`}
                  style={{ flex: 1 }}
                  title={`段 ${s.index + 1} ${s.start}→${s.end}：${s.status === 'recomputed' ? '已重算' : '复用缓存'}`}
                />
              ))}
            </div>
            <div className="row" style={{ marginTop: 6, gap: 14, fontSize: 10.5, color: 'var(--muted)' }}>
              <span><span className="swatch" style={{ background: 'var(--s2)', display: 'inline-block', marginRight: 5 }} />重算</span>
              <span><span className="swatch" style={{ background: 'var(--surface-3)', display: 'inline-block', marginRight: 5 }} />复用</span>
              <span className="spacer" />
              <span>受影响区间 {engine.audit.affectedStart || '—'} → {engine.audit.affectedEnd || '—'}</span>
            </div>
            <div className="tbl-wrap" style={{ marginTop: 10, maxHeight: 220, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th className="num">#</th><th>区间</th><th className="num">天数</th><th>状态</th></tr></thead>
                <tbody>
                  {engine.audit.segments.map((s) => (
                    <tr key={s.index}>
                      <td className="num">{s.index + 1}</td>
                      <td className="mono small">{s.start} → {s.end}</td>
                      <td className="num">{s.days}</td>
                      <td>{s.status === 'recomputed' ? <Badge tone="s2">重算</Badge> : <Badge tone="neutral">复用</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">数据回补台账</h3>
              <div className="card-sub">补数只重算受影响分段</div>
            </div>
            <div className="card-actions"><Badge tone="outline">{patches.length} 条</Badge></div>
          </div>
          <div className="card-body">
            {patches.length === 0 ? (
              <div className="empty">
                本次会话尚无回补。可在「预测工作台」点「回补数据」，观察只重算包含该日期的分段。
              </div>
            ) : (
              <div className="vlist">
                {[...patches].reverse().map((p) => (
                  <div key={p.id} className="vrow" style={{ gridTemplateColumns: '1fr auto' }}>
                    <div>
                      <div className="vtitle"><Badge tone="s1">回补</Badge>{p.note}</div>
                      <div className="vnote mono small">
                        {p.dates.length} 天 · {p.dates[0]} → {p.dates[p.dates.length - 1]}
                      </div>
                      <div className="vmetrics">
                        <span>日均值 <b>{fmtNum(Math.round(Object.values(p.values).reduce((a, b) => a + b, 0) / p.dates.length))}</b></span>
                        <span>写入 <b>{fmtDateTime(p.createdAt)}</b></span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="callout" style={{ marginTop: 10 }}>
              <span className="mark">🔁</span>
              <div>
                版本保存时记录 <b>重算天数</b> 与 <b>受影响区间</b>；回补后若只重算 2 个分段（56 天），版本血缘会如实写成增量模式，而不是伪装成全量重建。
              </div>
            </div>
          </div>
        </section>
      </div>

      {confirm ? (
        <RollbackModal
          target={versions.find((v) => v.id === confirm)!}
          current={current}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            rollbackTo(confirm)
            setConfirm(null)
            setSelected(confirm)
          }}
        />
      ) : null}

      {saveOpen ? (
        <SaveModal
          onClose={() => setSaveOpen(false)}
          onSave={(codes, note, tag) => {
            saveVersion({ reasonCodes: codes, reasonNote: note, tag })
            setSaveOpen(false)
          }}
          versions={versions}
        />
      ) : null}
    </>
  )
}

function RollbackModal({ target, current, onClose, onConfirm }: { target: PredictionVersion; current: PredictionVersion | null; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title={`回滚到 ${target.id}`}
      subtitle="当前配置与策略会被该快照替换；这是一次可追溯的操作，会写入版本链。"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={onConfirm}>确认回滚</button>
        </>
      }
    >
      <div className="callout" style={{ marginBottom: 10 }}>
        <span className="mark">⚠️</span>
        <div>
          回滚 <b>不会</b> 修改已回补的原始数据；它只恢复训练窗口、模型配置、缺失策略与清洗口径。若回补数据随后被撤销，请另行保存新版本。
        </div>
      </div>
      <table className="tbl diff-table">
        <thead><tr><th>项</th><th>当前 {current?.id ?? '—'}</th><th>回滚目标 {target.id}</th></tr></thead>
        <tbody>
          <tr><td>训练窗口</td><td className="diff-from">{current ? `${current.window.start} → ${current.window.end}` : '—'}</td><td className="diff-to">{target.window.start} → {target.window.end}</td></tr>
          <tr><td>模型类型</td><td className="diff-from">{current?.window.kind ?? '—'}</td><td className="diff-to">{target.window.kind}</td></tr>
          <tr><td>需求策略</td><td className="diff-from">{current ? labelOf(current.treatment.demand) : '—'}</td><td className="diff-to">{labelOf(target.treatment.demand)}</td></tr>
          <tr><td>营销列</td><td className="diff-from">{current ? labelOf(current.treatment.covariates.marketing) : '—'}</td><td className="diff-to">{labelOf(target.treatment.covariates.marketing)}</td></tr>
          <tr><td>回测 MAPE</td><td className="diff-from">{current ? pct(current.metrics.mape) : '—'}</td><td className="diff-to">{pct(target.metrics.mape)}</td></tr>
          <tr><td>修订原因</td><td className="diff-from">{current?.reasonNote ?? '—'}</td><td className="diff-to">{target.reasonNote}</td></tr>
        </tbody>
      </table>
    </Modal>
  )
}

function SaveModal({ onClose, onSave, versions }: { onClose: () => void; onSave: (codes: string[], note: string, tag: string) => void; versions: PredictionVersion[] }) {
  const [codes, setCodes] = useState<string[]>(['backfill'])
  const [note, setNote] = useState('')
  const [tag, setTag] = useState('')
  const last = [...versions].sort((a, b) => b.seq - a.seq)[0]
  return (
    <Modal
      title="保存预测版本"
      subtitle={`将接续 ${last?.id ?? 'v12'}，保存窗口、特征快照与修订原因。`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!codes.length} onClick={() => onSave(codes, note || '常规修订', tag)}>保存</button>
        </>
      }
    >
      <div className="form-row">
        <label>修订原因</label>
        <div className="reason-grid">
          {REVISION_REASONS.map((r) => (
            <button key={r.code} className={`reason ${codes.includes(r.code) ? 'on' : ''}`} onClick={() => setCodes((p) => (p.includes(r.code) ? p.filter((c) => c !== r.code) : [...p, r.code]))}>
              <b>{r.label}</b>
              <span>{r.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>修订说明</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么改、影响了哪段时间、预期效果" />
      </div>
      <div className="form-row">
        <label>标签</label>
        <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="可选，例如：双十一预案" />
      </div>
    </Modal>
  )
}

function labelOf(s: string): string {
  return s === 'impute' ? '插补' : s === 'downweight' ? '降权' : s === 'block' ? '阻断' : s
}

function diffVersions(v: PredictionVersion, cfg: ModelConfig, treatment: TreatmentPlan): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = []
  const push = (key: string, from: string, to: string) => {
    if (from !== to) out.push({ key, from, to })
  }
  push('训练窗口起点', v.window.start, cfg.start)
  push('训练窗口终点', v.window.end, cfg.end)
  push('模型类型', v.window.kind, cfg.kind)
  push('岭正则 λ', v.config.lambda.toFixed(2), cfg.lambda.toFixed(2))
  push('季节项', v.config.seasonality ? '开' : '关', cfg.seasonality ? '开' : '关')
  push('需求策略', labelOf(v.treatment.demand), labelOf(treatment.demand))
  for (const k of ['promo', 'marketing', 'holiday', 'organic'] as const) {
    push(`${k} 策略`, labelOf(v.treatment.covariates[k]), labelOf(treatment.covariates[k]))
  }
  return out
}
