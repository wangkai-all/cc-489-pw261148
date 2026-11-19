export const MAD_SCALE = 1.4826

export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
