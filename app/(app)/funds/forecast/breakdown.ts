import type { ReportLine } from '@/lib/forecast/report'

/**
 * Revenue or expenses split by source, for the management company's stacked bars. Each P&L account
 * is a source; the largest few over the range keep their own series and the rest fold into "Other",
 * so the chart stays readable whatever the chart of accounts looks like. Series are ordered largest
 * first and keep that order (and so their colour) for every period in the range.
 */

export interface BreakdownSeries {
  key: string
  label: string
  values: number[]
}

export const OTHER_KEY = 'other'

/** Realized gains, unrealized and FX changes and the like are not a management company's revenue. */
export const NOT_REVENUE = new Set(['realized_gain', 'unrealized', 'fx_translation', 'equity_method', 'carried_interest'])

export function sourceBreakdown(lines: ReportLine[], type: 'income' | 'expense', top = 5): BreakdownSeries[] {
  const pick = lines.filter(l => l.type === type && (type === 'expense' || !NOT_REVENUE.has(l.subtype ?? '')))
  const total = (l: ReportLine) => l.values.reduce((s, v) => s + Math.abs(v ?? 0), 0)
  const ranked = pick
    .map(l => ({ l, size: total(l) }))
    .filter(r => r.size >= 0.5)
    .sort((a, b) => b.size - a.size || a.l.code.localeCompare(b.l.code))
  // Folding a single account into "Other" hides its name for nothing; keep it instead.
  const keep = ranked.length <= top + 1 ? ranked : ranked.slice(0, top)
  const rest = ranked.slice(keep.length)
  const out: BreakdownSeries[] = keep.map(({ l }) => ({ key: `a${l.accountId}`, label: l.name, values: l.values.map(v => v ?? 0) }))
  if (rest.length) {
    const n = Math.max(...rest.map(r => r.l.values.length))
    out.push({
      key: OTHER_KEY,
      label: `Other (${rest.length})`,
      values: Array.from({ length: n }, (_, i) => rest.reduce((s, r) => s + (r.l.values[i] ?? 0), 0)),
    })
  }
  return out
}
