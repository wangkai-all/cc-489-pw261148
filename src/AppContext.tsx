import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DATASET, SKUS, SKU_BY_ID, buildScope, type Channel, type Scope, type SkuId, type SkuSeries, type SkuMeta } from './data/dataset'
import { diagnose, type DiagnosticsResult } from './model/diagnostics'
import { detectBreakpoints, type Breakpoint } from './model/breakpoints'
import { runBacktest, type BacktestResult } from './model/backtest'
import { defaultConfig, defaultTreatment, type ModelConfig, type TreatmentPlan } from './model/forecast'
import { runForecast, type EngineRun } from './model/engine'
import type { CleaningOptions, FlagDecision } from './model/preprocess'
import { Toast } from './components/ui'
import { buildVersion, makeFeatureSnapshots, nextSeq, seedVersions, type PredictionVersion } from './model/versions'

export type Page = 'forecast' | 'diagnostics' | 'strategy' | 'versions' | 'validation'

export interface PatchRecord {
  id: string
  dates: string[]
  values: Record<string, number>
  createdAt: string
  note: string
}

interface Ctx {
  page: Page
  setPage: (p: Page) => void
  skuId: SkuId
  setSkuId: (s: SkuId) => void
  channel: Scope
  setChannel: (c: Scope) => void
  sku: SkuMeta
  series: SkuSeries
  diag: DiagnosticsResult
  breakpoints: Breakpoint[]
  cfg: ModelConfig
  setCfg: (c: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void
  treatment: TreatmentPlan
  setTreatment: (t: TreatmentPlan | ((prev: TreatmentPlan) => TreatmentPlan)) => void
  cleaning: CleaningOptions
  setCleaning: (c: CleaningOptions) => void
  flags: FlagDecision
  setFlags: (f: FlagDecision | ((prev: FlagDecision) => FlagDecision)) => void
  engine: EngineRun
  backtest: BacktestResult
  patches: PatchRecord[]
  applyPatch: (p: Omit<PatchRecord, 'id' | 'createdAt'>) => void
  versions: PredictionVersion[]
  saveVersion: (args: { reasonCodes: string[]; reasonNote: string; author?: string; tag?: string }) => PredictionVersion
  rollbackTo: (versionId: string) => void
  restoreConfig: (v: PredictionVersion) => void
  currentVersionId: string | null
  toast: string | null
  say: (msg: string) => void
  theme: 'auto' | 'light' | 'dark'
  setTheme: (t: 'auto' | 'light' | 'dark') => void
  dataHash: string
  runCold: () => void
  coldTick: number
}

const AppCtx = createContext<Ctx | null>(null)

const scopeCache = new Map<string, ReturnType<typeof buildScope>>()
function getScope(channel: Scope) {
  const key = channel
  if (!scopeCache.has(key)) scopeCache.set(key, buildScope(channel))
  return scopeCache.get(key)!
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>('forecast')
  const [skuId, setSkuId] = useState<SkuId>('SERUM')
  const [channel, setChannel] = useState<Scope>('all')
  const [cfg, setCfgState] = useState<ModelConfig>(() => ({ ...defaultConfig(), blockedSpans: [{ start: '2026-09-06', end: '2026-09-20' }] }))
  const [treatment, setTreatmentState] = useState<TreatmentPlan>(defaultTreatment)
  const [cleaning, setCleaning] = useState<CleaningOptions>({ demand: 'exclude', features: 'fix' })
  const [flags, setFlagsState] = useState<FlagDecision>({})
  const [patches, setPatches] = useState<PatchRecord[]>([])
  const [versions, setVersions] = useState<Record<string, PredictionVersion[]>>(() => {
    const map: Record<string, PredictionVersion[]> = {}
    for (const sku of SKUS) map[sku.id] = seedVersions(sku.id, '全渠道合计')
    return map
  })
  const [currentVersion, setCurrentVersion] = useState<Record<string, string | null>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [theme, setThemeState] = useState<'auto' | 'light' | 'dark'>(() => (localStorage.getItem('meridian-theme') as 'auto' | 'light' | 'dark') || 'auto')
  const [coldTick, setColdTick] = useState(0)

  const sku = SKU_BY_ID[skuId]
  const series = useMemo(() => getScope(channel).series[skuId], [channel, skuId])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = theme
    localStorage.setItem('meridian-theme', theme)
  }, [theme])

  // Reset per-SKU overrides when switching SKU so we don't carry a patch that
  // belongs to another series.
  const prevSku = useRef(skuId)
  useEffect(() => {
    if (prevSku.current !== skuId) {
      prevSku.current = skuId
      setPatches([])
      setFlagsState({})
    }
  }, [skuId])

  const patchValues = useMemo(() => {
    const out: Record<string, number> = {}
    for (const p of patches) Object.assign(out, p.values)
    return out
  }, [patches])
  const patchDates = useMemo(() => Object.keys(patchValues).sort(), [patchValues])

  const diag = useMemo(() => diagnose(series, cfg.start, cfg.end), [series, cfg.start, cfg.end])

  const cleanedForBreak = useMemo(() => {
    // breakpoints run on the cleaned series so corrected telemetry cannot pose as a break
    const { series: cleaned } = runForecastClean(series, cleaning, flags)
    return cleaned
  }, [series, cleaning, flags])

  const breakpoints = useMemo(() => {
    const excluded = new Set<string>()
    for (const p of patches) for (const d of p.dates) excluded.add(d)
    return detectBreakpoints(cleanedForBreak, { start: cfg.start, end: cfg.end, excluded })
  }, [cleanedForBreak, cfg.start, cfg.end, patches])

  const engine = useMemo(
    () =>
      runForecast({
        sku,
        series,
        datasetEnd: DATASET.horizon,
        cfg,
        treatment,
        cleaning,
        patchDates,
        patchValues,
        flagDecisions: flags,
      }),
    // coldTick forces a cache miss when the user explicitly asks for a full rerun
    [sku, series, cfg, treatment, cleaning, patchDates, patchValues, flags, coldTick],
  )

  const backtest = useMemo(
    () =>
      runBacktest({
        series: engine.cleaned,
        sku,
        cfg,
        treatment,
        originStep: 7,
        horizon: 14,
        trainDays: 210,
      }),
    [engine.cleaned, sku, cfg, treatment],
  )

  const dataHash = useMemo(() => {
    let acc = 0
    for (const v of engine.cleaned.actual) acc = (acc * 31 + (v == null ? 7 : Math.round(v))) % 1_000_000_007
    return acc.toString(16).padStart(8, '0')
  }, [engine.cleaned])

  const setCfg = useCallback((c: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => {
    setCfgState((prev) => (typeof c === 'function' ? c(prev) : c))
  }, [])
  const setTreatment = useCallback((t: TreatmentPlan | ((prev: TreatmentPlan) => TreatmentPlan)) => {
    setTreatmentState((prev) => (typeof t === 'function' ? t(prev) : t))
  }, [])
  const setFlags = useCallback((f: FlagDecision | ((prev: FlagDecision) => FlagDecision)) => {
    setFlagsState((prev) => (typeof f === 'function' ? f(prev) : f))
  }, [])

  const applyPatch = useCallback(
    (p: Omit<PatchRecord, 'id' | 'createdAt'>) => {
      const rec: PatchRecord = { ...p, id: `patch-${Date.now()}`, createdAt: new Date().toISOString() }
      setPatches((prev) => [...prev, rec])
      setToast(`已回补 ${p.dates.length} 天观测，只重算受影响的 ${p.dates.length} 天所在分段。`)
    },
    [],
  )

  const skuVersions = versions[skuId] ?? []

  const saveVersion = useCallback(
    (args: { reasonCodes: string[]; reasonNote: string; author?: string; tag?: string }) => {
      const list = versions[skuId] ?? []
      const seq = nextSeq(list)
      const coverage: Record<string, number> = { demand: diag.demand.rate }
      const kinds: Record<string, string> = { demand: diag.demand.kind }
      for (const c of diag.columns) {
        coverage[c.feature] = c.rate
        kinds[c.feature] = c.kind
      }
      const v = buildVersion({
        seq,
        sku: skuId,
        channel: channel === 'all' ? '全渠道合计' : channel === 'DTC' ? '官网直营 DTC' : '第三方平台',
        cfg,
        treatment,
        features: makeFeatureSnapshots(treatment, coverage, kinds),
        cleaning: { demand: cleaning.demand, features: cleaning.features },
        metrics: {
          mape: backtest.mape,
          coverage80: backtest.coverage80,
          bias: backtest.bias,
          sigma: engine.forecast.sigma,
          trainN: engine.forecast.trainN,
          imputedDays: engine.forecast.imputedDays,
          blockedDays: engine.forecast.blockedDays,
        },
        dataHash,
        reasonCodes: args.reasonCodes,
        reasonNote: args.reasonNote,
        author: args.author,
        createdAt: new Date().toISOString(),
        recompute: {
          mode: patches.length ? 'incremental' : 'full',
          recomputedDays: patches.length ? engine.audit.recomputedDays : engine.audit.segments.reduce((a, s) => a + s.days, 0),
          affectedStart: engine.audit.affectedStart,
          affectedEnd: engine.audit.affectedEnd,
          elapsedMs: Math.max(0.6, engine.audit.elapsedMs),
        },
        tags: args.tag ? [args.tag] : args.reasonCodes.includes('breakpoint') ? ['断点后重训'] : [],
      })
      setVersions((prev) => ({ ...prev, [skuId]: [...(prev[skuId] ?? []), v] }))
      setCurrentVersion((prev) => ({ ...prev, [skuId]: v.id }))
      setToast(`已保存预测版本 <b>${v.id}</b> · 指纹 ${v.fingerprint} · 训练窗口 ${v.window.days} 天`)
      return v
    },
    [versions, skuId, channel, cfg, treatment, cleaning, backtest, engine, dataHash, diag, patches],
  )

  const restoreConfig = useCallback(
    (v: PredictionVersion) => {
      setCfgState({ ...v.config })
      setTreatmentState(JSON.parse(JSON.stringify(v.treatment)))
      setCleaning({ demand: v.cleaning.demand as CleaningOptions['demand'], features: v.cleaning.features as CleaningOptions['features'] })
    },
    [],
  )

  const rollbackTo = useCallback(
    (versionId: string) => {
      const list = versions[skuId] ?? []
      const target = list.find((v) => v.id === versionId)
      if (!target) return
      setCfgState({ ...target.config })
      setTreatmentState(JSON.parse(JSON.stringify(target.treatment)))
      setCleaning({ demand: target.cleaning.demand as CleaningOptions['demand'], features: target.cleaning.features as CleaningOptions['features'] })
      setCurrentVersion((prev) => ({ ...prev, [skuId]: versionId }))
      setToast(`已回滚到 <b>${versionId}</b>：训练窗口 ${target.window.start} → ${target.window.end}，配置与特征快照一并恢复`)
    },
    [versions, skuId],
  )

  const say = useCallback((msg: string) => setToast(msg), [])
  const runCold = useCallback(() => setColdTick((t) => t + 1), [])

  const setTheme = useCallback((t: 'auto' | 'light' | 'dark') => setThemeState(t), [])


  const value: Ctx = {
    page,
    setPage,
    skuId,
    setSkuId,
    channel,
    setChannel,
    sku,
    series,
    diag,
    breakpoints,
    cfg,
    setCfg,
    treatment,
    setTreatment,
    cleaning,
    setCleaning,
    flags,
    setFlags,
    engine,
    backtest,
    patches,
    applyPatch,
    versions: skuVersions,
    saveVersion,
    rollbackTo,
    restoreConfig,
    // Start as a draft: the seeded v14 is a historical snapshot with a shorter
    // window, and showing it as "current" while the workspace holds a different
    // window makes the version diff lie. Saving or rolling back sets this.
    currentVersionId: currentVersion[skuId] ?? null,
    toast,
    say,
    theme,
    setTheme,
    dataHash,
    runCold,
    coldTick,
  }

  return (
    <AppCtx.Provider value={value}>
      {children}
      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </AppCtx.Provider>
  )
}


export function useApp(): Ctx {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

// Local helper avoids importing the whole preprocess module twice in hot paths.
import { cleanSeries } from './model/preprocess'
function runForecastClean(series: SkuSeries, cleaning: CleaningOptions, flags: FlagDecision) {
  return cleanSeries(series, cleaning, flags)
}
