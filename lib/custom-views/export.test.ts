import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { CustomViewPayload } from '@/lib/mcp-apps/payload'
import { barSvg, exportFileName, formatFigure, lineSvg, viewPdfHtml, viewWorkbook } from './export'
import { readerTimeZone } from './document'

const payload: CustomViewPayload = {
  view: 'custom', title: 'Monday view', subtitle: 'Example Fund I', args: {}, generatedAt: '2026-11-20T18:00:00Z',
  branding: { fundName: 'Example Fund I', currency: 'USD', cssVars: '' },
  data: {
    id: 'v1', url: '/views/v1', description: 'Where the portfolio stands.', params: ['vehicle'], values: {}, vehicles: [],
    blocks: [
      { id: 'fv', type: 'kpi', label: 'Fair value', span: 3, status: 'ok', format: 'currency', value: 1_250_000 },
      { id: 'nav', type: 'kpi', label: 'LP NAV', span: 3, status: 'denied', message: 'Needs access to LP capital.' },
      { id: 'bars', type: 'bar', label: 'By company', span: 6, status: 'ok', format: 'currency', points: [{ label: 'Acme', value: 250_000 }, { label: 'Northwind', value: -50_000 }] },
      {
        id: 'stack', type: 'bar', label: 'By stage', span: 6, status: 'ok', format: 'currency', series: ['Fund I', 'Fund II'],
        points: [{ label: 'Seed', value: 300_000, values: [200_000, 100_000] }],
      },
      { id: 'trend', type: 'line', label: 'NAV by quarter', span: 12, status: 'ok', format: 'currency', points: [{ label: '2026-Q1', value: 100_000 }, { label: '2026-Q2', value: 120_000 }] },
      {
        id: 'tbl', type: 'table', label: 'Positions', span: 12, status: 'ok',
        columns: [{ key: 'company', label: 'Company', format: 'text' }, { key: 'moic', label: 'MOIC', format: 'multiple' }, { key: 'pct', label: 'Share', format: 'percent' }],
        rows: [{ company: 'Acme <script>', moic: 2.5, pct: 62.5 }],
      },
      { id: 'note', type: 'text', label: '', span: 12, status: 'ok', text: 'Live figures.' },
    ],
  },
}

const meta = { readAt: 'Nov 20, 2026, 1:00 PM EST' }

describe('formatFigure', () => {
  it('writes figures the way the page does', () => {
    expect(formatFigure(-1_500, 'currency', 'USD')).toBe('($1,500)')
    expect(formatFigure(12.34, 'percent', 'USD')).toBe('12.3%')
    expect(formatFigure(2.5, 'multiple', 'USD')).toBe('2.50x')
    expect(formatFigure('2026-03-31', 'date', 'USD')).toBe('Mar 31, 2026')
    expect(formatFigure(null, 'number', 'USD')).toBe('—')
  })
})

describe('viewPdfHtml', () => {
  const html = viewPdfHtml(payload, meta)

  it('carries the title, filters, tiles, charts and tables, escaped', () => {
    expect(html).toContain('<h1>Monday view</h1>')
    expect(html).toContain('Example Fund I · Example Fund I · Read Nov 20, 2026, 1:00 PM EST')
    expect(html).toContain('$1,250,000')
    expect(html).toContain('Needs access to LP capital.')
    expect(html.match(/<svg /g)).toHaveLength(3)
    expect(html).toContain('Acme &lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('62.5%')
  })

  it('draws a stacked bar as one segment per series, with a legend', () => {
    const svg = barSvg(payload.data.blocks[3], 'USD')
    expect(svg.match(/<rect /g)).toHaveLength(2)
    expect(svg).toContain('Fund II')
  })

  it('draws a loss in the loss colour and a line per series', () => {
    expect(barSvg(payload.data.blocks[2], 'USD')).toContain('($50,000)')
    const two = lineSvg({ ...payload.data.blocks[4], series: ['A', 'B'], points: [{ label: 'Q1', value: 3, values: [1, 2] }, { label: 'Q2', value: 5, values: [2, 3] }] }, 'USD')
    expect(two.match(/<path /g)).toHaveLength(2)
  })
})

describe('viewWorkbook', () => {
  const wb = XLSX.read(viewWorkbook(payload, meta), { type: 'buffer', cellNF: true })

  it('has a summary sheet and a sheet per chart or table', () => {
    expect(wb.SheetNames).toEqual(['View', 'By company', 'By stage', 'NAV by quarter', 'Positions'])
    const view = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.View, { header: 1 })
    expect(view[0]).toEqual(['Monday view'])
    expect(view).toContainEqual(['Fair value', 1_250_000])
    expect(view).toContainEqual(['LP NAV', 'Needs access to LP capital.'])
  })

  it('writes real numbers with formats, percent as a fraction, and a total per stacked row', () => {
    const stack = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['By stage'], { header: 1 })
    expect(stack).toEqual([['Item', 'Fund I', 'Fund II', 'Total'], ['Seed', 200_000, 100_000, 300_000]])
    expect(wb.Sheets['By stage'].B2.z).toBe('#,##0;(#,##0)')
    expect(wb.Sheets.Positions.C2.v).toBe(0.625)
    expect(wb.Sheets.Positions.C2.z).toBe('0.0%;(0.0%)')
  })
})

describe('file names and time zones', () => {
  it('names the file after the view and the day', () => {
    expect(exportFileName('Monday / view', '2026-11-20', 'pdf')).toBe('Monday view 2026-11-20.pdf')
  })

  it('falls back to UTC for a zone that is not real', () => {
    expect(readerTimeZone('America/New_York')).toBe('America/New_York')
    expect(readerTimeZone('Not/AZone')).toBe('UTC')
    expect(readerTimeZone(undefined)).toBe('UTC')
  })
})

describe('every chart type in the PDF', () => {
  const base = { id: 'c', label: 'C', span: 6, status: 'ok' as const, format: 'currency' as const }
  const points = [{ label: 'A', value: 100 }, { label: 'B', value: -40 }]

  it('draws each type as SVG, and a pie with its key', () => {
    const html = viewPdfHtml({
      ...payload,
      data: {
        ...payload.data,
        blocks: [
          { ...base, id: 'col', type: 'column', points },
          { ...base, id: 'area', type: 'area', points },
          { ...base, id: 'pie', type: 'pie', donut: true, points: [{ label: 'Slice A', value: 75 }, { label: 'Slice B', value: 25 }] },
          { ...base, id: 'sc', type: 'scatter', xFormat: 'number', dots: [{ label: 'Dot A', x: 1, y: 2 }] },
          { ...base, id: 'combo', type: 'combo', label2: 'Line', points: [{ label: 'Q1', value: 10, value2: 20 }] },
          { ...base, id: 'wf', type: 'waterfall', total: true, points },
          { ...base, id: 'fn', type: 'funnel', points: [{ label: 'Top', value: 100 }, { label: 'Bottom', value: 25 }] },
        ],
      },
    }, meta)
    expect(html.match(/<svg /g)).toHaveLength(7)
    expect(html).toContain('75.0%')
    expect(html).toContain('Dot A')
    expect(html).toContain('$25 (25%)')
  })

  it('writes a waterfall\'s running total and a pie\'s shares to Excel', () => {
    const wb = XLSX.read(viewWorkbook({
      ...payload,
      data: { ...payload.data, blocks: [{ ...base, id: 'wf', label: 'Walk', type: 'waterfall', total: true, points }, { ...base, id: 'pie', label: 'Mix', type: 'pie', points: [{ label: 'A', value: 75 }, { label: 'B', value: 25 }] }] },
    }, meta), { type: 'buffer' })
    const walk = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Walk, { header: 1 })
    expect(walk.slice(0, 3)).toEqual([['Step', 'Change', 'Running total'], ['A', 100, 100], ['B', -40, 60]])
    expect([walk[3][0], walk[3][1] ?? null, walk[3][2]]).toEqual(['Total', null, 60])
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Mix, { header: 1 })).toEqual([['Slice', 'Mix', 'Share'], ['A', 75, 0.75], ['B', 25, 0.25]])
  })
})

describe('report features in the exports', () => {
  const blocks: CustomViewPayload['data']['blocks'] = [
    { id: 'k', type: 'kpi', label: 'Fair value', span: 3, status: 'ok', format: 'currency', value: 400_000, previous: 200_000, previousLabel: 'vs Jun 30, 2026' },
    {
      id: 't', type: 'table', label: 'Totals', span: 12, status: 'ok',
      columns: [{ key: 'company', label: 'Company', format: 'text' }, { key: 'fv', label: 'FV', format: 'currency' }],
      rows: [{ company: 'Acme', fv: 250_000 }, { company: 'Northwind', fv: 150_000 }], totalsRow: { company: null, fv: 400_000 },
    },
    {
      id: 'p', type: 'pivot', label: 'Cross', span: 12, status: 'ok', format: 'currency',
      pivot: { rowLabel: 'Status', rows: ['active'], columns: ['Seed', 'Series A'], cells: [[250_000, null]], rowTotals: [250_000], columnTotals: [250_000, 0], grandTotal: 250_000 },
    },
  ]
  const p = { ...payload, data: { ...payload.data, blocks } }

  it('prints the change, the totals row and the pivot', () => {
    const html = viewPdfHtml(p, meta)
    expect(html).toContain('+$200,000 (+100.0%)')
    expect(html).toContain('vs Jun 30, 2026')
    expect(html).toContain('<tr class="total"><td class="">Total</td><td class="num">$400,000</td></tr>')
    expect(html).toContain('<th class="num">Series A</th>')
  })

  it('writes them to Excel as numbers', () => {
    const wb = XLSX.read(viewWorkbook(p, meta), { type: 'buffer' })
    const view = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.View, { header: 1 })
    expect(view).toContainEqual(['Fair value', 400_000, 'Jun 30, 2026', 200_000, 200_000])
    expect(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Totals, { header: 1 }).at(-1)).toEqual(['Total', 400_000])
    const cross = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Cross, { header: 1 })
    expect(cross[0]).toEqual(['Status', 'Seed', 'Series A', 'Total'])
    expect(cross[2]).toEqual(['Total', 250_000, 0, 250_000])
  })
})
