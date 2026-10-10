// The K-1 package as a workbook a preparer can open, tie out, and key from.
//
// WHAT THIS IS NOT, said first because the plan promised more than can honestly be delivered:
// it is NOT a native import file for GoSystem, Lacerte or CCH. Those are proprietary layouts,
// versioned per tax year, and producing one without the vendor's own specification would mean
// guessing at column order and calling the guess a format. A file that is nearly right is worse
// than a file that is plainly generic: the preparer trusts it and finds out in April.
//
// So this is a structured export a preparer MAPS into their software once. Every column is
// labelled with both the app's own name and the K-1 box it belongs to, the numbers are real
// numeric cells rather than strings, and the caveats travel with the file rather than living in
// an email nobody keeps.
//
// Pure and testable: it takes a computed package and lays it out. No tax logic here.

import * as XLSX from 'xlsx'
import { K1_BOX, K1_CATEGORIES, K1_SUBSET_OF, type K1Category } from '@/lib/accounting/k1-allocation'
import { TAX_FORM_LABEL, type TaxFormType } from './forms'

const NUM = '#,##0.00;(#,##0.00)'

type Cell = string | number | null
interface FmtCell { v: number; z: string }
type Row = (Cell | FmtCell)[]

function isFmt(c: Cell | FmtCell): c is FmtCell {
  return typeof c === 'object' && c !== null && 'z' in c
}
const money = (v: number): FmtCell => ({ v, z: NUM })

function sheet(rows: Row[], colWidths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (isFmt(c) ? c.v : c))))
  rows.forEach((row, ri) => {
    row.forEach((c, ci) => {
      if (!isFmt(c)) return
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })]
      if (cell) { cell.t = 'n'; cell.z = c.z }
    })
  })
  ws['!cols'] = colWidths.map(wch => ({ wch }))
  return ws
}

function append(wb: XLSX.WorkBook, name: string, ws: XLSX.WorkSheet) {
  XLSX.utils.book_append_sheet(wb, ws, name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31))
}

export interface K1WorkbookPartner {
  lpEntityId: string
  name: string
  /** As it appears on the signed tax form, when that differs from the fund's own record. */
  legalName?: string | null
  formType?: TaxFormType | null
  formStanding?: string | null
  tinType?: string | null
  tinLast4?: string | null
  country?: string | null
  taxClassification?: string | null
  lines: Record<K1Category, number>
  capitalAccount: {
    beginning: number
    contributions: number
    distributions: number
    netIncome: number
    otherChanges?: number
    ending: number
  }
  tieOutVariance: number
  rollForwardVariance: number
}

export interface K1WorkbookInput {
  fundName: string
  vehicle: string
  taxYear: number
  version: number
  status: string
  generatedAt: string
  partners: K1WorkbookPartner[]
  fundCharacter: Record<string, number> | null
  warnings: { kind: string; detail: string; lpEntityId?: string }[]
}

/**
 * Sheet one: what this file is, and what a preparer must not assume about it.
 *
 * The caveats lead rather than trail. A warning at the bottom of the last tab is a warning
 * nobody read, and the things listed here — a line that was never computed, a gain nobody could
 * date, an item L that does not foot — change what the preparer has to do next.
 */
function coverSheet(input: K1WorkbookInput): XLSX.WorkSheet {
  const rows: Row[] = [
    ['Schedule K-1 data'],
    [],
    ['Fund', input.fundName],
    ['Vehicle', input.vehicle],
    ['Tax year', input.taxYear],
    ['Version', input.version],
    ['Status', input.status],
    ['Generated', input.generatedAt],
    ['Partners', input.partners.length],
    [],
    ['READ FIRST'],
    ['This is a structured export, not a native import file for any tax package.'],
    ['Column headers name both the source figure and the K-1 box it belongs to; map them once.'],
    ['Taxpayer identification numbers are NOT in this file — only the last four digits, for'],
    ['matching. The full number is on the signed form held with the fund.'],
    [],
  ]

  if (input.warnings.length > 0) {
    rows.push(['ISSUES ON THIS PACKAGE'], ['Kind', 'Detail'])
    for (const w of input.warnings) rows.push([w.kind, w.detail])
  } else {
    rows.push(['No issues were recorded on this package.'])
  }

  return sheet(rows, [22, 80])
}

/** One row per partner, one column per K-1 line. The sheet a preparer actually keys from. */
function partnerSheet(input: K1WorkbookInput): XLSX.WorkSheet {
  // Subset lines are labelled as such in the header, so nobody adds 6b to 6a or double-counts
  // the §1061 disclosure that is already inside box 8.
  const header: Row = [
    'Partner',
    'Name on form',
    'Form',
    'Form standing',
    'TIN type',
    'TIN last 4',
    'Country',
    'Classification',
    ...K1_CATEGORIES.map(c => {
      const subsetOf = K1_SUBSET_OF[c]
      return subsetOf
        ? `${label(c)} (box ${K1_BOX[c]}, included in box ${K1_BOX[subsetOf]})`
        : `${label(c)} (box ${K1_BOX[c]})`
    }),
  ]

  const rows: Row[] = [header]
  for (const p of input.partners) {
    rows.push([
      p.name,
      p.legalName ?? '',
      p.formType ? TAX_FORM_LABEL[p.formType] : '',
      p.formStanding ?? '',
      p.tinType ?? '',
      p.tinLast4 ?? '',
      p.country ?? '',
      p.taxClassification ?? '',
      ...K1_CATEGORIES.map(c => money(p.lines[c] ?? 0)),
    ])
  }

  // A total row, because the first thing a preparer does is check the columns sum to the fund.
  if (input.partners.length > 0) {
    rows.push([
      'Total',
      '', '', '', '', '', '', '',
      ...K1_CATEGORIES.map(c => money(input.partners.reduce((s, p) => s + (p.lines[c] ?? 0), 0))),
    ])
  }

  return sheet(rows, [28, 28, 16, 14, 10, 10, 10, 18, ...K1_CATEGORIES.map(() => 20)])
}

/** Part II item L, per partner, with both variances beside it. */
function capitalSheet(input: K1WorkbookInput): XLSX.WorkSheet {
  const rows: Row[] = [
    [
      'Partner',
      'Beginning capital',
      'Capital contributed',
      'Withdrawals and distributions',
      'Current year net income (loss)',
      'Other increase (decrease)',
      'Ending capital',
      'Lines vs allocated activity',
      'Roll-forward variance',
    ],
  ]
  for (const p of input.partners) {
    const c = p.capitalAccount
    rows.push([
      p.name,
      money(c.beginning),
      money(c.contributions),
      // Item L shows withdrawals as a negative; the package holds the magnitude.
      money(-Math.abs(c.distributions)),
      money(c.netIncome),
      money(c.otherChanges ?? 0),
      money(c.ending),
      money(p.tieOutVariance),
      money(p.rollForwardVariance),
    ])
  }
  if (input.partners.length > 0) {
    const sum = (f: (p: K1WorkbookPartner) => number) => money(input.partners.reduce((s, p) => s + f(p), 0))
    rows.push([
      'Total',
      sum(p => p.capitalAccount.beginning),
      sum(p => p.capitalAccount.contributions),
      sum(p => -Math.abs(p.capitalAccount.distributions)),
      sum(p => p.capitalAccount.netIncome),
      sum(p => p.capitalAccount.otherChanges ?? 0),
      sum(p => p.capitalAccount.ending),
      sum(p => p.tieOutVariance),
      sum(p => p.rollForwardVariance),
    ])
  }
  return sheet(rows, [28, 20, 20, 28, 28, 24, 20, 26, 22])
}

/** The fund-level character the partner lines were split from — the tie-out target. */
function fundSheet(input: K1WorkbookInput): XLSX.WorkSheet {
  const rows: Row[] = [['Fund character', input.taxYear], []]
  const c = input.fundCharacter
  if (!c) {
    rows.push(['Not recorded on this package.'])
    return sheet(rows, [40, 20])
  }
  rows.push(['Item', 'Amount'])
  for (const [k, v] of Object.entries(c)) {
    if (typeof v !== 'number') continue
    rows.push([labelFundItem(k), money(v)])
  }
  return sheet(rows, [40, 20])
}

export function buildK1Workbook(input: K1WorkbookInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  append(wb, 'Read first', coverSheet(input))
  append(wb, 'K-1 lines', partnerSheet(input))
  append(wb, 'Capital accounts', capitalSheet(input))
  append(wb, 'Fund character', fundSheet(input))
  return wb
}

function label(c: K1Category): string {
  const map: Record<K1Category, string> = {
    interest: 'Interest income',
    ordinaryDividends: 'Ordinary dividends',
    qualifiedDividends: 'Qualified dividends',
    shortTermGain: 'Net short-term capital gain (loss)',
    longTermGain: 'Net long-term capital gain (loss)',
    section1061Recharacterized: '§1061 recharacterized',
    otherIncome: 'Other income (loss)',
    deductions: 'Other deductions',
    distributionsCash: 'Distributions — cash',
    distributionsProperty: 'Distributions — property',
    distributionsOther: 'Distributions — other',
  }
  return map[c]
}

function labelFundItem(k: string): string {
  const map: Record<string, string> = {
    interest: 'Interest income',
    ordinaryDividends: 'Ordinary dividends',
    qualifiedDividends: 'Qualified dividends (included above)',
    shortTermGain: 'Short-term capital gain (loss)',
    longTermGain: 'Long-term capital gain (loss)',
    longTermGainWithinApiPeriod: 'Long-term gain on assets held under three years (included above)',
    otherIncome: 'Other income',
    deductions: 'Deductions',
  }
  return map[k] ?? k
}
