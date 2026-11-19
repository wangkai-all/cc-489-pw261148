import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtCompact, fmtNum } from '../lib/stats'
import { fmtShort } from '../lib/date'

/* ------------------------------------------------------------------ */
/* measuring & scales                                                  */
/* ------------------------------------------------------------------ */

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && Math.abs(w - width) > 1) setWidth(w)
    })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { ref, width }
}

export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi === lo) {
    const pad = Math.abs(lo) * 0.1 || 1
    lo -= pad
    hi += pad
  }
  const span = hi - lo
  const step0 = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const norm = step0 / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const start = Math.ceil(lo / step) * step
  const ticks: number[] = []
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

export function fmtTick(v: number): string {
  if (Math.abs(v) >= 10000) return fmtCompact(v)
  if (Math.abs(v) >= 1000) return fmtNum(v)
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(2)))
}

function pathFrom(points: { x: number; y: number }[]): string {
  if (!points.length) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
}

function segmentsOf<T>(arr: T[], isNull: (v: T) => boolean): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  for (const v of arr) {
    if (isNull(v)) {
      if (cur.length) out.push(cur)
      cur = []
    } else cur.push(v)
  }
  if (cur.length) out.push(cur)
  return out
}

/* ------------------------------------------------------------------ */
/* tooltip                                                             */
/* ------------------------------------------------------------------ */

interface TipState {
  x: number
  y: number
  content: React.ReactNode
}

function Tooltip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null
  const flip = tip.x > width - 190
  return (
    <div
      className="tip"
      style={{
        left: flip ? undefined : tip.x + 12,
        right: flip ? width - tip.x + 12 : undefined,
        top: Math.max(4, tip.y - 20),
      }}
      role="status"
    >
      {tip.content}
    </div>
  )
}

export function TipRow({ color, label, value, dash }: { color?: string; label: string; value: string; dash?: boolean }) {
  return (
    <div className="tip-row">
      <span className="tk">
        <span
          className="swatch"
          style={{ background: dash ? 'transparent' : color, borderTop: dash ? `2px dotted ${color}` : undefined, height: dash ? 0 : 8, width: dash ? 12 : 8 }}
        />
        {label}
      </span>
      <span className="tv">{value}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* legend                                                              */
/* ------------------------------------------------------------------ */

export interface LegendItem {
  label: string
  color: string
  kind?: 'line' | 'rect' | 'dash' | 'band'
  note?: string
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="legend" aria-label="图例">
      {items.map((it) => (
        <span className="item" key={it.label}>
          <span
            className="glyph"
            aria-hidden
            style={
              it.kind === 'rect'
                ? { background: it.color, height: 8, width: 10, borderRadius: 2, display: 'inline-block' }
                : it.kind === 'band'
                  ? { background: it.color, height: 8, width: 14, borderRadius: 2, opacity: 0.45, display: 'inline-block' }
                  : it.kind === 'dash'
                    ? { borderTop: `2px dotted ${it.color}`, height: 0, width: 14, display: 'inline-block' }
                    : { borderTop: `2px solid ${it.color}`, height: 0, width: 14, display: 'inline-block' }
            }
          />
          <b style={{ fontWeight: 500 }}>{it.label}</b>
          {it.note ? <span className="dim">{it.note}</span> : null}
        </span>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* chart card                                                          */
/* ------------------------------------------------------------------ */

export function ChartCard({
  title,
  subtitle,
  legend,
  actions,
  table,
  children,
  className,
}: {
  title: string
  subtitle?: string
  legend?: LegendItem[]
  actions?: React.ReactNode
  table?: { columns: string[]; rows: (string | number)[][]; caption?: string }
  children: React.ReactNode
  className?: string
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className={`card ${className ?? ''}`}>
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="card-title">{title}</h3>
          {subtitle ? <div className="card-sub">{subtitle}</div> : null}
        </div>
        <div className="card-actions">
          {actions}
          {table ? (
            <button className="btn ghost sm" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
              {showTable ? '图表' : '表格'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="card-body">
        {legend && legend.length > 1 ? <div style={{ marginBottom: 8 }}><Legend items={legend} /></div> : null}
        {showTable && table ? (
          <div className="tbl-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="tbl">
              <caption className="tbl-caption" style={{ textAlign: 'left', paddingBottom: 6 }}>{table.caption}</caption>
              <thead>
                <tr>{table.columns.map((c, i) => <th key={c} className={i === 0 ? '' : 'num'}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? '' : 'num'}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* line chart                                                          */
/* ------------------------------------------------------------------ */

export interface LinePoint {
  x: number
  y: number | null
}
export interface LineSeries {
  id: string
  label: string
  color: string
  points: LinePoint[]
  dashed?: boolean
  width?: number
  fill?: boolean
}
export interface BandSeries {
  id: string
  color: string
  /** upper/lower points keyed by the same x. */
  upper: LinePoint[]
  lower: LinePoint[]
  opacity?: number
  dashedEdge?: boolean
  label?: string
}
export interface ChartMarker {
  x: number
  label?: string
  color: string
  kind?: 'line' | 'window'
  width?: number
  endX?: number
}

export function LineChart({
  series,
  bands = [],
  markers = [],
  xTicks,
  xLabel,
  yLabel,
  height = 260,
  yDomain,
  formatY = fmtTick,
  formatTipY = (v: number) => fmtNum(Math.round(v)),
  gapStrip,
  onPointClick,
  ariaLabel,
}: {
  series: LineSeries[]
  bands?: BandSeries[]
  markers?: ChartMarker[]
  xTicks: { x: number; label: string }[]
  xLabel?: (x: number) => string
  yLabel?: string
  height?: number
  yDomain?: [number, number]
  formatY?: (v: number) => string
  formatTipY?: (v: number) => string
  gapStrip?: { x: number; color: string; label: string }[]
  onPointClick?: (x: number) => void
  ariaLabel: string
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [tip, setTip] = useState<TipState | null>(null)
  const pad = { top: 12, right: 16, bottom: xLabel ? 40 : 26, left: 52 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const gapH = gapStrip && gapStrip.length ? 6 : 0

  const allY: number[] = []
  for (const s of series) for (const p of s.points) if (p.y != null) allY.push(p.y)
  for (const b of bands) for (const p of b.upper) if (p.y != null) allY.push(p.y)
  for (const b of bands) for (const p of b.lower) if (p.y != null) allY.push(p.y)
  let lo = yDomain ? yDomain[0] : Math.min(...allY)
  let hi = yDomain ? yDomain[1] : Math.max(...allY)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  if (!yDomain) {
    const padY = (hi - lo) * 0.08
    lo = Math.max(0, lo - padY)
    hi = hi + padY
  }

  const xs = series.flatMap((s) => s.points.map((p) => p.x)).concat(bands.flatMap((b) => b.upper.map((p) => p.x)))
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const sx = (x: number) => pad.left + (x1 === x0 ? plotW / 2 : ((x - x0) / (x1 - x0)) * plotW)
  const sy = (y: number) => pad.top + plotH - ((y - lo) / (hi - lo)) * plotH

  const yTicks = niceTicks(lo, hi, 4)
  const totalH = height + gapH

  const hoverX = (clientX: number, rect: DOMRect) => {
    const rel = clientX - rect.left - pad.left
    const frac = Math.min(1, Math.max(0, rel / plotW))
    return x0 + frac * (x1 - x0)
  }

  const allX = useMemo(() => {
    const set = new Set<number>()
    for (const s of series) for (const p of s.points) if (p.y != null) set.add(p.x)
    return [...set].sort((a, b) => a - b)
  }, [series])

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const target = hoverX(e.clientX, rect)
    let nearest = allX[0]
    let best = Infinity
    for (const x of allX) {
      const d = Math.abs(x - target)
      if (d < best) {
        best = d
        nearest = x
      }
    }
    if (nearest == null) return
    const rows = series
      .map((s) => {
        const p = s.points.find((q) => q.x === nearest)
        return p && p.y != null ? { s, p } : null
      })
      .filter(Boolean) as { s: LineSeries; p: LinePoint }[]
    setTip({
      x: sx(nearest),
      y: Math.max(12, ...rows.map((r) => sy(r.p.y as number))),
      content: (
        <>
          <div className="tip-date">{xLabel ? xLabel(nearest) : fmtShort(new Date(nearest * 86400000).toISOString().slice(0, 10))}</div>
          {rows.map(({ s, p }) => (
            <TipRow key={s.id} color={s.color} label={s.label} value={formatTipY(p.y as number)} dash={s.dashed} />
          ))}
          {gapStrip?.filter((g) => g.x === nearest).map((g, i) => (
            <div className="tip-note" key={i}>{g.label}</div>
          ))}
          {markers.filter((m) => m.kind !== 'window' && Math.abs(m.x - nearest) < 0.5).map((m, i) => (
            <div className="tip-note" key={`m${i}`}>{m.label}</div>
          ))}
        </>
      ),
    })
  }

  return (
    <div ref={ref} className="chart" style={{ position: 'relative' }}>
      <svg
        height={totalH}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={handleMove}
        onPointerLeave={() => setTip(null)}
        onClick={() => onPointClick && tip && onPointClick(Math.round(x0 + ((tip.x - pad.left) / plotW) * (x1 - x0)))}
      >
        {/* window markers */}
        {markers.filter((m) => m.kind === 'window').map((m, i) => (
          <rect
            key={`w${i}`}
            x={sx(m.x)}
            y={pad.top}
            width={Math.max(1, sx(m.endX ?? m.x) - sx(m.x))}
            height={plotH}
            fill={m.color}
            opacity={0.07}
          />
        ))}
        {/* y grid */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatY(t)}
            </text>
          </g>
        ))}
        {/* x axis */}
        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke="var(--axis)" strokeWidth={1} />
        {xTicks
          .filter((t) => t.x >= x0 - 0.5 && t.x <= x1 + 0.5)
          .map((t) => (
            <text key={t.label + t.x} x={sx(t.x)} y={pad.top + plotH + 15} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {t.label}
            </text>
          ))}
        {/* bands */}
        {bands.map((b) => {
          const upper = b.upper.filter((p) => p.y != null) as { x: number; y: number }[]
          const lower = b.lower.filter((p) => p.y != null) as { x: number; y: number }[]
          if (!upper.length || !lower.length) return null
          const area = `${pathFrom(upper.map((p) => ({ x: sx(p.x), y: sy(p.y) })))} L${lower
            .slice()
            .reverse()
            .map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`)
            .join(' L')} Z`
          return (
            <g key={b.id}>
              <path d={area} fill={b.color} opacity={0.13} />
              {b.dashedEdge ? (
                <>
                  <path d={pathFrom(upper.map((p) => ({ x: sx(p.x), y: sy(p.y) })))} fill="none" stroke={b.color} strokeWidth={1} opacity={0.45} strokeDasharray="3 3" />
                  <path d={pathFrom(lower.map((p) => ({ x: sx(p.x), y: sy(p.y) })))} fill="none" stroke={b.color} strokeWidth={1} opacity={0.45} strokeDasharray="3 3" />
                </>
              ) : null}
            </g>
          )
          })}
        {/* vertical markers */}
        {markers.filter((m) => m.kind !== 'window' && m.endX == null).map((m, i) => (
          <g key={`v${i}`}>
            <line
              x1={sx(m.x)}
              x2={sx(m.x)}
              y1={pad.top - 2}
              y2={pad.top + plotH}
              stroke={m.color}
              strokeWidth={m.width ?? 1}
              strokeDasharray={m.kind === 'line' ? '4 3' : undefined}
              opacity={0.7}
            />
            {m.label ? (
              <text x={sx(m.x) + 4} y={pad.top + 9} fontSize={9.5} fill={m.color} fontWeight={600}>
                {m.label}
              </text>
            ) : null}
          </g>
        ))}
        {/* series */}
        {series.map((s) => {
          const segs = segmentsOf(
            s.points.map((p) => ({ x: p.x, y: p.y == null ? NaN : p.y, ok: p.y != null })),
            (v) => !v.ok,
          )
          return (
            <g key={s.id}>
              {s.fill
                ? segs.map((seg, i) => (
                    <path
                      key={i}
                      d={`${pathFrom(seg.map((p) => ({ x: sx(p.x), y: sy(p.y) })))} L${sx(seg[seg.length - 1].x)},${sy(lo)} L${sx(seg[0].x)},${sy(lo)} Z`}
                      fill={s.color}
                      opacity={0.08}
                    />
                  ))
                : null}
              {segs.map((seg, i) => (
                <path
                  key={i}
                  d={pathFrom(seg.map((p) => ({ x: sx(p.x), y: sy(p.y) })))}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width ?? 2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={s.dashed ? '5 4' : undefined}
                />
              ))}
            </g>
          )
        })}
        {/* gap strip */}
        {gapStrip?.length ? (
          <g>
            {gapStrip.map((g, i) => (
              <rect key={i} x={sx(g.x)} y={pad.top + plotH + (xLabel ? 22 : 8)} width={Math.max(1.5, plotW / Math.max(1, x1 - x0) + 0.4)} height={4} fill={g.color} rx={0.5} className="mm-cell">
                <title>{g.label}</title>
              </rect>
            ))}
          </g>
        ) : null}
        {/* hover */}
        {tip ? (
          <g pointerEvents="none">
            <line className="hover-line" x1={tip.x} x2={tip.x} y1={pad.top} y2={pad.top + plotH} />
            {series.map((s) => {
              const p = s.points.find((q) => Math.abs(q.x - (x0 + ((tip.x - pad.left) / plotW) * (x1 - x0))) < 0.4)
              if (!p || p.y == null) return null
              return <circle key={s.id} className="hover-dot" cx={sx(p.x)} cy={sy(p.y)} r={4} fill={s.color} />
            })}
          </g>
        ) : null}
      </svg>
      {yLabel ? <div style={{ position: 'absolute', left: 0, top: 0, fontSize: 10, color: 'var(--muted)' }}>{yLabel}</div> : null}
      <Tooltip tip={tip} width={width} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* column chart (vertical), single or stacked                          */
/* ------------------------------------------------------------------ */

export interface ColumnSeries {
  id: string
  label: string
  color: string
  values: (number | null)[]
  directLabel?: boolean
}

export function ColumnChart({
  categories,
  series,
  stacked = false,
  height = 220,
  formatY = fmtTick,
  formatTipY = (v: number) => fmtNum(v),
  ariaLabel,
  unit = '',
  tickEvery = 1,
}: {
  categories: string[]
  series: ColumnSeries[]
  stacked?: boolean
  height?: number
  formatY?: (v: number) => string
  formatTipY?: (v: number) => string
  ariaLabel: string
  unit?: string
  tickEvery?: number
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { top: 14, right: 10, bottom: 34, left: 44 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const n = categories.length
  const totals = categories.map((_, i) =>
    stacked ? series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0) : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  )
  const hi = Math.max(1, ...totals)
  // 计数型数据（最大 1..6 段）若用默认 2.5/0.5 刻度会出现重复整数标签，这里收紧到整数步长
  const yTicks = hi <= 6 && Number.isInteger(hi) ? Array.from({ length: hi + 1 }, (_, i) => i) : niceTicks(0, hi, 4)
  const band = plotW / Math.max(1, n)
  const barW = series.length > 1 && !stacked ? Math.min(20, (band * 0.7) / series.length) : Math.min(24, band * 0.62)
  const sy = (v: number) => pad.top + plotH - (v / hi) * plotH

  return (
    <div ref={ref} className="chart">
      <svg height={height} role="img" aria-label={ariaLabel}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
            <text x={pad.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatY(t)}
            </text>
          </g>
        ))}
        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke="var(--axis)" />
        {categories.map((cat, i) => {
          const cx = pad.left + band * i + band / 2
          let acc = 0
          return (
            <g key={cat}>
              <rect
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={plotH}
                fill={hover === i ? 'var(--surface-2)' : 'transparent'}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                tabIndex={0}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${cat}：${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join('，')}`}
              />
              {series.map((s, si) => {
                const v = s.values[i]
                if (v == null || v <= 0) return null
                const h = (v / hi) * plotH
                if (stacked) {
                  const y = pad.top + plotH - acc - h
                  acc += h
                  return (
                    <rect
                      key={s.id}
                      x={cx - barW / 2}
                      y={y + (si > 0 ? 0 : 0)}
                      width={barW}
                      height={Math.max(0, h - 2)}
                      fill={s.color}
                      rx={si === series.length - 1 ? 4 : 0}
                      pointerEvents="none"
                    />
                  )
                }
                const groupW = barW * series.length + 2 * (series.length - 1)
                const x = cx - groupW / 2 + si * (barW + 2)
                return (
                  <g key={s.id}>
                    <rect x={x} y={pad.top + plotH - h} width={barW} height={Math.max(1, h)} fill={s.color} rx={Math.min(4, barW / 2)} pointerEvents="none" />
                    {n <= 8 && s.directLabel ? (
                      <text x={x + barW / 2} y={pad.top + plotH - h - 5} textAnchor="middle" fontSize={10} fill="var(--ink-2)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatTipY(v)}
                      </text>
                    ) : null}
                  </g>
                )
              })}
              {i % tickEvery === 0 ? (
                <text x={cx} y={pad.top + plotH + 15} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {cat}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {hover != null ? (
        <div
          className="tip"
          style={{ left: Math.min(width - 170, pad.left + band * hover + band / 2 + 8), top: 8 }}
        >
          <div className="tip-date">{categories[hover]}</div>
          {[...series].reverse().map((s) => (
            <TipRow key={s.id} color={s.color} label={s.label} value={`${formatTipY(s.values[hover] ?? 0)}${unit}`} />
          ))}
          {stacked && series.length > 1 ? (
            <div className="tip-note">合计 {formatTipY(totals[hover])}{unit}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* horizontal bar (single hue, ranked)                                 */
/* ------------------------------------------------------------------ */

export function HBars({
  items,
  formatValue = fmtNum,
  color = 'var(--s1)',
  max,
  ariaLabel,
}: {
  items: { label: string; value: number; note?: string }[]
  formatValue?: (v: number) => string
  color?: string
  max?: number
  ariaLabel: string
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const labelW = 92
  const valueW = 44
  const trackW = Math.max(20, width - labelW - valueW)
  const hi = max ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <div ref={ref} className="chart" role="img" aria-label={ariaLabel}>
      {items.map((it, i) => (
        <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 26 }}>
          <span style={{ width: labelW, fontSize: 11, color: 'var(--ink-2)', flex: '0 0 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.label}>
            {it.label}
          </span>
          <span style={{ flex: 1, height: 8, background: 'var(--surface-3)', borderRadius: 4, position: 'relative', display: 'block' }}>
            <span
              style={{
                position: 'absolute',
                inset: 0,
                width: `${Math.max(1, (it.value / hi) * 100)}%`,
                background: color,
                borderRadius: 4,
              }}
            />
          </span>
          <span className="tnum" style={{ width: valueW, textAlign: 'right', fontSize: 11, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
            {formatValue(it.value)}
          </span>
          {it.note ? <span className="dim small" style={{ width: 32 }}>{it.note}</span> : null}
          <span className="sr-only">{`${it.label} ${formatValue(it.value)}`}</span>
          <span key={i} hidden />
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* heatmap (sequential)                                                */
/* ------------------------------------------------------------------ */

const SEQ = ['#eef4fc', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
const SEQ_DARK = ['#14263d', '#183b63', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb']

function seqColor(t: number, dark: boolean): string {
  const ramp = dark ? SEQ_DARK : SEQ
  const x = Math.min(0.999, Math.max(0, t)) * (ramp.length - 1)
  return ramp[Math.round(x)]
}

export function Heatmap({
  rows,
  columns,
  values,
  rowLabelWidth = 96,
  cellHeight = 14,
  ariaLabel,
  formatCell,
  onCellClick,
  legendLabel = '强度',
}: {
  rows: string[]
  columns: { key: string; label: string }[]
  values: number[][]
  rowLabelWidth?: number
  cellHeight?: number
  ariaLabel: string
  formatCell: (v: number, row: string, col: string) => string
  onCellClick?: (row: string, col: string) => void
  legendLabel?: string
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null)
  const dark = usePrefersDark()
  const maxV = Math.max(0.0001, ...values.flat())
  const gridW = Math.max(20, width - rowLabelWidth)
  const cw = gridW / Math.max(1, columns.length)
  const tickEvery = Math.max(1, Math.ceil(columns.length / 10))
  return (
    <div ref={ref} className="chart">
      <div role="img" aria-label={ariaLabel} style={{ position: 'relative' }}>
        <div style={{ display: 'flex' }}>
          <div style={{ width: rowLabelWidth, flex: '0 0 auto' }}>
            {rows.map((r) => (
              <div key={r} style={{ height: cellHeight + 2, fontSize: 10.5, color: 'var(--ink-2)', display: 'flex', alignItems: 'center' }}>
                {r}
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }}>
            {rows.map((r, ri) => (
              <div key={r} style={{ display: 'flex', gap: 1, height: cellHeight + 2, alignItems: 'center' }}>
                {columns.map((c, ci) => {
                  const v = values[ri]?.[ci] ?? 0
                  return (
                    <button
                      key={c.key}
                      onPointerEnter={() => setHover({ r: ri, c: ci })}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => setHover({ r: ri, c: ci })}
                      onBlur={() => setHover(null)}
                      onClick={() => onCellClick?.(r, c.key)}
                      aria-label={`${r} ${c.label}：${formatCell(v, r, c.label)}`}
                      style={{
                        flex: 1,
                        minWidth: 1,
                        height: cellHeight,
                        border: 0,
                        padding: 0,
                        background: v > 0 ? seqColor(v / maxV, dark) : 'var(--surface-3)',
                        outline: hover?.r === ri && hover?.c === ci ? '1.5px solid var(--ink)' : 'none',
                        borderRadius: 1,
                      }}
                    />
                  )
                })}
              </div>
            ))}
            <div style={{ display: 'flex', marginTop: 4 }}>
              {columns.map((c, ci) =>
                ci % tickEvery === 0 ? (
                  <span key={c.key} style={{ flex: 1, fontSize: 9, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </span>
                ) : (
                  <span key={c.key} style={{ flex: 1 }} />
                ),
              )}
            </div>
          </div>
        </div>
        {hover ? (
          <div className="tip" style={{ left: Math.min(width - 180, rowLabelWidth + hover.c * cw + 10), top: hover.r * (cellHeight + 2) + 6 }}>
            <div className="tip-date">{rows[hover.r]} · {columns[hover.c].label}</div>
            <div className="tip-row">
              <span className="tk">缺失 / 总量</span>
              <span className="tv">{formatCell(values[hover.r][hover.c], rows[hover.r], columns[hover.c].label)}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
        <span>低</span>
        {SEQ.map((c, i) => (
          <span key={c} style={{ width: 18, height: 8, borderRadius: 2, background: dark ? SEQ_DARK[i] : c, display: 'inline-block' }} />
        ))}
        <span>高</span>
        <span style={{ marginLeft: 8 }}>{legendLabel}</span>
      </div>
    </div>
  )
}

export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    typeof window !== 'undefined' && (document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)),
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setDark(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && mq.matches))
    mq.addEventListener('change', onChange)
    const mo = new MutationObserver(onChange)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', onChange)
      mo.disconnect()
    }
  }, [])
  return dark
}

/* ------------------------------------------------------------------ */
/* sparkline                                                           */
/* ------------------------------------------------------------------ */

export function Sparkline({ values, color = 'var(--s1)', width = 120, height = 26 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * (width - 4) + 2,
    y: height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6),
  }))
  return (
    <svg width={width} height={height} aria-hidden style={{ display: 'block' }}>
      <path d={pathFrom(pts)} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={2.5} fill={color} />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* coverage dot plot                                                   */
/* ------------------------------------------------------------------ */

export function CoveragePlot({
  points,
  target,
  height = 200,
  color = 'var(--s1)',
  ariaLabel,
}: {
  points: { label: string; value: number; n?: number }[]
  target: number
  height?: number
  color?: string
  ariaLabel: string
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { top: 16, right: 20, bottom: 30, left: 40 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const lo = Math.min(0, ...points.map((p) => p.value), target) - 0.05
  const hi = Math.max(target, ...points.map((p) => p.value)) + 0.05
  const sx = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  const sy = (v: number) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH
  const taps = niceTicks(lo, hi, 4)
  return (
    <div ref={ref} className="chart">
      <svg height={height} role="img" aria-label={ariaLabel}>
        {taps.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
            <text x={pad.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        <line x1={pad.left} x2={pad.left + plotW} y1={sy(target)} y2={sy(target)} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="4 3" />
        <text x={pad.left + plotW} y={sy(target) - 5} textAnchor="end" fontSize={9.5} fill="var(--ink-2)">
          目标 {Math.round(target * 100)}%
        </text>
        <polyline
          points={points.map((p, i) => `${sx(i)},${sy(p.value)}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          opacity={0.35}
        />
        {points.map((p, i) => (
          <g key={p.label}>
            <circle
              cx={sx(i)}
              cy={sy(p.value)}
              r={hover === i ? 5 : 4}
              fill={color}
              stroke="var(--surface)"
              strokeWidth={2}
              tabIndex={0}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${p.label}：${Math.round(p.value * 100)}%`}
            />
            <text x={sx(i)} y={pad.top + plotH + 15} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
              {p.label}
            </text>
          </g>
        ))}
      </svg>
      {hover != null ? (
        <div className="tip" style={{ left: Math.min(width - 170, sx(hover) + 10), top: 4 }}>
          <div className="tip-date">{points[hover].label}</div>
          <div className="tip-row">
            <span className="tk">区间覆盖率</span>
            <span className="tv">{Math.round(points[hover].value * 1000) / 10}%</span>
          </div>
          {points[hover].n != null ? <div className="tip-note">样本 {points[hover].n} 点</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* residual scatter / error-by-origin                                  */
/* ------------------------------------------------------------------ */

export function ErrorScatter({
  points,
  height = 230,
  ariaLabel,
  xFormat,
}: {
  points: { x: number; y: number; covered: boolean; label: string }[]
  height?: number
  ariaLabel: string
  xFormat: (v: number) => string
}) {
  const { ref, width } = useMeasure<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { top: 14, right: 16, bottom: 28, left: 48 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const lim = Math.max(0.01, ...ys.map(Math.abs)) * 1.1
  const sx = (v: number) => pad.left + ((v - x0) / (x1 - x0 || 1)) * plotW
  const sy = (v: number) => pad.top + plotH / 2 - (v / lim) * (plotH / 2)
  const yt = niceTicks(-lim, lim, 4)
  return (
    <div ref={ref} className="chart">
      <svg height={height} role="img" aria-label={ariaLabel}>
        {yt.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={pad.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {`${(t * 100).toFixed(0)}%`}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={hover === i ? 4.5 : 5}
            fill={p.covered ? 'var(--s1)' : 'var(--s2)'}
            fillOpacity={hover === i ? 1 : 0.75}
            stroke="var(--surface)"
            strokeWidth={1.5}
            tabIndex={0}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${p.label}：误差 ${(p.y * 100).toFixed(1)}%`}
          />
        ))}
        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke="var(--axis)" />
        <text x={pad.left} y={height - 4} fontSize={9.5} fill="var(--muted)">{xFormat(x0)}</text>
        <text x={pad.left + plotW} y={height - 4} fontSize={9.5} fill="var(--muted)" textAnchor="end">{xFormat(x1)}</text>
      </svg>
      {hover != null ? (
        <div className="tip" style={{ left: Math.min(width - 190, sx(points[hover].x) + 10), top: 4 }}>
          <div className="tip-date">{points[hover].label}</div>
          <div className="tip-row">
            <span className="tk">残差 / 实际</span>
            <span className="tv">{(points[hover].y * 100).toFixed(1)}%</span>
          </div>
          <div className="tip-note">{points[hover].covered ? '落在 80% 区间内' : '超出 80% 区间'}</div>
        </div>
      ) : null}
    </div>
  )
}
