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
