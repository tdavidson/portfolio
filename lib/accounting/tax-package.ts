// The tax package: one ZIP per entity per year with everything a preparer asks for, built from
// pieces the caller has already produced. Pure apart from the zip itself, so the manifest and the
// README can be tested without a database or a browser.
//
// Stateless by decision (plans/plan-accounting-workflow.md): the package is deterministic from
// the ledger as of the closed period, so it is rebuilt on every request and nothing is logged.

import JSZip from 'jszip'

export interface TaxPackageInputs {
  fundName: string
  vehicle: string
  year: number
  /** ISO timestamp. */
  generatedAt: string
  /** Latest closed period end on this vehicle, or null when nothing is closed. */
  closedThrough: string | null
  /** Tie-out warnings from the statement cover — out of balance, unallocated income. */
  warnings: string[]
  workbook: Buffer
  statementsPdf: Buffer | null
  generalLedgerCsv: string
  journalCsv: string
  quickbooksJournalCsv: string
  chartCsv: string
  /** Entries flagged adjusting in the actual book. Null omits the file. */
  adjustingEntriesCsv: string | null
  /** The trial balance on a tax basis — the ledger plus the book-to-tax overlay. Null omits it. */
  taxBasisTrialBalanceCsv?: string | null
  /** Book capital beside tax capital, fund and partner, with the tax-book entries between them. Null omits it. */
  bookTaxBridgeCsv?: string | null
  /** The book-to-tax adjusting entries themselves (the tax book). Null omits it. */
  taxBookEntriesCsv?: string | null
  /** Realized gains by lot for the year — Schedule D / 8949. Null omits it. */
  realizedGainsCsv?: string | null
  /** Cash paid per vendor in the year — the 1099 worksheet. Null omits it. */
  vendorPaymentsCsv?: string | null
  /** The finalised K-1 workbook for the year, when one exists and the caller may see it. */
  k1: { workbook: Buffer; version: number } | null
  /** Why the K-1 workbook is absent, for the README. */
  k1Omitted: string | null
}

export interface TaxPackageFile {
  name: string
  note: string
  content: Buffer | string
}

export function taxPackageFiles(i: TaxPackageInputs): TaxPackageFile[] {
  const y = i.year
  const files: TaxPackageFile[] = [
    { name: `workpapers-${y}.xlsx`, note: 'Trial balance, balance sheet, statement of operations and cash flows with the year, the prior year and a column for each month; partners’ capital, schedule of investments, and general ledger detail. Numeric cells.', content: i.workbook },
  ]
  if (i.statementsPdf) {
    files.push({ name: `statements-${y}.pdf`, note: 'The financial statements as a document, current and prior year side by side.', content: i.statementsPdf })
  }
  files.push(
    { name: `general-ledger-${y}.csv`, note: 'Every account: opening balance carried in, each posting with the accounts on the other side, running balance, closing balance.', content: i.generalLedgerCsv },
    { name: `journal-${y}.csv`, note: 'Every posted entry, one row per line, with debit and credit columns.', content: i.journalCsv },
    { name: `journal-${y}-quickbooks.csv`, note: 'The same journal in the layout of QuickBooks’ Journal report, for loading into QuickBooks or any tool that reads it.', content: i.quickbooksJournalCsv },
  )
  if (i.adjustingEntriesCsv !== null) {
    files.push({ name: `adjusting-entries-${y}.csv`, note: 'Entries flagged as adjusting in the books, listed on their own.', content: i.adjustingEntriesCsv })
  }
  if (i.bookTaxBridgeCsv) {
    files.push({ name: `book-to-tax-bridge-${y}.csv`, note: 'Partners’ capital on the books beside tax-basis capital, for the fund and each partner: beginning, contributions, distributions, income and ending, with the tax-book entries that make up the opening difference and the year’s change, and whatever they leave unexplained.', content: i.bookTaxBridgeCsv })
  }
  if (i.taxBookEntriesCsv) {
    files.push({ name: `book-to-tax-adjustments-${y}.csv`, note: 'The year’s entries in the tax book: unrealized appreciation, carry accrued on unrealized gains, organizational and syndication costs, lower-tier K-1 pass-through, and imported or hand-entered tax-basis entries.', content: i.taxBookEntriesCsv })
  }
  if (i.taxBasisTrialBalanceCsv) {
    files.push({ name: `trial-balance-tax-basis-${y}.csv`, note: 'The trial balance on a tax basis — the ledger plus the book-to-tax adjustments — for Schedule L and M-1.', content: i.taxBasisTrialBalanceCsv })
  }
  if (i.realizedGainsCsv) {
    files.push({ name: `realized-gains-${y}.csv`, note: 'Realized gains by lot: each disposal, the lots it consumed, proceeds, basis, gain, and short- or long-term — the Schedule D / Form 8949 input.', content: i.realizedGainsCsv })
  }
  if (i.vendorPaymentsCsv) {
    files.push({ name: `1099-worksheet-${y}.csv`, note: 'Cash paid per vendor in the year, with 1099 eligibility, whether a TIN is on file, and which rows are reportable.', content: i.vendorPaymentsCsv })
  }
  files.push({ name: 'chart-of-accounts.csv', note: 'The chart: code, name, type, normal side, and the partner or company an account belongs to.', content: i.chartCsv })
  if (i.k1) {
    files.push({ name: `k1-package-${y}-v${i.k1.version}.xlsx`, note: 'The finalised K-1 package: per-partner lines by box, capital account Item L, fund character.', content: i.k1.workbook })
  }
  return files
}

export function buildReadme(i: TaxPackageInputs, files: TaxPackageFile[]): string {
  const lines = [
    `${i.fundName} — ${i.vehicle}`,
    `Tax package for ${i.year}`,
    `Generated ${i.generatedAt}`,
    '',
    `Period: ${i.year}-01-01 to ${i.year}-12-31, with ${i.year - 1} as the comparison column where a report carries one.`,
    i.closedThrough
      ? `Books are closed through ${i.closedThrough}.${i.closedThrough < `${i.year}-12-31` ? ' The rest of the year is open; figures after that date can still change.' : ''}`
      : 'No period has been closed on this vehicle; every figure can still change.',
    'Basis: book. Balance-sheet figures are cumulative to the period end; activity reports cover the period.',
    'Amounts in CSV files are plain numbers to two decimals, debits and credits in separate columns.',
    '',
    'Contents',
    ...files.map(f => `  ${f.name}\n    ${f.note}`),
  ]
  if (i.k1Omitted) lines.push('', `K-1 package not included: ${i.k1Omitted}`)
  if (i.warnings.length > 0) {
    lines.push('', 'Tie-out warnings', ...i.warnings.map(w => `  - ${w}`))
  } else {
    lines.push('', 'No tie-out warnings — the trial balance and balance sheet tie.')
  }
  return lines.join('\n') + '\n'
}

export async function buildTaxPackageZip(i: TaxPackageInputs): Promise<Buffer> {
  const files = taxPackageFiles(i)
  const zip = new JSZip()
  zip.file('README.txt', buildReadme(i, files))
  for (const f of files) zip.file(f.name, f.content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export const taxPackageFileName = (vehicle: string, year: number) =>
  `tax-package-${vehicle}-${year}`.replace(/[^a-zA-Z0-9\-]/g, '-') + '.zip'
