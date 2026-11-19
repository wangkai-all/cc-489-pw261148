import { useApp, type Page } from '../AppContext'
import { CHANNELS, SKUS } from '../data/dataset'
import { fmtDateTime } from './ui'
import { ForecastPage } from '../pages/Forecast'
import { DiagnosticsPage } from '../pages/Diagnostics'
import { StrategyPage } from '../pages/Strategy'
import { VersionsPage } from '../pages/Versions'
import { ValidationPage } from '../pages/Validation'

const NAV: { group: string; items: { id: Page; label: string; hint?: string }[] }[] = [
  {
    group: '预测',
    items: [
      { id: 'forecast', label: '预测工作台' },
      { id: 'diagnostics', label: '缺失诊断' },
      { id: 'strategy', label: '策略与影响' },
    ],
  },
  {
    group: '治理',
    items: [
      { id: 'versions', label: '版本与血缘' },
      { id: 'validation', label: '验证与回滚' },
    ],
  },
]

export function AppShell() {
  const { page, setPage, skuId, setSkuId, channel, setChannel, diag, versions, theme, setTheme, series, cfg } = useApp()

  const coverageBadTone = diag.kindCounts.systematic > 0 ? 'crit' : diag.kindCounts.consecutive > 0 ? 'warn' : 'good'

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">Meridian</div>
            <div className="brand-sub">Demand Forecast</div>
          </div>
        </div>

        <div style={{ padding: '0 12px 8px' }}>
          <select value={skuId} onChange={(e) => setSkuId(e.target.value as typeof skuId)} aria-label="选择 SKU" style={{ width: '100%' }}>
            {SKUS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10.5, color: 'var(--muted)' }}>
            <span className="mono">{SKUS.find((s) => s.id === skuId)?.code}</span>
          </div>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-label">{g.group}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  className={`nav-item ${page === it.id ? 'active' : ''}`}
                  onClick={() => setPage(it.id)}
                  aria-current={page === it.id ? 'page' : undefined}
                >
                  {it.label}
                  {it.id === 'diagnostics' && diag.kindCounts.systematic > 0 ? <span className="dot" title="存在系统性缺失" /> : null}
                  {it.id === 'versions' ? <span className="n">{versions.length}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span className={`badge ${coverageBadTone}`}>
              <span className="swatch" style={{ background: 'currentColor', borderRadius: 99 }} />
              数据完整度 {(100 * (1 - diag.overallRate)).toFixed(1)}%
            </span>
          </div>
          <div>
            截止 <b>{cfg.end}</b> · {series.dates.length} 天
          </div>
          <div>缺失分类：随机 {diag.kindCounts.random} · 连续 {diag.kindCounts.consecutive} · 系统 {diag.kindCounts.systematic}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button key={t} className={`btn ghost sm`} style={{ flex: 1, justifyContent: 'center', background: theme === t ? 'var(--surface-3)' : undefined }} onClick={() => setTheme(t)}>
                {t === 'auto' ? '自动' : t === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>Meridian</span>
            <span>/</span>
            <span>{SKUS.find((s) => s.id === skuId)?.name}</span>
            <span>/</span>
            <b>{NAV.flatMap((g) => g.items).find((i) => i.id === page)?.label}</b>
          </div>
          <div className="top-actions">
            <div className="seg" role="radiogroup" aria-label="渠道范围">
              {CHANNELS.map((c) => (
                <button key={c.id} className={channel === c.id ? 'on' : ''} onClick={() => setChannel(c.id)} role="radio" aria-checked={channel === c.id}>
                  {c.name}
                </button>
              ))}
            </div>
            <span className="pill" title="页面的所有计算都在浏览器本地完成，可复现">
              <span className="mono">本地推理</span>
            </span>
          </div>
        </header>

        <div className="content">
          {page === 'forecast' ? <ForecastPage /> : null}
          {page === 'diagnostics' ? <DiagnosticsPage /> : null}
          {page === 'strategy' ? <StrategyPage /> : null}
          {page === 'versions' ? <VersionsPage /> : null}
          {page === 'validation' ? <ValidationPage /> : null}
        </div>
      </main>
    </div>
  )
}

export { fmtDateTime }
