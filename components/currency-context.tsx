'use client'

import { createContext, useContext } from 'react'
export { getCurrencySymbol } from '@/lib/currency'
import { getCurrencySymbol } from '@/lib/currency'

const CurrencyContext = createContext<string>('USD')

export function CurrencyProvider({ currency, children }: { currency: string; children: React.ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>
}

export function useCurrency() {
  return useContext(CurrencyContext)
}

/** Normalize -0 to 0 */
function noNegZero(v: number): number {
  if (Object.is(v, -0)) return 0
  // Treat tiny negatives that round to $0 as zero
  if (v < 0 && v > -0.5) return 0
  return v
}

/** Wraps a negative's figure in accounting parentheses, ($1,234), the one way the app shows a
 *  negative amount: in tables, tiles, tooltips and chart axes alike. */
function accounting(v: number, positive: string): string {
  return v < 0 ? `(${positive})` : positive
}

/** Abbreviated currency format: $1.2M, €500K, ¥1,000; a negative in parentheses, ($1.2M). */
export function formatCurrency(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const v = noNegZero(value)
  const symbol = getCurrencySymbol(currency)
  const a = Math.abs(v)
  if (a >= 1_000_000) return accounting(v, `${symbol}${(a / 1_000_000).toFixed(1)}M`)
  if (a >= 1_000) return accounting(v, `${symbol}${(a / 1_000).toFixed(0)}K`)
  return accounting(v, a.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }))
}

/** Chart-axis currency: formatCurrency without a trailing ".0" ($50M, $1.5M, ($2M), $1B), since a
 *  tick's zero decimal is noise and a column of them reads as false precision. */
export function formatCurrencyAxis(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return ''
  const v = noNegZero(value)
  const a = Math.abs(v)
  const symbol = getCurrencySymbol(currency)
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  if (a >= 1_000_000_000) return accounting(v, `${symbol}${trim(a / 1_000_000_000)}B`)
  if (a >= 1_000_000) return accounting(v, `${symbol}${trim(a / 1_000_000)}M`)
  if (a >= 1_000) return accounting(v, `${symbol}${trim(a / 1_000)}K`)
  return accounting(v, `${symbol}${Math.round(a)}`)
}

/** Full-precision currency format: $1,234,567; a negative in parentheses, ($1,234,567). */
export function formatCurrencyFull(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const v = noNegZero(value)
  return accounting(v, Math.abs(v).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }))
}

/** Full-precision currency with cents, always two decimals: $12.50, $1,234.00, ($12.50). */
export function formatCurrencyPrice(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  // Only normalize -0 → 0 here; keep real sub-dollar amounts (cents matter).
  // A negative that rounds to $0.00 shows as $0.00, not ($0.00).
  const v = Object.is(value, -0) || Math.round(value * 100) === 0 ? 0 : value
  return accounting(v, Math.abs(v).toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }))
}

/** Accounting style with cents: a negative is wrapped in parentheses around the symbol and figure,
 *  ($1,234.50), as LP statements print it. Zero and positives read as formatCurrencyPrice. */
export function formatAccountingPrice(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 100) / 100
  const shown = formatCurrencyPrice(Math.abs(rounded), currency)
  return rounded < 0 ? `(${shown})` : shown
}

/** Per-SHARE price: shown to up to 4 decimals so sub-cent prices aren't lost ($1.20, $1.2345).
 *  The stored value keeps full precision and the valuation math uses it — this only widens the
 *  display so shares × price visibly ties out. */
export function formatSharePrice(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const v = Object.is(value, -0) ? 0 : value
  return v.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}
