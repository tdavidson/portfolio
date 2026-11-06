// Charts of a fund's performance for its letters, drawn from the letter's own figures (the brief's
// portfolio as of the quarter) as static SVG. The PNG made from it (chart-render.ts) goes into the
// letter like an uploaded chart: stored under its hash, never redrawn, so a final letter shows the
// figures it was reviewed with.
//
// The visual language is the dashboards' bar charts (lib/mcp-apps/app/charts.ts, DESIGN.md
// "Charts"): one series in one colour; a second measure on the same scale is an ink tick, not a
// second hue; text is ink; every value is printed at the bar's end; a multiple under 1.0x is drawn
// in the loss colour. Each chart says gross or net, and the caption gives the date.
//
// Pure: no server imports.

import type { PortfolioPreview } from './aggregate'
import { fmt } from './generate'

export const FUND_CHART_KINDS = ['value_by_company', 'multiple_by_company', 'value_bridge', 'capital_net'] as const
export type FundChartKind = (typeof FUND_CHART_KINDS)[number]

export const FUND_CHART_LABEL: Record<FundChartKind, string> = {
  value_by_company: 'Value and cost by company (gross)',
  multiple_by_company: 'Gross multiple by company',
  value_bridge: 'Invested, realized and remaining value (gross)',
  capital_net: 'Paid-in, distributed and remaining value (net)',
}

export const CHART_COLORS = ['series', 'accent', 'ink'] as const
export type ChartColor = (typeof CHART_COLORS)[number]

export interface FundChartOptions {
  /** series: the dashboards' blue; accent: the fund's theme accent; ink: greys only, for print. */
  color?: ChartColor
  /** Companies to show, largest first; 0 or absent shows all. */
  limit?: number
  /** Leave out exited and written-off companies. */
  activeOnly?: boolean
  sort?: 'value' | 'name'
}

export interface FundChart {
  kind: FundChartKind
  svg: string
  width: number
  height: number
  /** The suggested caption: what it shows, its basis and the date. */
  caption: string
  /** Why it can't be drawn (no companies, no fund metrics), instead of an empty chart. */
  empty?: string
}

const INK = '#1f1f1d'
const MUTED = '#6b6a65'
const RULE = '#e4e3df'
const LOSS = '#bf2e2e' // --destructive (0 68% 44%)
const SERIES = '#2a77d6' // --cat-1 (213 67.7% 50.2%)
const INK_SERIES = '#55544f'

/** An HSL triple ("213 67% 50%") as hex, for the fund's accent. */
export function hslTripleToHex(hsl: string | null | undefined): string | null {
  const m = hsl?.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/)
  if (!m) return null
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** A colour too light to read as a bar on white (a yellow accent) falls back to the series blue. */
function readable(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.6
}

export function seriesColor(color: ChartColor | undefined, accentHsl: string | null | undefined): string {
  if (color === 'ink') return INK_SERIES
  if (color === 'accent') {
    const hex = hslTripleToHex(accentHsl)
    if (hex && readable(hex)) return hex
  }
  return SERIES
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const FONT = `font-family="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`

function longDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

interface Row {
  label: string
  /** Segments drawn end to end from zero: the first in the series colour, the rest softer. */
  parts: { value: number; soft?: boolean; loss?: boolean }[]
  /** A second measure on the same scale: a thin ink tick. */
  tick?: number
  valueLabel: string
}

interface Legend { label: string; mark: 'bar' | 'soft' | 'tick' | 'dash' | 'loss' }

const W = 720
const LABEL_W = 190
const VALUE_W = 110
const ROW_H = 30
const BAR_H = 16
const TOP = 34

function bars(rows: Row[], legend: Legend[], color: string, opts: { reference?: { value: number; label: string } } = {}): { svg: string; width: number; height: number } {
  const max = Math.max(0, ...rows.map(r => Math.max(r.parts.reduce((s, p) => s + p.value, 0), r.tick ?? 0)), opts.reference?.value ?? 0)
  const plotW = W - LABEL_W - VALUE_W - 16
  const x = (v: number) => LABEL_W + (max > 0 ? Math.max(0, v / max) * plotW : 0)
  const height = TOP + rows.length * ROW_H + 12
  const out: string[] = []

  // Legend across the top: what each mark means.
  let lx = 0
  for (const l of legend) {
    if (l.mark === 'tick') out.push(`<rect x="${lx + 5}" y="9" width="2" height="14" fill="${INK}"/>`)
    else if (l.mark === 'dash') out.push(`<line x1="${lx + 6}" y1="8" x2="${lx + 6}" y2="24" stroke="${MUTED}" stroke-width="1" stroke-dasharray="3 3"/>`)
    else out.push(`<rect x="${lx}" y="10" width="12" height="12" rx="2" fill="${l.mark === 'loss' ? LOSS : color}"${l.mark === 'soft' ? ' fill-opacity="0.32"' : ''}/>`)
    out.push(`<text x="${lx + 18}" y="20" font-size="12" fill="${MUTED}" ${FONT}>${esc(l.label)}</text>`)
    lx += 30 + l.label.length * 6.6
  }

  if (opts.reference) {
    const rx = x(opts.reference.value)
    out.push(`<line x1="${rx}" y1="${TOP - 4}" x2="${rx}" y2="${height - 8}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="3 3"/>`)
  }

  rows.forEach((r, i) => {
    const y = TOP + i * ROW_H
    const cy = y + ROW_H / 2
    out.push(`<line x1="0" y1="${y + ROW_H}" x2="${W}" y2="${y + ROW_H}" stroke="${RULE}" stroke-width="1"/>`)
    out.push(`<text x="0" y="${cy + 4}" font-size="12.5" fill="${INK}" ${FONT}>${esc(clip(r.label, 28))}</text>`)
    let start = 0
    for (const p of r.parts) {
      if (p.value <= 0) continue
      const x0 = x(start), x1 = x(start + p.value)
      out.push(`<rect x="${x0}" y="${cy - BAR_H / 2}" width="${Math.max(1, x1 - x0)}" height="${BAR_H}" fill="${p.loss ? LOSS : color}"${p.soft ? ' fill-opacity="0.32"' : ''}/>`)
      start += p.value
    }
    if (r.tick != null && r.tick > 0) {
      const tx = x(r.tick)
      out.push(`<rect x="${tx - 3}" y="${cy - BAR_H / 2 - 4}" width="6" height="${BAR_H + 8}" fill="#ffffff"/>`)
      out.push(`<rect x="${tx - 1}" y="${cy - BAR_H / 2 - 4}" width="2" height="${BAR_H + 8}" fill="${INK}"/>`)
    }
    out.push(`<text x="${W}" y="${cy + 4}" font-size="12.5" text-anchor="end" fill="${INK}" ${FONT} style="font-variant-numeric: tabular-nums">${esc(r.valueLabel)}</text>`)
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}"><rect width="${W}" height="${height}" fill="#ffffff"/>${out.join('')}</svg>`
  return { svg, width: W, height }
}

/** One chart of the letter's figures. */
export function buildFundChart(kind: FundChartKind, preview: PortfolioPreview, opts: FundChartOptions = {}, accentHsl: string | null = null): FundChart {
  const cur = preview.fundCurrency || 'USD'
  const money = (n: number) => fmt(n, cur)
  const color = seriesColor(opts.color, accentHsl)
  const asOf = longDate(preview.asOf)
  const entity = preview.portfolioGroup
  const dated = (what: string) => `${what}${entity ? `, ${entity}` : ''}${asOf ? `, as of ${asOf}` : ''}.`

  let list = preview.companies.map(c => c.investment).filter(i => i.totalInvested > 0)
  if (opts.activeOnly) list = list.filter(i => i.status === 'active')
  const value = (i: (typeof list)[number]) => i.totalRealized + i.unrealizedValue
  const sortBy = (k: (i: (typeof list)[number]) => number) =>
    opts.sort === 'name' ? [...list].sort((a, b) => a.companyName.localeCompare(b.companyName)) : [...list].sort((a, b) => k(b) - k(a))
  const cap = <T,>(xs: T[]) => (opts.limit && opts.limit > 0 ? xs.slice(0, opts.limit) : xs)
  const none = (why: string): FundChart => ({ kind, svg: '', width: 0, height: 0, caption: '', empty: why })

  if (kind === 'value_by_company') {
    if (!list.length) return none('This entity has no investments to chart for the quarter.')
    const rows = cap(sortBy(value)).map(i => ({
      label: i.companyName,
      parts: [{ value: value(i), loss: value(i) < i.totalInvested }],
      tick: i.totalInvested,
      valueLabel: `${money(value(i))} / ${money(i.totalInvested)}`,
    }))
    const legend: Legend[] = [{ label: 'Value (realized + fair value), gross', mark: 'bar' }, { label: 'Cost', mark: 'tick' }]
    if (rows.some(r => r.parts[0].loss)) legend.push({ label: 'Below cost', mark: 'loss' })
    return { kind, ...bars(rows, legend, color), caption: dated('Value and cost by company, gross: realized proceeds plus fair value, against cost') }
  }

  if (kind === 'multiple_by_company') {
    const withMoic = list.filter(i => i.moic != null)
    if (!withMoic.length) return none('No company has a multiple to chart for the quarter.')
    const sorted = opts.sort === 'name'
      ? [...withMoic].sort((a, b) => a.companyName.localeCompare(b.companyName))
      : [...withMoic].sort((a, b) => (b.moic ?? 0) - (a.moic ?? 0))
    const rows = cap(sorted).map(i => ({
      label: i.companyName,
      parts: [{ value: i.moic ?? 0, loss: (i.moic ?? 0) < 1 }],
      valueLabel: `${(i.moic ?? 0).toFixed(2)}x`,
    }))
    const legend: Legend[] = [{ label: 'Gross multiple', mark: 'bar' }]
    if (rows.some(r => r.parts[0].loss)) legend.push({ label: 'Below 1.0x', mark: 'loss' })
    legend.push({ label: '1.0x', mark: 'dash' })
    return { kind, ...bars(rows, legend, color, { reference: { value: 1, label: '1.0x' } }), caption: dated('Gross multiple on invested capital by company') }
  }

  if (kind === 'value_bridge') {
    const t = preview.totals
    if (!(t.totalInvested > 0)) return none('This entity has no invested capital to chart for the quarter.')
    const remaining = Math.max(0, preview.companies.reduce((s, c) => s + c.investment.unrealizedValue, 0))
    const rows: Row[] = [
      { label: 'Invested (cost)', parts: [{ value: t.totalInvested }], valueLabel: money(t.totalInvested) },
      { label: 'Realized', parts: [{ value: t.totalRealized }], valueLabel: money(t.totalRealized) },
      { label: 'Fair value of holdings', parts: [{ value: remaining, soft: true }], valueLabel: money(remaining) },
      { label: 'Total value, gross', parts: [{ value: t.totalRealized }, { value: remaining, soft: true }], tick: t.totalInvested, valueLabel: money(t.totalRealized + remaining) },
    ]
    const legend: Legend[] = [{ label: 'Cost and realized', mark: 'bar' }, { label: 'Fair value', mark: 'soft' }, { label: 'Cost', mark: 'tick' }]
    return { kind, ...bars(rows, legend, color), caption: dated('Invested capital, realized proceeds and the fair value of remaining holdings, gross') }
  }

  // capital_net
  const m = preview.fundMetrics
  if (!m || !(m.paidInCapital > 0)) return none('The fund has no paid-in capital in the books for this entity, so there are no net figures to chart.')
  const rows: Row[] = [
    { label: 'Paid-in capital', parts: [{ value: m.paidInCapital }], valueLabel: money(m.paidInCapital) },
    { label: `Distributed${m.dpi != null ? ` (DPI ${m.dpi.toFixed(2)}x)` : ''}`, parts: [{ value: m.distributions }], valueLabel: money(m.distributions) },
    { label: `Remaining value${m.rvpi != null ? ` (RVPI ${m.rvpi.toFixed(2)}x)` : ''}`, parts: [{ value: m.fmv, soft: true }], valueLabel: money(m.fmv) },
    { label: `Total${m.tvpi != null ? ` (TVPI ${m.tvpi.toFixed(2)}x)` : ''}`, parts: [{ value: m.distributions }, { value: m.fmv, soft: true }], tick: m.paidInCapital, valueLabel: money(m.distributions + m.fmv) },
  ]
  const legend: Legend[] = [{ label: 'Paid-in and distributed', mark: 'bar' }, { label: 'Remaining value', mark: 'soft' }, { label: 'Paid-in', mark: 'tick' }]
  return { kind, ...bars(rows, legend, color), caption: dated('Paid-in capital, distributions and remaining value (NAV), net') }
}
