// A KPI's change against its comparison date, written the same way in the app, in Claude's view
// and in the exports. Pure: the caller passes its own figure formatter.
//
// A percent figure changes by points, not by a percent of itself (12% to 15% is +3.0 pts, not
// +25%). Any other figure shows its change, and the change as a share of the earlier figure when
// that figure is not zero.

export interface KpiDelta { text: string; direction: 'up' | 'down' | 'flat' }

export function kpiDelta(
  value: unknown,
  previous: number | null | undefined,
  format: string | undefined,
  formatFigure: (v: number) => string,
): KpiDelta | null {
  const now = typeof value === 'number' ? value : Number(value)
  if (previous == null || value == null || value === '' || !Number.isFinite(now)) return null
  const change = now - previous
  const direction = Math.abs(change) < 1e-9 ? 'flat' : change > 0 ? 'up' : 'down'
  const sign = direction === 'up' ? '+' : direction === 'down' ? '−' : ''
  if (format === 'percent') return { text: `${sign}${Math.abs(change).toFixed(1)} pts`, direction }
  const amount = `${sign}${formatFigure(Math.abs(change))}`
  const pct = previous !== 0 ? ` (${sign}${Math.abs((change / Math.abs(previous)) * 100).toFixed(1)}%)` : ''
  return { text: `${amount}${pct}`, direction }
}
