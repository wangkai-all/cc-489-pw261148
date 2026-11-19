/**
 * Headless smoke render: runs the full model pipeline and every page through
 * react-dom/server. Catches NaN/undefined crashes without a browser.
 */
;(globalThis as any).localStorage = {
  store: new Map<string, string>(),
  getItem(k: string) { return (this.store as Map<string, string>).get(k) ?? null },
  setItem(k: string, v: string) { (this.store as Map<string, string>).set(k, v) },
  removeItem(k: string) { (this.store as Map<string, string>).delete(k) },
}
;(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
if (!(globalThis as any).performance) (globalThis as any).performance = { now: () => Date.now() }

import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AppProvider, useApp } from '../src/AppContext'
import { ForecastPage } from '../src/pages/Forecast'
import { DiagnosticsPage } from '../src/pages/Diagnostics'
import { StrategyPage } from '../src/pages/Strategy'
import { VersionsPage } from '../src/pages/Versions'
import { ValidationPage } from '../src/pages/Validation'
import type { Page } from '../src/AppContext'

const PAGES: { id: Page; el: () => ReactElement; name: string }[] = [
  { id: 'forecast', el: ForecastPage, name: '预测工作台' },
  { id: 'diagnostics', el: DiagnosticsPage, name: '缺失诊断' },
  { id: 'strategy', el: StrategyPage, name: '策略与影响' },
  { id: 'versions', el: VersionsPage, name: '版本与血缘' },
  { id: 'validation', el: ValidationPage, name: '验证与回滚' },
]

function Harness({ page }: { page: Page }) {
  const ctx = useApp()
  if (ctx.page !== page) ctx.setPage(page)
  const Comp = PAGES.find((p) => p.id === page)!.el
  return <Comp />
}

let failures = 0
for (const p of PAGES) {
  const t0 = performance.now()
  try {
    const html = renderToString(
      <AppProvider>
        <Harness page={p.id} />
      </AppProvider>,
    )
    const ms = performance.now() - t0
    const bad = /NaN|undefined|Infinity/.test(html.replace(/<[^>]+>/g, ' '))
    console.log(`${bad ? 'WARN' : 'ok  '} ${p.name.padEnd(8)} ${html.length.toString().padStart(7)} chars  ${ms.toFixed(0)} ms${bad ? '  ← contains NaN/undefined text' : ''}`)
    if (bad) failures++
  } catch (err) {
    failures++
    console.log(`FAIL ${p.name}: ${(err as Error).stack?.split('\n').slice(0, 4).join('\n')}`)
  }
}
;(globalThis as any).process.exitCode = failures ? 1 : 0
