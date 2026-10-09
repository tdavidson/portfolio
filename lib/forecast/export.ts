// CSV of a series: the same periods, rows and totals the table shows, with each period's status
// (actual / actual_unclosed / forecast / mixed) so a spreadsheet can't lose the boundary.

import { toCsv, type CsvCell } from '@/lib/accounting/csv'
import type { SeriesResult, VarianceResponse } from './service'
import type { VarianceCell } from './variance'

export function seriesCsv(s: SeriesResult): string {
  const rows: CsvCell[][] = []
  rows.push(['Vehicle', s.vehicle])
  rows.push(['Plan', s.plan ? `${s.plan.name}${s.version ? ` (version ${s.version.versionNo})` : ' (draft)'}` : 'Actuals'])
  rows.push(['Currency', s.currency])
  rows.push(['Actuals through', s.actualsThrough ?? ''])
  rows.push(['Closed through', s.closedThrough ?? ''])
  rows.push([])
  rows.push(['Code', 'Account', ...s.periods.map(p => p.label)])
  rows.push(['', 'Status', ...s.periods.map(p => p.status)])
  const section = (type: 'income' | 'expense', total: number[], label: string) => {
    for (const l of s.lines.filter(x => x.type === type)) rows.push([l.code, l.name, ...l.values])
    rows.push(['', label, ...total])
  }
  section('income', s.revenue, 'Total revenue')
  section('expense', s.expenses, 'Total expenses')
  rows.push(['', 'Net income', ...s.netIncome])
  rows.push([])
  rows.push(['', 'Opening cash', ...s.cash.map(c => c?.opening ?? null)])
  rows.push(['', 'Net cash movement', ...s.cash.map(c => c?.movement ?? null)])
  rows.push(['', 'Ending cash', ...s.cash.map(c => c?.ending ?? null)])
  if (s.warnings.length) {
    rows.push([])
    for (const w of s.warnings) rows.push(['Note', w])
  }
  return toCsv(rows)
}

/** CSV of a variance: base, compare, difference and percentage per account and period. */
export function varianceCsv(v: VarianceResponse): string {
  const rows: CsvCell[][] = []
  rows.push(['Vehicle', v.vehicle])
  rows.push(['Base', `${v.base.plan?.name ?? ''}${v.base.version ? ` v${v.base.version.versionNo} (${v.base.version.status})` : ' (draft)'}`])
  rows.push(['Compare', v.compare.kind === 'actual' ? 'Actual' : `${v.compare.plan?.name ?? ''}${v.compare.version ? ` v${v.compare.version.versionNo}` : ' (draft)'}`])
  rows.push(['Currency', v.currency])
  rows.push(['Actuals through', v.actualsThrough ?? ''])
  rows.push([])
  const head: CsvCell[] = ['Code', 'Account', 'Measure']
  for (const p of v.periods) head.push(p.partial ? `${p.label} (partial)` : p.label)
  head.push('Total')
  rows.push(head)
  const block = (code: string, name: string, cells: (VarianceCell | null)[], total: VarianceCell | null) => {
    for (const [measure, pick] of [
      ['Base', (c: VarianceCell) => c.base],
      ['Compare', (c: VarianceCell) => c.compare],
      ['Difference', (c: VarianceCell) => c.diff],
    ] as const) {
      rows.push([code, name, measure, ...cells.map(c => (c ? pick(c) : null)), total ? pick(total) : null])
    }
    rows.push([code, name, 'Difference %', ...cells.map(c => pctCell(c)), pctCell(total)])
  }
  for (const l of v.lines) block(l.code, l.name, l.cells, l.total)
  block('', 'Total revenue', v.revenue, v.totals.revenue)
  block('', 'Total expenses', v.expenses, v.totals.expenses)
  block('', 'Net income', v.netIncome, v.totals.netIncome)
  if (v.warnings.length) {
    rows.push([])
    for (const w of v.warnings) rows.push(['Note', w])
  }
  return toCsv(rows)
}

// A percentage is text in the CSV: toCsv prints numbers to two decimals, which would turn 0.4167 into 0.42.
const pctCell = (c: VarianceCell | null): CsvCell => (c?.pct == null ? null : `${(c.pct * 100).toFixed(2)}%`)
