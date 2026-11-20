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
  const totals = points.map(p => (names.length ? (p.values ?? []).reduce((s, v) => s + Math.max(0, v), 0) : Math.abs(p.value)))
  const max = Math.max(0, ...totals)
  const scale = (v: number) => (max > 0 ? (Math.max(0, v) / max) * plot : 0)
  const height = points.length * ROW + 4
  const rows = points.map((p, i) => {
    const y = i * ROW + 4
    const label = p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label
    let bars = ''
    if (names.length) {
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
export function lineSvg(block: CustomBlock, currency: string): string {
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
  const ticks = [0, 1, 2, 3, 4].map(k => lo + ((hi - lo) * k) / 4)
  const grid = ticks.map(t =>
    `<line x1="${pad.left}" x2="${CHART_WIDTH - pad.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${RULE}"/>` +
    `<text x="${pad.left - 6}" y="${(y(t) + 3).toFixed(1)}" font-size="9" fill="${MUTED}" text-anchor="end">${esc(compact(t, block.format, currency))}</text>`).join('')
  const lines = series.map((vals, j) => {
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
    return `<path d="${d}" fill="none" stroke="${SERIES[j] ?? MUTED}" stroke-width="2"/>`
  }).join('')
  const step = Math.max(1, Math.ceil(points.length / 8))
  const labels = points.map((p, i) => (i % step === 0 || i === points.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${height - 6}" font-size="9" fill="${MUTED}" text-anchor="middle">${esc(p.label)}</text>` : '').join('')
  return `${names.length ? legend(names) : ''}<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${height}" viewBox="0 0 ${CHART_WIDTH} ${height}" font-family="${esc(PDF_SANS)}">${grid}${lines}${labels}</svg>`
}

// ---------------------------------------------------------------------------------------------
// PDF (as HTML for headless Chromium)
// ---------------------------------------------------------------------------------------------

function tableHtml(block: CustomBlock, currency: string): string {
  const columns = block.columns ?? []
  const rows = block.rows ?? []
  if (rows.length === 0) return '<p class="muted">No rows.</p>'
  const numeric = (f: CustomValueFormat) => f === 'currency' || f === 'number' || f === 'percent' || f === 'multiple'
  return `<table><thead><tr>${columns.map(c => `<th class="${numeric(c.format) ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${columns.map(c => `<td class="${numeric(c.format) ? 'num' : ''}">${esc(formatFigure(r[c.key], c.format, currency))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>${block.truncated ? '<p class="muted">Showing the first rows only.</p>' : ''}`
}

function blockHtml(block: CustomBlock, currency: string): string {
  if (block.status !== 'ok') {
    return `<section><h2>${esc(block.label || 'Block')}</h2><p class="muted">${esc(block.message ?? 'Not available.')}</p></section>`
  }
  if (block.type === 'text') {
    return `<section>${block.label ? `<h2>${esc(block.label)}</h2>` : ''}${String(block.text ?? '').split(/\n\s*\n/).map(p => `<p>${esc(p)}</p>`).join('')}</section>`
  }
  if (block.type === 'bar' || block.type === 'line') {
    const body = (block.points ?? []).length === 0 ? '<p class="muted">Nothing to chart.</p>'
      : block.type === 'bar' ? barSvg(block, currency) : lineSvg(block, currency)
    return `<section class="keep"><h2>${esc(block.label)}</h2>${body}</section>`
  }
  if (block.type === 'table') return `<section><h2>${esc(block.label)}</h2>${tableHtml(block, currency)}</section>`
  return ''
}

export function viewPdfHtml(payload: CustomViewPayload, meta: ExportMeta): string {
  const currency = payload.branding.currency
  const blocks = payload.data.blocks
  const kpis = blocks.filter(b => b.type === 'kpi')
  const rest = blocks.filter(b => b.type !== 'kpi')
  const tiles = kpis.length === 0 ? '' : `<div class="tiles">${kpis.map(b => b.status === 'ok'
    ? `<div class="tile"><p class="eyebrow">${esc(b.label)}</p><p class="figure">${esc(formatFigure(b.value ?? null, b.format, currency))}</p>${b.sub ? `<p class="muted">${esc(b.sub)}</p>` : ''}</div>`
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
    summary.push(['Figure', 'Value'])
    for (const b of kpis) summary.push([b.label, b.status === 'ok' ? xlValue(b.value, b.format) : (b.message ?? 'Not available.')])
    summary.push([])
  }
  const notes = blocks.filter(b => b.type === 'text' || b.status !== 'ok')
  for (const b of notes.filter(n => n.type !== 'kpi')) {
    summary.push([b.label || 'Note', b.status === 'ok' ? String(b.text ?? '') : (b.message ?? 'Not available.')])
  }
  XLSX.utils.book_append_sheet(wb, sheetOf(summary, [40, 22]), sheetName('View', used))

  for (const b of blocks) {
    if (b.status !== 'ok') continue
    if (b.type === 'bar' || b.type === 'line') {
      const names = b.series ?? []
      const head: XlCell[] = [b.type === 'line' ? 'Period' : 'Item', ...(names.length ? [...names, 'Total'] : [b.label])]
      const rows: XlCell[][] = (b.points ?? []).map(p => [
        p.label,
        ...(names.length ? [...names.map((_, i) => xlValue(p.values?.[i] ?? 0, b.format)), xlValue(p.value, b.format)] : [xlValue(p.value, b.format)]),
      ])
      XLSX.utils.book_append_sheet(wb, sheetOf([head, ...rows], [28, ...head.slice(1).map(() => 16)]), sheetName(b.label, used))
    } else if (b.type === 'table') {
      const columns = b.columns ?? []
      const rows: XlCell[][] = (b.rows ?? []).map(r => columns.map(c => xlValue(r[c.key], c.format)))
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
