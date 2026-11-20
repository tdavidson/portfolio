// A custom view as a document: a PDF to print or send, and an Excel workbook to work in.
//
// Both are built from the PAYLOAD (resolve.ts), never from the spec: the blocks have already been
// loaded as the person exporting, so a block they cannot read is `denied` here too and carries no
// rows. The document holds exactly what the page showed them, with every figure in full.
//
// Pure: no server imports. The routes render the HTML with headless Chromium (renderHtmlToPdf).
//
// - PDF: the title, filters and time it was read, the KPI tiles in a row, each chart as static
//   SVG (the same marks as the page: horizontal bars, stacked segments, lines), each table in full.
// - Excel: a "View" sheet with the title, filters and tiles, then one sheet per chart or table,
//   with real numeric cells and number formats, so the figures can be summed and pivoted.

import * as XLSX from 'xlsx'
import type { CustomBlock, CustomValueFormat, CustomViewPayload } from '@/lib/mcp-apps/payload'
import { PDF_DISPLAY, PDF_SANS, pdfFontCss } from '@/lib/pdf-fonts'
import { kpiDelta } from './delta'
import { gaugeArc, gaugePoint, gaugeShare, maxMagnitude, shadeAlpha, shadeOf, signOf, sparkPath } from './tone'

export const EXPORT_FORMATS = ['pdf', 'xlsx'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface ExportMeta {
  /** When the figures were read, already formatted for the reader ("Nov 20, 2026, 1:40 PM"). */
  readAt: string
  displayFont?: string | null
}

// ---------------------------------------------------------------------------------------------
// Formatting: the page's rules (negatives in parentheses, whole currency, percent as a number)
// ---------------------------------------------------------------------------------------------

const DASH = '—'

export function formatFigure(v: number | string | null | undefined, format: CustomValueFormat | undefined, currency: string): string {
  if (v == null || v === '') return DASH
  if (typeof v === 'string') {
    if (format === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      return new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    }
    return v
  }
  if (!Number.isFinite(v)) return DASH
  const n = Object.is(v, -0) ? 0 : v
  const paren = (s: string) => (n < 0 ? `(${s})` : s)
  switch (format) {
    case 'currency': {
      let s: string
      try {
        s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
      } catch {
        s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
      }
      return paren(s)
    }
    case 'percent': return paren(`${Math.abs(n).toFixed(1)}%`)
    case 'multiple': return `${n.toFixed(2)}x`
    case 'text': return String(n)
    default: return paren(Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 }))
  }
}

/** Compact axis labels: $1.2M, 340K, 12%. */
function compact(v: number, format: CustomValueFormat | undefined, currency: string): string {
  if (format === 'percent') return `${v.toFixed(0)}%`
  if (format === 'multiple') return `${v.toFixed(1)}x`
  const a = Math.abs(v)
  const [d, suffix] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, '']
  const body = `${+(a / d).toFixed(a / d >= 100 || d === 1 ? 0 : 1)}${suffix}`
  let symbol = ''
  if (format === 'currency') {
    try {
      symbol = (0).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).replace(/[\d.,\s]/g, '')
    } catch { /* unknown code: no symbol */ }
  }
  return v < 0 ? `(${symbol}${body})` : `${symbol}${body}`
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// The categorical palette (app/globals.css --cat-1..8), written out: a PDF has no theme.
const SERIES = [
  'hsl(213 67.7% 50.2%)', 'hsl(17 82.1% 56.3%)', 'hsl(159 73.3% 39.6%)', 'hsl(41 100% 46.5%)',
  'hsl(337 70.3% 69.6%)', 'hsl(120 100% 25.7%)', 'hsl(249 48.4% 44.1%)', 'hsl(0 73.5% 58.6%)',
]
const LOSS = 'hsl(0 73.5% 50%)'
const GAIN = 'hsl(152 60% 30%)'
const INK = '#111'
const MUTED = '#666'
const RULE = '#e5e5e5'

// ---------------------------------------------------------------------------------------------
// Static SVG charts
// ---------------------------------------------------------------------------------------------

const CHART_WIDTH = 680
const LABEL_WIDTH = 170
const VALUE_WIDTH = 90
const ROW = 22

function legend(names: string[]): string {
  return `<div class="legend">${names.map((n, i) =>
    `<span><i style="background:${SERIES[i] ?? MUTED}"></i>${esc(n)}</span>`).join('')}</div>`
}

/** Horizontal bars, one per point; with a series each bar is the stack of its parts. */
export function barSvg(block: CustomBlock, currency: string): string {
  const points = block.points ?? []
  const names = block.series ?? []
  const plot = CHART_WIDTH - LABEL_WIDTH - VALUE_WIDTH
  const totals = points.map(p => (!names.length ? Math.abs(p.value)
    : block.stack === 'grouped' ? Math.max(0, ...(p.values ?? []))
    : (p.values ?? []).reduce((s, v) => s + Math.max(0, v), 0)))
  const max = Math.max(0, ...totals)
  const scale = (v: number) => (max > 0 ? (Math.max(0, v) / max) * plot : 0)
  const height = points.length * ROW + 4
  const rows = points.map((p, i) => {
    const y = i * ROW + 4
    const label = p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label
    let bars = ''
    if (names.length && block.stack === 'grouped') {
      const h = (ROW - 6) / names.length
      ;(p.values ?? []).forEach((v, j) => {
        bars += `<rect x="${LABEL_WIDTH}" y="${(y + 3 + j * h).toFixed(1)}" width="${scale(v).toFixed(1)}" height="${Math.max(1, h - 1).toFixed(1)}" fill="${SERIES[j] ?? MUTED}"/>`
      })
    } else if (names.length) {
      let x = LABEL_WIDTH
      ;(p.values ?? []).forEach((v, j) => {
        const w = scale(v)
        if (w > 0) bars += `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${ROW - 8}" fill="${SERIES[j] ?? MUTED}"/>`
        x += w
      })
    } else {
      bars = `<rect x="${LABEL_WIDTH}" y="${y + 3}" width="${scale(Math.abs(p.value)).toFixed(1)}" height="${ROW - 8}" rx="2" fill="${p.value < 0 ? LOSS : SERIES[0]}"/>`
    }
    return `<text x="0" y="${y + ROW / 2 + 3}" font-size="10" fill="${INK}">${esc(label)}</text>${bars}` +
      `<text x="${CHART_WIDTH}" y="${y + ROW / 2 + 3}" font-size="10" fill="${INK}" text-anchor="end" style="font-variant-numeric:tabular-nums">${esc(formatFigure(p.value, block.format, currency))}</text>`
  }).join('')
  return `${names.length ? legend(names) : ''}<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${height}" viewBox="0 0 ${CHART_WIDTH} ${height}" font-family="${esc(PDF_SANS)}">${rows}</svg>`
}

/** A line per series (or one line), oldest first, with a value axis and the first and last labels. */
export function lineSvg(block: CustomBlock, currency: string, area = false): string {
  const points = block.points ?? []
  const names = block.series ?? []
  const series: number[][] = names.length
    ? names.map((_, j) => points.map(p => p.values?.[j] ?? 0))
    : [points.map(p => p.value)]
  const all = series.flat()
  let lo = Math.min(0, ...all)
  let hi = Math.max(0, ...all)
  if (hi === lo) hi = lo + 1
  const pad = { top: 10, right: 12, bottom: 22, left: 64 }
  const height = 220
  const w = CHART_WIDTH - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const x = (i: number) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * w : w / 2)
  const y = (v: number) => pad.top + h - ((v - lo) / (hi - lo)) * h
  const gridOf = () => [0, 1, 2, 3, 4].map(k => lo + ((hi - lo) * k) / 4).map(t =>
    `<line x1="${pad.left}" x2="${CHART_WIDTH - pad.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${RULE}"/>` +
    `<text x="${pad.left - 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" fill="${MUTED}" text-anchor="end">${esc(compact(t, block.format, currency))}</text>`).join('')
  // An area with a series stacks: each band sits on the running total of the ones before it.
  const stacked = area && series.length > 1
  if (stacked) {
    const tops = points.map((_, i) => series.reduce((sum, vals) => sum + vals[i], 0))
    hi = Math.max(hi, ...tops)
  }
  const floor = series[0].map(() => 0)
  const lines = series.map((vals, j) => {
    const base = stacked ? floor.slice() : series[0].map(() => Math.max(lo, 0))
    const top = stacked ? vals.map((v, i) => floor[i] + v) : vals
    const d = top.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
    if (stacked) top.forEach((v, i) => { floor[i] = v })
    if (!area) return `<path d="${d}" fill="none" stroke="${SERIES[j] ?? MUTED}" stroke-width="2"/>`
    const back = base.map((v, i) => `L${x(base.length - 1 - i).toFixed(1)},${y(base[base.length - 1 - i]).toFixed(1)}`).join('')
    return `<path d="${d}${back}Z" fill="${SERIES[j] ?? MUTED}" fill-opacity="${stacked ? 0.6 : 0.2}" stroke="none"/>` +
      `<path d="${d}" fill="none" stroke="${SERIES[j] ?? MUTED}" stroke-width="2"/>`
  }).join('')
  const step = Math.max(1, Math.ceil(points.length / 8))
  const labels = points.map((p, i) => (i % step === 0 || i === points.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${height - 6}" font-size="9" fill="${MUTED}" text-anchor="middle">${esc(p.label)}</text>` : '').join('')
  return `${names.length ? legend(names) : ''}<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${height}" viewBox="0 0 ${CHART_WIDTH} ${height}" font-family="${esc(PDF_SANS)}">${gridOf()}${lines}${labels}</svg>`
}

/** Vertical axes shared by the column, combo and waterfall charts. */
function frame(lo: number, hi: number, format: CustomValueFormat | undefined, currency: string, right?: { lo: number; hi: number; format: CustomValueFormat | undefined }) {
  const pad = { top: 10, right: right ? 64 : 12, bottom: 34, left: 64 }
  const height = 240
  const w = CHART_WIDTH - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  if (hi === lo) hi = lo + 1
  const y = (v: number) => pad.top + h - ((v - lo) / (hi - lo)) * h
  const r = right && (right.hi === right.lo ? { ...right, hi: right.lo + 1 } : right)
  const y2 = (v: number) => (r ? pad.top + h - ((v - r.lo) / (r.hi - r.lo)) * h : 0)
  const grid = [0, 1, 2, 3, 4].map(k => {
    const t = lo + ((hi - lo) * k) / 4
    const t2 = r ? r.lo + ((r.hi - r.lo) * k) / 4 : 0
    return `<line x1="${pad.left}" x2="${CHART_WIDTH - pad.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${RULE}"/>` +
      `<text x="${pad.left - 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" fill="${MUTED}" text-anchor="end">${esc(compact(t, format, currency))}</text>` +
      (r ? `<text x="${CHART_WIDTH - pad.right + 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" fill="${MUTED}">${esc(compact(t2, r.format, currency))}</text>` : '')
  }).join('')
  return { pad, height, w, h, y, y2, grid }
}

const svgOpen = (height: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${height}" viewBox="0 0 ${CHART_WIDTH} ${height}" font-family="${esc(PDF_SANS)}">`
const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function categoryLabels(labels: string[], x: (i: number) => number, baseline: number): string {
  const step = Math.max(1, Math.ceil(labels.length / 12))
  return labels.map((l, i) => (i % step === 0 ? `<text x="${x(i).toFixed(1)}" y="${baseline}" font-size="9" fill="${MUTED}" text-anchor="middle">${esc(short(l))}</text>` : '')).join('')
}

/** Vertical bars; with a series, stacked or side by side. */
export function columnSvg(block: CustomBlock, currency: string): string {
  const points = block.points ?? []
  const names = block.series ?? []
  const grouped = names.length > 0 && block.stack === 'grouped'
  const vals = (p: (typeof points)[number]) => (names.length ? names.map((_, i) => p.values?.[i] ?? 0) : [p.value])
  const extent = points.flatMap(p => (grouped || !names.length ? vals(p) : [vals(p).reduce((s, v) => s + Math.max(0, v), 0), vals(p).reduce((s, v) => s + Math.min(0, v), 0)]))
  const f = frame(Math.min(0, ...extent), Math.max(0, ...extent), block.format, currency)
  const band = f.w / Math.max(1, points.length)
  const bw = band * 0.7
  const x = (i: number) => f.pad.left + band * i + band / 2
  const bars = points.map((p, i) => {
    const v = vals(p)
    if (grouped) {
      const each = bw / v.length
      return v.map((n, j) => `<rect x="${(x(i) - bw / 2 + j * each).toFixed(1)}" y="${Math.min(f.y(n), f.y(0)).toFixed(1)}" width="${Math.max(1, each - 1).toFixed(1)}" height="${Math.abs(f.y(n) - f.y(0)).toFixed(1)}" fill="${SERIES[j] ?? MUTED}"/>`).join('')
    }
    let up = 0
    let down = 0
    return v.map((n, j) => {
      const from = n >= 0 ? up : down
      const to = from + n
      if (n >= 0) up = to; else down = to
      const color = names.length ? (SERIES[j] ?? MUTED) : n < 0 ? LOSS : SERIES[0]
      return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(f.y(from), f.y(to)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(f.y(to) - f.y(from)).toFixed(1)}" fill="${color}"/>`
    }).join('')
  }).join('')
  return `${names.length ? legend(names) : ''}${svgOpen(f.height)}${f.grid}${bars}${categoryLabels(points.map(p => p.label), x, f.height - 18)}</svg>`
}

/** Bars of y on the left axis, a line of y2 on the right. */
export function comboSvg(block: CustomBlock, currency: string): string {
  const points = block.points ?? []
  const v1 = points.map(p => p.value)
  const v2 = points.map(p => p.value2 ?? 0)
  const f = frame(Math.min(0, ...v1), Math.max(0, ...v1), block.format, currency, { lo: Math.min(0, ...v2), hi: Math.max(0, ...v2), format: block.format2 })
  const band = f.w / Math.max(1, points.length)
  const x = (i: number) => f.pad.left + band * i + band / 2
  const bars = v1.map((n, i) => `<rect x="${(x(i) - band * 0.35).toFixed(1)}" y="${Math.min(f.y(n), f.y(0)).toFixed(1)}" width="${(band * 0.7).toFixed(1)}" height="${Math.abs(f.y(n) - f.y(0)).toFixed(1)}" fill="${SERIES[0]}"/>`).join('')
  const d = v2.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${f.y2(n).toFixed(1)}`).join('')
  return `${legend([block.label, block.label2 ?? 'Line'])}${svgOpen(f.height)}${f.grid}${bars}<path d="${d}" fill="none" stroke="${SERIES[1]}" stroke-width="2"/>${categoryLabels(points.map(p => p.label), x, f.height - 18)}</svg>`
}

/** Each step floats from the running total; the last bar is the total. */
export function waterfallSvg(block: CustomBlock, currency: string): string {
  const steps: { label: string; from: number; to: number; kind: 'up' | 'down' | 'total' }[] = []
  let running = 0
  for (const p of block.points ?? []) {
    steps.push({ label: p.label, from: running, to: running + p.value, kind: p.value < 0 ? 'down' : 'up' })
    running += p.value
  }
  if (block.total !== false) steps.push({ label: 'Total', from: 0, to: running, kind: 'total' })
  const all = steps.flatMap(s => [s.from, s.to])
  const f = frame(Math.min(0, ...all), Math.max(0, ...all), block.format, currency)
  const band = f.w / Math.max(1, steps.length)
  const x = (i: number) => f.pad.left + band * i + band / 2
  const bars = steps.map((s, i) => {
    const color = s.kind === 'total' ? INK : s.kind === 'down' ? LOSS : SERIES[0]
    return `<rect x="${(x(i) - band * 0.35).toFixed(1)}" y="${Math.min(f.y(s.from), f.y(s.to)).toFixed(1)}" width="${(band * 0.7).toFixed(1)}" height="${Math.max(1, Math.abs(f.y(s.to) - f.y(s.from))).toFixed(1)}" fill="${color}"/>`
  }).join('')
  return `${svgOpen(f.height)}${f.grid}${bars}${categoryLabels(steps.map(s => s.label), x, f.height - 18)}</svg>`
}

/** Slices of a disc (or a ring), with a key of names, shares and figures beside it. */
export function pieSvg(block: CustomBlock, currency: string): string {
  const points = (block.points ?? []).filter(p => p.value > 0)
  const total = points.reduce((s, p) => s + p.value, 0)
  const size = 200
  const cx = size / 2
  const r = size / 2 - 4
  const inner = block.donut ? r * 0.58 : 0
  let angle = -Math.PI / 2
  const pt = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cx + rad * Math.sin(a)).toFixed(2)}`
  const slices = points.map((p, i) => {
    const sweep = total > 0 ? (p.value / total) * Math.PI * 2 : 0
    const a0 = angle
    const a1 = angle + Math.min(sweep, Math.PI * 2 - 1e-4)
    angle += sweep
    const large = a1 - a0 > Math.PI ? 1 : 0
    const d = inner > 0
      ? `M${pt(r, a0)}A${r},${r} 0 ${large} 1 ${pt(r, a1)}L${pt(inner, a1)}A${inner},${inner} 0 ${large} 0 ${pt(inner, a0)}Z`
      : `M${cx},${cx}L${pt(r, a0)}A${r},${r} 0 ${large} 1 ${pt(r, a1)}Z`
    return `<path d="${d}" fill="${SERIES[i] ?? MUTED}" stroke="#fff" stroke-width="1"/>`
  }).join('')
  const key = `<table class="key">${points.map((p, i) =>
    `<tr><td><i style="background:${SERIES[i] ?? MUTED}"></i>${esc(p.label)}</td><td class="num muted">${total > 0 ? ((p.value / total) * 100).toFixed(1) : '0.0'}%</td><td class="num">${esc(formatFigure(p.value, block.format, currency))}</td></tr>`).join('')}</table>`
  return `<div class="pie">${`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${slices}</svg>`}${key}</div>`
}

/** One dot per row at (x, y). */
export function scatterSvg(block: CustomBlock, currency: string): string {
  const dots = block.dots ?? []
  const xs = dots.map(d => d.x)
  const ys = dots.map(d => d.y)
  const pad = { top: 10, right: 12, bottom: 26, left: 64 }
  const height = 260
  const w = CHART_WIDTH - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  let [xlo, xhi] = [Math.min(0, ...xs), Math.max(...xs)]
  let [ylo, yhi] = [Math.min(0, ...ys), Math.max(...ys)]
  if (xhi <= xlo) xhi = xlo + 1
  if (yhi <= ylo) yhi = ylo + 1
  const x = (v: number) => pad.left + ((v - xlo) / (xhi - xlo)) * w
  const y = (v: number) => pad.top + h - ((v - ylo) / (yhi - ylo)) * h
  const grid = [0, 1, 2, 3, 4].map(k => {
    const ty = ylo + ((yhi - ylo) * k) / 4
    const tx = xlo + ((xhi - xlo) * k) / 4
    return `<line x1="${pad.left}" x2="${CHART_WIDTH - pad.right}" y1="${y(ty).toFixed(1)}" y2="${y(ty).toFixed(1)}" stroke="${RULE}"/>` +
      `<text x="${pad.left - 6}" y="${(y(ty) + 3).toFixed(1)}" font-size="9" fill="${MUTED}" text-anchor="end">${esc(compact(ty, block.format, currency))}</text>` +
      `<text x="${x(tx).toFixed(1)}" y="${height - 8}" font-size="9" fill="${MUTED}" text-anchor="${k === 4 ? 'end' : k === 0 ? 'start' : 'middle'}">${esc(compact(tx, block.xFormat, currency))}</text>`
  }).join('')
  const marks = dots.map(d => `<circle cx="${x(d.x).toFixed(1)}" cy="${y(d.y).toFixed(1)}" r="3.5" fill="${SERIES[0]}" fill-opacity="0.8"><title>${esc(d.label)}</title></circle>`).join('')
  // With few enough dots, name them, so the printed page can be read without hovering.
  // Names on the right half sit to the left of their dot, so none runs off the page.
  const names = dots.length <= 20 ? dots.map(d => {
    const right = x(d.x) > pad.left + w / 2
    return `<text x="${(x(d.x) + (right ? -6 : 6)).toFixed(1)}" y="${(y(d.y) + 3).toFixed(1)}" font-size="8.5" fill="${INK}" text-anchor="${right ? 'end' : 'start'}">${esc(short(d.label, 20))}</text>`
  }).join('') : ''
  return `${svgOpen(height)}${grid}${marks}${names}</svg>`
}

/** Stages as centred bars, each with its figure and its share of the first stage. */
export function funnelSvg(block: CustomBlock, currency: string): string {
  const points = block.points ?? []
  const max = Math.max(0, ...points.map(p => p.value))
  const first = points[0]?.value ?? 0
  const plot = CHART_WIDTH - LABEL_WIDTH - VALUE_WIDTH - 40
  const height = points.length * 26 + 4
  const rows = points.map((p, i) => {
    const y = i * 26 + 4
    const w = max > 0 ? Math.max(2, (Math.max(0, p.value) / max) * plot) : 0
    const share = i > 0 && first > 0 ? ` (${((p.value / first) * 100).toFixed(0)}%)` : ''
    return `<text x="0" y="${y + 14}" font-size="10" fill="${INK}">${esc(short(p.label, 28))}</text>` +
      `<rect x="${(LABEL_WIDTH + (plot - w) / 2).toFixed(1)}" y="${y + 2}" width="${w.toFixed(1)}" height="18" rx="2" fill="${SERIES[0]}" fill-opacity="${(1 - Math.min(i, 6) * 0.1).toFixed(2)}"/>` +
      `<text x="${CHART_WIDTH}" y="${y + 14}" font-size="10" fill="${INK}" text-anchor="end" style="font-variant-numeric:tabular-nums">${esc(formatFigure(p.value, block.format, currency) + share)}</text>`
  }).join('')
  return `${svgOpen(height)}${rows}</svg>`
}

// ---------------------------------------------------------------------------------------------
// PDF (as HTML for headless Chromium)
// ---------------------------------------------------------------------------------------------

function tableHtml(block: CustomBlock, currency: string): string {
  const columns = block.columns ?? []
  const rows = block.rows ?? []
  if (rows.length === 0) return '<p class="muted">No rows.</p>'
  const numeric = (f: CustomValueFormat) => f === 'currency' || f === 'number' || f === 'percent' || f === 'multiple'
  const ranges = Object.fromEntries(columns.filter(c => c.tone === 'scale').map(c => [c.key, maxMagnitude(rows.map(r => r[c.key]))]))
  const td = (c: (typeof columns)[number], v: unknown) => {
    const sign = c.tone === 'sign' ? signOf(v) : null
    const shade = c.tone === 'scale' ? shadeOf(v, ranges[c.key] ?? 0) : null
    const style = [sign ? `color:${sign === 'gain' ? GAIN : LOSS}` : '', shade ? `background:${shadeFill(shade)}` : ''].filter(Boolean).join(';')
    return `<td class="${numeric(c.format) ? 'num' : ''}"${style ? ` style="${style}"` : ''}>${esc(formatFigure(v as never, c.format, currency))}</td>`
  }
  const subRow = (i: number) => {
    const st = block.subtotals?.find(x => x.after === i)
    if (!st) return ''
    return `<tr class="subtotal">${columns.map((c, j) => `<td class="${numeric(c.format) ? 'num' : ''}">${esc(st.values[c.key] != null ? formatFigure(st.values[c.key], c.format, currency) : j === 0 ? `${st.label} subtotal` : '')}</td>`).join('')}</tr>`
  }
  return `<table><thead><tr>${columns.map(c => `<th class="${numeric(c.format) ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r, i) => `<tr>${columns.map(c => td(c, r[c.key])).join('')}</tr>${subRow(i)}`).join('')
  }${block.totalsRow ? `<tr class="total">${columns.map((c, j) => {
    const v = block.totalsRow![c.key]
    return `<td class="${numeric(c.format) ? 'num' : ''}">${esc(v != null ? formatFigure(v, c.format, currency) : j === 0 ? 'Total' : '')}</td>`
  }).join('')}</tr>` : ''}</tbody></table>${block.truncated ? '<p class="muted">Showing the first rows only.</p>' : ''}`
}

/** A shade on paper: the first series colour for gains, red for losses, at the shade's alpha. */
function shadeFill(sh: { strength: number; negative: boolean }): string {
  return sh.negative ? `hsla(0, 73.5%, 50%, ${shadeAlpha(sh).toFixed(2)})` : `hsla(213, 67.7%, 50.2%, ${shadeAlpha(sh).toFixed(2)})`
}

export function gaugeSvg(block: CustomBlock, currency: string): string {
  const share = gaugeShare(typeof block.value === 'number' ? block.value : null, block.gaugeMax)
  const t = block.target !== undefined ? gaugeShare(block.target, block.gaugeMax) : null
  const tick = t !== null ? [gaugePoint(t, 60, 58, 40), gaugePoint(t, 60, 58, 54)] : null
  return `<svg viewBox="0 0 120 64" width="150" height="80"><path d="${gaugeArc(1, 60, 58, 47)}" fill="none" stroke="${RULE}" stroke-width="10"/>${
    share ? `<path d="${gaugeArc(share, 60, 58, 47)}" fill="none" stroke="${SERIES[0]}" stroke-width="10"/>` : ''}${
    tick ? `<line x1="${tick[0].x.toFixed(1)}" y1="${tick[0].y.toFixed(1)}" x2="${tick[1].x.toFixed(1)}" y2="${tick[1].y.toFixed(1)}" stroke="${INK}" stroke-width="2"/>` : ''}</svg>`
    + `<p class="figure">${esc(formatFigure(block.value ?? null, block.format, currency))}</p><p class="muted">of ${esc(formatFigure(block.gaugeMax ?? null, block.format, currency))}${block.target !== undefined ? ` · target ${esc(formatFigure(block.target, block.format, currency))}` : ''}</p>`
}

function sparkSvg(block: CustomBlock): string {
  const d = block.spark ? sparkPath(block.spark.map(p => p.value), 120, 24) : null
  return d ? `<svg viewBox="0 0 120 24" width="100%" height="24" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${SERIES[0]}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>` : ''
}

function pivotHtml(block: CustomBlock, currency: string): string {
  const p = block.pivot
  if (!p || p.rows.length === 0) return '<p class="muted">No rows.</p>'
  const f = (v: number | null | undefined) => esc(formatFigure(v ?? null, block.format, currency))
  const heat = block.type === 'heatmap' ? maxMagnitude(p.cells.flat()) : 0
  const cellStyle = (v: number | null) => { const sh = heat ? shadeOf(v, heat) : null; return sh ? ` style="background:${shadeFill(sh)}"` : '' }
  const head = `<tr><th>${esc(p.rowLabel)}</th>${p.columns.map(c => `<th class="num">${esc(c)}</th>`).join('')}${p.rowTotals ? '<th class="num">Total</th>' : ''}</tr>`
  const body = p.rows.map((r, i) => `<tr><td>${esc(r)}</td>${p.cells[i].map(v => `<td class="num"${cellStyle(v)}>${f(v)}</td>`).join('')}${p.rowTotals ? `<td class="num strong">${f(p.rowTotals[i])}</td>` : ''}</tr>`).join('')
  const foot = p.columnTotals
    ? `<tr class="total"><td>Total</td>${p.columnTotals.map(v => `<td class="num">${f(v)}</td>`).join('')}${p.rowTotals ? `<td class="num">${f(p.grandTotal)}</td>` : ''}</tr>`
    : ''
  return `<table><thead>${head}</thead><tbody>${body}${foot}</tbody></table>`
}

function blockHtml(block: CustomBlock, currency: string): string {
  if (block.status !== 'ok') {
    return `<section><h2>${esc(block.label || 'Block')}</h2><p class="muted">${esc(block.message ?? 'Not available.')}</p></section>`
  }
  if (block.type === 'text') {
    return `<section>${block.label ? `<h2>${esc(block.label)}</h2>` : ''}${String(block.text ?? '').split(/\n\s*\n/).map(p => `<p>${esc(p)}</p>`).join('')}</section>`
  }
  if (block.type === 'pivot' || block.type === 'heatmap') return `<section><h2>${esc(block.label)}</h2>${pivotHtml(block, currency)}</section>`
  if (block.type === 'gauge') return `<section class="keep gauge"><h2>${esc(block.label)}</h2>${gaugeSvg(block, currency)}</section>`
  if (block.type !== 'kpi' && block.type !== 'table') {
    const empty = block.type === 'scatter' ? (block.dots ?? []).length === 0 : (block.points ?? []).length === 0
    const draw: Record<string, () => string> = {
      bar: () => barSvg(block, currency),
      column: () => columnSvg(block, currency),
      line: () => lineSvg(block, currency),
      area: () => lineSvg(block, currency, true),
      pie: () => pieSvg(block, currency),
      scatter: () => scatterSvg(block, currency),
      combo: () => comboSvg(block, currency),
      waterfall: () => waterfallSvg(block, currency),
      funnel: () => funnelSvg(block, currency),
    }
    const body = empty ? '<p class="muted">Nothing to chart.</p>' : (draw[block.type]?.() ?? '')
    return `<section class="keep"><h2>${esc(block.label)}</h2>${body}</section>`
  }
  if (block.type === 'table') return `<section><h2>${esc(block.label)}</h2>${tableHtml(block, currency)}</section>`
  return ''
}

function deltaHtml(b: CustomBlock, currency: string): string {
  if (!b.previousLabel) return ''
  const d = kpiDelta(b.value, b.previous, b.format, v => formatFigure(v, b.format, currency))
  if (!d) return `<p class="muted">No figure ${esc(b.previousLabel.replace(/^vs /, 'for '))}</p>`
  return `<p class="muted"><span class="${d.direction}">${esc(d.text)}</span> ${esc(b.previousLabel)}</p>`
}

export function viewPdfHtml(payload: CustomViewPayload, meta: ExportMeta): string {
  const currency = payload.branding.currency
  const blocks = payload.data.blocks
  const kpis = blocks.filter(b => b.type === 'kpi')
  const rest = blocks.filter(b => b.type !== 'kpi')
  const tiles = kpis.length === 0 ? '' : `<div class="tiles">${kpis.map(b => b.status === 'ok'
    ? `<div class="tile"><p class="eyebrow">${esc(b.label)}</p><p class="figure">${esc(formatFigure(b.value ?? null, b.format, currency))}</p>${deltaHtml(b, currency)}${b.sub ? `<p class="muted">${esc(b.sub)}</p>` : ''}${sparkSvg(b)}</div>`
    : `<div class="tile"><p class="eyebrow">${esc(b.label)}</p><p class="muted">${esc(b.message ?? 'Not available.')}</p></div>`).join('')}</div>`
  const byline = [payload.branding.fundName, payload.subtitle, `Read ${meta.readAt}`].filter(Boolean).map(esc).join(' · ')
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(meta.displayFont)}
  body { font-family: ${PDF_SANS}; font-size: 11px; color: ${INK}; line-height: 1.4; margin: 0; }
  h1 { font-family: ${PDF_DISPLAY}; font-size: 20px; font-weight: 400; letter-spacing: -0.01em; margin: 0 0 4px; }
  h2 { font-size: 12px; font-weight: 600; margin: 0 0 8px; }
  .byline { color: ${MUTED}; margin: 0 0 4px; }
  .desc { color: #333; margin: 0 0 16px; }
  .muted { color: ${MUTED}; }
  section { margin: 0 0 20px; }
  .keep { break-inside: avoid; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 20px; }
  .tile { border: 1px solid ${RULE}; border-radius: 6px; padding: 8px 10px; break-inside: avoid; }
  .eyebrow { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: ${MUTED}; margin: 0 0 4px; }
  .figure { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; color: ${MUTED}; font-size: 10px; margin: 0 0 6px; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: -0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { font-weight: 600; text-align: left; padding: 4px 6px; border-bottom: 1.5px solid #ccc; color: #555; }
  td { padding: 4px 6px; border-bottom: 1px solid #eee; }
  tr { break-inside: avoid; }
  .pie { display: flex; gap: 24px; align-items: center; }
  .key { width: auto; min-width: 300px; }
  .key td { border: 0; padding: 2px 6px; }
  .key i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .subtotal td { font-weight: 600; background: #f6f6f6; }
  .gauge { text-align: center; } .gauge svg { display: block; margin: 0 auto; } .gauge .figure { margin-top: -6px; }
  .total td { font-weight: 600; border-top: 1.5px solid #ccc; border-bottom: 0; }
  .strong { font-weight: 600; }
  .up { color: ${GAIN}; } .down { color: ${LOSS}; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style></head><body>
  <h1>${esc(payload.title)}</h1>
  <p class="byline">${byline}</p>
  ${payload.data.description ? `<p class="desc">${esc(payload.data.description)}</p>` : '<div style="height:12px"></div>'}
  ${tiles}
  ${rest.map(b => blockHtml(b, currency)).join('\n')}
</body></html>`
}

// ---------------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------------

const XL_FORMAT: Record<CustomValueFormat, string | null> = {
  currency: '#,##0;(#,##0)',
  number: '#,##0.##;(#,##0.##)',
  percent: '0.0%;(0.0%)',
  multiple: '0.00"x"',
  date: 'yyyy-mm-dd',
  text: null,
}

type XlCell = string | number | null | { v: number; z: string }

function xlValue(v: unknown, format: CustomValueFormat | undefined): XlCell {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) {
    const f = format ?? 'number'
    if (f === 'text' || f === 'date') return v
    return { v: f === 'percent' ? v / 100 : v, z: XL_FORMAT[f]! }
  }
  return String(v)
}

function sheetOf(rows: XlCell[][], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && typeof c === 'object' ? c.v : c))))
  rows.forEach((r, ri) => r.forEach((c, ci) => {
    if (c && typeof c === 'object') {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })]
      if (cell) cell.z = c.z
    }
  }))
  ws['!cols'] = widths.map(wch => ({ wch }))
  return ws
}

/** Sheet names: at most 31 characters, none of []:*?/\, unique in the workbook. */
function sheetName(label: string, used: Set<string>): string {
  const base = (label.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Block').slice(0, 28)
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 27 - String(n).length)} (${n})`
  used.add(name.toLowerCase())
  return name
}

export function viewWorkbook(payload: CustomViewPayload, meta: ExportMeta): Buffer {
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  const blocks = payload.data.blocks

  const summary: XlCell[][] = [
    [payload.title],
    ...(payload.branding.fundName ? [[payload.branding.fundName] as XlCell[]] : []),
    ...(payload.subtitle ? [[payload.subtitle] as XlCell[]] : []),
    [`Read ${meta.readAt}`],
    ...(payload.data.description ? [[payload.data.description] as XlCell[]] : []),
    [],
  ]
  const kpis = blocks.filter(b => b.type === 'kpi')
  if (kpis.length) {
    const compared = kpis.some(b => b.previousLabel)
    summary.push(['Figure', 'Value', ...(compared ? ['Compared with', 'Earlier value', 'Change'] : [])])
    for (const b of kpis) {
      const row: XlCell[] = [b.label, b.status === 'ok' ? xlValue(b.value, b.format) : (b.message ?? 'Not available.')]
      if (compared && b.status === 'ok' && b.previousLabel) {
        const now = typeof b.value === 'number' ? b.value : null
        const change = now !== null && b.previous != null ? now - b.previous : null
        // A percent figure changes by points: written as a fraction like the figure, it reads as one.
        row.push(b.previousLabel.replace(/^vs /, ''), xlValue(b.previous ?? null, b.format), xlValue(change, b.format))
      }
      summary.push(row)
    }
    summary.push([])
  }
  const gauges = blocks.filter(b => b.type === 'gauge' && b.status === 'ok')
  if (gauges.length) {
    summary.push(['Gauge', 'Value', 'Of', 'Target'])
    for (const b of gauges) summary.push([b.label, xlValue(b.value, b.format), xlValue(b.gaugeMax ?? null, b.format), xlValue(b.target ?? null, b.format)])
    summary.push([])
  }
  const notes = blocks.filter(b => b.type === 'text' || b.status !== 'ok')
  for (const b of notes.filter(n => n.type !== 'kpi')) {
    summary.push([b.label || 'Note', b.status === 'ok' ? String(b.text ?? '') : (b.message ?? 'Not available.')])
  }
  XLSX.utils.book_append_sheet(wb, sheetOf(summary, [40, 22, 18, 18, 18]), sheetName('View', used))

  for (const b of blocks) {
    if (b.status !== 'ok') continue
    if (b.type === 'scatter') {
      const rows: XlCell[][] = (b.dots ?? []).map(d => [d.label, xlValue(d.x, b.xFormat), xlValue(d.y, b.format)])
      XLSX.utils.book_append_sheet(wb, sheetOf([['Point', 'X', 'Y'], ...rows], [28, 16, 16]), sheetName(b.label, used))
      continue
    }
    if (b.type === 'combo') {
      const rows: XlCell[][] = (b.points ?? []).map(p => [p.label, xlValue(p.value, b.format), xlValue(p.value2 ?? 0, b.format2)])
      XLSX.utils.book_append_sheet(wb, sheetOf([['Item', b.label, b.label2 ?? 'Line'], ...rows], [28, 16, 16]), sheetName(b.label, used))
      continue
    }
    if (b.type === 'waterfall') {
      let running = 0
      const rows: XlCell[][] = (b.points ?? []).map(p => { running += p.value; return [p.label, xlValue(p.value, b.format), xlValue(running, b.format)] })
      if (b.total !== false) rows.push(['Total', null, xlValue(running, b.format)])
      XLSX.utils.book_append_sheet(wb, sheetOf([['Step', 'Change', 'Running total'], ...rows], [28, 16, 16]), sheetName(b.label, used))
      continue
    }
    if (b.type === 'pivot' || b.type === 'heatmap') {
      const p = b.pivot
      if (!p) continue
      const head: XlCell[] = [p.rowLabel, ...p.columns, ...(p.rowTotals ? ['Total'] : [])]
      const rows: XlCell[][] = p.rows.map((r, i) => [r, ...p.cells[i].map(v => xlValue(v, b.format)), ...(p.rowTotals ? [xlValue(p.rowTotals[i], b.format)] : [])])
      if (p.columnTotals) rows.push(['Total', ...p.columnTotals.map(v => xlValue(v, b.format)), ...(p.rowTotals ? [xlValue(p.grandTotal, b.format)] : [])])
      XLSX.utils.book_append_sheet(wb, sheetOf([head, ...rows], [28, ...head.slice(1).map(() => 14)]), sheetName(b.label, used))
      continue
    }
    if (b.type === 'pie') {
      const total = (b.points ?? []).reduce((s, p) => s + p.value, 0)
      const rows: XlCell[][] = (b.points ?? []).map(p => [p.label, xlValue(p.value, b.format), total ? { v: p.value / total, z: XL_FORMAT.percent! } : null])
      XLSX.utils.book_append_sheet(wb, sheetOf([['Slice', b.label, 'Share'], ...rows], [28, 16, 12]), sheetName(b.label, used))
      continue
    }
    if (b.type !== 'kpi' && b.type !== 'gauge' && b.type !== 'table' && b.type !== 'text') {
      const names = b.series ?? []
      const head: XlCell[] = [b.type === 'line' || b.type === 'area' ? 'Period' : 'Item', ...(names.length ? [...names, 'Total'] : [b.label])]
      const rows: XlCell[][] = (b.points ?? []).map(p => [
        p.label,
        ...(names.length ? [...names.map((_, i) => xlValue(p.values?.[i] ?? 0, b.format)), xlValue(p.value, b.format)] : [xlValue(p.value, b.format)]),
      ])
      XLSX.utils.book_append_sheet(wb, sheetOf([head, ...rows], [28, ...head.slice(1).map(() => 16)]), sheetName(b.label, used))
    } else if (b.type === 'table') {
      const columns = b.columns ?? []
      const rows: XlCell[][] = []
      ;(b.rows ?? []).forEach((r, i) => {
        rows.push(columns.map(c => xlValue(r[c.key], c.format)))
        const st = b.subtotals?.find(x => x.after === i)
        if (st) rows.push(columns.map((c, j) => (st.values[c.key] != null ? xlValue(st.values[c.key], c.format) : j === 0 ? `${st.label} subtotal` : null)))
      })
      if (b.totalsRow) rows.push(columns.map((c, j) => (b.totalsRow![c.key] != null ? xlValue(b.totalsRow![c.key], c.format) : j === 0 ? 'Total' : null)))
      XLSX.utils.book_append_sheet(wb, sheetOf([columns.map(c => c.label), ...rows], columns.map(c => (c.format === 'text' ? 28 : 16))), sheetName(b.label, used))
    }
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** A file name from the view's title: "Monday fund view 2026-11-20.pdf". */
export function exportFileName(title: string, date: string, format: ExportFormat): string {
  const base = title.replace(/[^\w\s.-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'View'
  return `${base} ${date}.${format}`
}
