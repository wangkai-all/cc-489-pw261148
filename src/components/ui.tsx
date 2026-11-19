import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Badge({
  tone = 'neutral',
  children,
  icon,
  title,
}: {
  tone?: 'neutral' | 's1' | 's2' | 's3' | 'good' | 'warn' | 'crit' | 'outline'
  children: ReactNode
  icon?: ReactNode
  title?: string
}) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {icon}
      {children}
    </span>
  )
}

export function StatusIcon({ status, size = 11 }: { status: 'pass' | 'warn' | 'fail' | 'info'; size?: number }) {
  const color = status === 'pass' ? 'var(--good)' : status === 'warn' ? 'var(--warning)' : status === 'fail' ? 'var(--critical)' : 'var(--muted)'
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden style={{ flex: '0 0 auto' }}>
      {status === 'pass' ? (
        <path d="M2 6.4 4.7 9 10 3.4" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      ) : status === 'fail' ? (
        <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      ) : status === 'warn' ? (
        <>
          <path d="M6 1.6 11 10.6H1Z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6 4.7v2.6" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="9" r="0.7" fill={color} />
        </>
      ) : (
        <>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke={color} strokeWidth="1.3" />
          <path d="M6 5.2v3M6 3.7v.1" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  tone = false,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; tone?: string; title?: string }[]
  ariaLabel: string
  tone?: boolean
}) {
  return (
    <div className={`seg ${tone ? 'tint' : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          data-tone={o.tone}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
  )
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} style={wide ? { width: 'min(760px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200)
    return () => clearTimeout(t)
  }, [message, onDone])
  return (
    <div className="toast" role="status">
      <span className="tick">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2.5 7.4 5.4 10.2 11.5 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span dangerouslySetInnerHTML={{ __html: sanitize(message) }} />
    </div>
  )
}

function sanitize(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
}

export function Stat({
  label,
  value,
  unit,
  delta,
  deltaTone = 'neutral',
  foot,
  children,
}: {
  label: string
  value: ReactNode
  unit?: string
  delta?: ReactNode
  deltaTone?: 'good' | 'bad' | 'neutral'
  foot?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="kpi">
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {delta ? <div className={`d ${deltaTone === 'good' ? 'up' : deltaTone === 'bad' ? 'down' : ''}`}>{delta}</div> : null}
      {children}
      {foot ? <div className="d dim">{foot}</div> : null}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return { copied, setCopied }
}

export function weekdayCn(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()]
}

export function fmtDateCn(iso: string): string {
  return iso.replace(/-/g, '/')
}

export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return iso.slice(0, 10)
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}
