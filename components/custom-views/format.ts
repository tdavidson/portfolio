// Figures in a custom view, written the way every figure in the app is: whole currency, negatives
// in accounting parentheses, percent as a number (12.5 is 12.5%).

import { formatCurrencyAxis, formatCurrencyFull } from '@/components/currency-context'
import type { CustomValueFormat } from '@/lib/mcp-apps/payload'

export function formatValue(v: number | string | null | undefined, format: CustomValueFormat | undefined, currency: string): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') {
    if (format === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      return new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    }
    return v
  }
  // Negatives in accounting parentheses everywhere, as every figure in the app is.
  const paren = (s: string) => (v < 0 ? `(${s})` : s)
  switch (format) {
    case 'currency': return formatCurrencyFull(v, currency)
    case 'percent': return paren(`${Math.abs(v).toFixed(1)}%`)
    case 'multiple': return `${v.toFixed(2)}x`
    case 'text': return String(v)
    default: return paren(Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }))
  }
}



export function axisFormatter(format: CustomValueFormat | undefined, currency: string) {
  return (v: number) => (format === 'currency' ? formatCurrencyAxis(v, currency) : formatValue(v, format, currency))
}
