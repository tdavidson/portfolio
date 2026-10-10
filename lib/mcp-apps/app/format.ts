// Number and date formatting for the dashboard view. Pure, so it is unit-tested with the app's
// own tests (format.test.ts) and bundled into the view unchanged.

export const DASH = '—'

function formatter(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options)
  } catch {
    // An unknown locale or currency code from the host or the fund must not blank the dashboard.
    const { currency: _currency, style: _style, currencySign: _sign, ...rest } = options
    return new Intl.NumberFormat('en-US', rest)
  }
}

export interface Formatters {
  /** Whole currency units, negatives in parentheses: the form a financial table uses. */
  money(value: number | null | undefined): string
  /** Compact currency for tiles, axis ticks and bar labels: $4.2M, $850K. */
  compact(value: number | null | undefined): string
  /** A plain number, compact from 10,000 up. For KPIs whose unit is not money. */
  number(value: number | null | undefined): string
  /** A per-share price: currency with cents, and up to four decimals for a sub-dollar price. */
  price(value: number | null | undefined): string
}

export function createFormatters(currency: string, locale?: string): Formatters {
  const money = formatter(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0, currencySign: 'accounting' })
  // minimumFractionDigits is stated because engines disagree on the default for a compact
  // currency: without it one prints $620K and another $620.0K.
  const compact = formatter(locale, { style: 'currency', currency, notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 })
  const price = formatter(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
  const plain = formatter(locale, { maximumFractionDigits: 2 })
  const plainCompact = formatter(locale, { notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 })
  const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
  return {
    money: v => (ok(v) ? money.format(Object.is(v, -0) ? 0 : v) : DASH),
    compact: v => (ok(v) ? compact.format(Object.is(v, -0) ? 0 : v) : DASH),
    number: v => (ok(v) ? (Math.abs(v) >= 10_000 ? plainCompact.format(v) : plain.format(v)) : DASH),
    price: v => (ok(v) ? price.format(v) : DASH),
  }
}

/** A multiple: 1.84x. Null (nothing called yet, no cost basis) is a dash, never 0.00x. */
export function multiple(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}x` : DASH
}

/** A value already in percent units (12.4 means 12.4%). */
export function percent(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}%` : DASH
}

/** A fraction as a percentage (0.124 means 12.4%). IRRs are stored this way. */
export function fractionPercent(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? percent(value * 100, digits) : DASH
}

/** n / d as a percentage, or null when d is not positive. */
export function share(n: number, d: number): number | null {
  return d > 0 ? (n / d) * 100 : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * An ISO date as "9 Oct 2026". Parsed by hand: `new Date('2026-10-09')` is midnight UTC, which a
 * viewer west of Greenwich sees as the 8th, and a statement struck "as of" the wrong day is wrong.
 */
export function shortDate(iso: string | null | undefined): string {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null
  if (!m) return DASH
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : DASH
}

/** The time a dashboard's figures were read, in the viewer's own time zone. */
export function clockTime(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
}

/** "active" to "Active", "written_off" to "Written off". */
export function titleCase(value: string | null | undefined): string {
  if (!value) return ''
  const spaced = value.replace(/[_-]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
