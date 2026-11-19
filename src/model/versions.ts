import { addDays, diffDays } from '../lib/date'
import type { SkuId } from '../data/dataset'
import type { ModelConfig, Strategy, TreatmentPlan } from './forecast'
import { defaultConfig, defaultTreatment, hashString } from './forecast'

export interface RevisionReason {
  code: string
  label: string
  detail: string
}

export const REVISION_REASONS: RevisionReason[] = [
  { code: 'backfill', label: '数据回补', detail: '上游补数后重新预测受影响时段' },
  { code: 'outlier', label: '异常值修正', detail: '剔除或缩尾后重算' },
  { code: 'breakpoint', label: '断点处理', detail: '训练窗口顺延或排除断点区间' },
  { code: 'strategy', label: '策略调整', detail: '缺失处理策略变化' },
  { code: 'model', label: '模型配置', detail: '正则化 / 季节项 / 协变量变化' },
  { code: 'manual', label: '人工修订', detail: '业务方手动覆盖预测' },
]

export interface FeatureSnapshot {
  id: string
  label: string
  available: boolean
  coverage: number
  strategy: Strategy
  note: string
}

export interface PredictionVersion {
  id: string
  seq: number
  label: string
  createdAt: string
  author: string
  sku: SkuId
  channel: string
  reasonCodes: string[]
  reasonNote: string
  window: { start: string; end: string; days: number; kind: string }
  config: ModelConfig
  treatment: TreatmentPlan
  features: FeatureSnapshot[]
  cleaning: { demand: string; features: string }
  metrics: {
    mape: number
    coverage80: number
    bias: number
    sigma: number
    trainN: number
    imputedDays: number
    blockedDays: number
  }
  /** Fingerprint of the exact input data + config used. */
  fingerprint: string
  /** Segments recomputed when this version was produced. */
  recompute: { mode: 'full' | 'incremental'; recomputedDays: number; affectedStart: string; affectedEnd: string; elapsedMs: number }
  rolledBackFrom?: string
  tags: string[]
}

const AUTHORS = ['林澈（需求计划）', '周遥（数据科学）', '陈可（供应链）', '系统调度']

export function makeFeatureSnapshots(treatment: TreatmentPlan, coverage: Record<string, number>, kind: Record<string, string>): FeatureSnapshot[] {
  return [
    { id: 'demand', label: '需求量', available: true, coverage: 1 - (coverage.demand ?? 0), strategy: treatment.demand, note: kind.demand ?? '' },
    { id: 'promo', label: '促销折扣', available: treatment.covariates.promo !== 'block', coverage: 1 - (coverage.promo ?? 0), strategy: treatment.covariates.promo, note: kind.promo ?? '' },
    { id: 'marketing', label: '营销投放', available: treatment.covariates.marketing !== 'block', coverage: 1 - (coverage.marketing ?? 0), strategy: treatment.covariates.marketing, note: kind.marketing ?? '' },
    { id: 'holiday', label: '节假日效应', available: treatment.covariates.holiday !== 'block', coverage: 1 - (coverage.holiday ?? 0), strategy: treatment.covariates.holiday, note: kind.holiday ?? '' },
    { id: 'organic', label: '自然流量', available: treatment.covariates.organic !== 'block', coverage: 1 - (coverage.organic ?? 0), strategy: treatment.covariates.organic, note: kind.organic ?? '' },
  ]
}

export function fingerprint(cfg: ModelConfig, treatment: TreatmentPlan, windowEnd: string, dataHash: string): string {
  return hashString(JSON.stringify([cfg, treatment, windowEnd, dataHash]))
}

interface BuildVersionArgs {
  seq: number
  sku: SkuId
  channel: string
  cfg: ModelConfig
  treatment: TreatmentPlan
  features: FeatureSnapshot[]
  cleaning: { demand: string; features: string }
  metrics: PredictionVersion['metrics']
  dataHash: string
  reasonCodes: string[]
  reasonNote: string
  author?: string
  createdAt: string
  recompute: PredictionVersion['recompute']
  tags?: string[]
}

export function buildVersion(a: BuildVersionArgs): PredictionVersion {
  const seq = a.seq
  return {
    id: `v${seq}`,
    seq,
    label: `v${seq}`,
    createdAt: a.createdAt,
    author: a.author ?? AUTHORS[seq % AUTHORS.length],
    sku: a.sku,
    channel: a.channel,
    reasonCodes: a.reasonCodes,
    reasonNote: a.reasonNote,
    window: {
      start: a.cfg.start,
      end: a.cfg.end,
      days: diffDays(a.cfg.start, a.cfg.end) + 1,
      kind: a.cfg.kind,
    },
    config: { ...a.cfg },
    treatment: JSON.parse(JSON.stringify(a.treatment)),
    features: a.features,
    cleaning: a.cleaning,
    metrics: a.metrics,
    fingerprint: fingerprint(a.cfg, a.treatment, a.cfg.end, a.dataHash),
    recompute: a.recompute,
    tags: a.tags ?? [],
  }
}

/** The committed baseline versions the console ships with (so rollback has a target). */
export function seedVersions(sku: SkuId, channel: string): PredictionVersion[] {
  const cfgFull = defaultConfig()
  const cfgWin: ModelConfig = { ...cfgFull, kind: 'window', start: '2026-09-21', end: '2026-11-15' }
  const t95 = defaultTreatment()

  const v12: PredictionVersion = buildVersion({
    seq: 12,
    sku,
    channel,
    cfg: cfgFull,
    treatment: t95,
    features: makeFeatureSnapshots(t95, { demand: 0.062, promo: 0.03, marketing: 0.0, holiday: 0.0, organic: 0.0 }, { demand: 'consecutive', promo: 'random', marketing: 'systematic', holiday: 'none', organic: 'none' }),
    cleaning: { demand: 'exclude', features: 'fix' },
    metrics: { mape: 0.087, coverage80: 0.86, bias: 4.1, sigma: 62, trainN: 452, imputedDays: 21, blockedDays: 34 },
    dataHash: 'seed-aug',
    reasonCodes: ['model'],
    reasonNote: '引入岭回归收缩，替换季节分解外推',
    createdAt: '2026-09-30T09:12:00Z',
    recompute: { mode: 'full', recomputedDays: 533, affectedStart: '2025-06-01', affectedEnd: '2026-11-15', elapsedMs: 182 },
    tags: ['已归档'],
  })

  const v13: PredictionVersion = buildVersion({
    seq: 13,
    sku,
    channel,
    cfg: cfgFull,
    treatment: t95,
    features: makeFeatureSnapshots(t95, { demand: 0.062, promo: 0.03, marketing: 0.0, holiday: 0.0, organic: 0.0 }, { demand: 'consecutive', promo: 'random', marketing: 'systematic', holiday: 'none', organic: 'none' }),
    cleaning: { demand: 'exclude', features: 'fix' },
    metrics: { mape: 0.083, coverage80: 0.84, bias: 2.6, sigma: 59, trainN: 456, imputedDays: 24, blockedDays: 29 },
    dataHash: 'seed-oct',
    reasonCodes: ['backfill'],
    reasonNote: '回补 9 月 6–20 日缺口后重算全部窗口',
    createdAt: '2026-10-16T14:40:00Z',
    recompute: { mode: 'full', recomputedDays: 533, affectedStart: '2025-06-01', affectedEnd: '2026-11-15', elapsedMs: 168 },
    tags: ['已发布'],
  })

  const v14: PredictionVersion = buildVersion({
    seq: 14,
    sku,
    channel,
    cfg: cfgWin,
    treatment: t95,
    features: makeFeatureSnapshots(t95, { demand: 0.041, promo: 0.0, marketing: 0.0, holiday: 0.0, organic: 0.0 }, { demand: 'none', promo: 'none', marketing: 'systematic', holiday: 'none', organic: 'none' }),
    cleaning: { demand: 'exclude', features: 'fix' },
    metrics: { mape: 0.071, coverage80: 0.79, bias: -1.2, sigma: 51, trainN: 56, imputedDays: 0, blockedDays: 0 },
    dataHash: 'seed-nov',
    reasonCodes: ['breakpoint'],
    reasonNote: '断点后重训：9/21 起窗口，剔除结构性缺失协变量',
    createdAt: '2026-11-04T11:05:00Z',
    recompute: { mode: 'full', recomputedDays: 56, affectedStart: '2026-09-21', affectedEnd: '2026-11-15', elapsedMs: 24 },
    tags: ['当前'],
  })

  return [v12, v13, v14]
}

export function nextSeq(versions: PredictionVersion[]): number {
  return Math.max(12, ...versions.map((v) => v.seq)) + 1
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function versionTimestamp(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export { addDays }
