/** All dates in this console are UTC calendar days, rendered as YYYY-MM-DD. */
export const DAY_MS = 86_400_000

export function toDay(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

export function fmtDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return fmtDay(new Date(toDay(iso).getTime() + days * DAY_MS))
}

export function diffDays(from: string, to: string): number {
  return Math.round((toDay(to).getTime() - toDay(from).getTime()) / DAY_MS)
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export function weekday(iso: string): number {
  return toDay(iso).getUTCDay()
}

export const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六']

export function fmtShort(iso: string): string {
  return iso.slice(5).replace('-', '/')
}

export function fmtCn(iso: string): string {
  const d = toDay(iso)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** Nth weekday (0=Sun) of a month, e.g. US Thanksgiving = 4th Thursday of November. */
export function nthWeekdayOfMonth(year: number, month: number, weekdayNo: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const delta = (weekdayNo - first.getUTCDay() + 7) % 7
  const day = 1 + delta + (n - 1) * 7
  return fmtDay(new Date(Date.UTC(year, month - 1, day)))
}
