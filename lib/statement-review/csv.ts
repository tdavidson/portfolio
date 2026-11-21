// A partner capital schedule from a CSV: one row per partner, a header naming the columns, and an
// optional total row. Read as written, with no AI: the figures are the package's own.
//
// Period columns (Contributions, Distributions, the allocations) and to-date columns (Paid-in,
// Distributions to date) are told apart by their header. A row whose name reads as a total becomes
// the schedule's stated totals, which the foots check adds the partners up to.

import { parseCsvRows } from '@/lib/admin-reporting/csv'

const HEADERS: Record<string, string[]> = {
  name: ['name', 'partner', 'partner name', 'investor', 'investor name', 'lp', 'lp name', 'limited partner'],
  external_id: ['id', 'partner id', 'partner uuid', 'investor id', 'external id', 'external_id'],
  lp_entity_id: ['lp_entity_id', 'lp entity id'],
  commitment: ['commitment', 'commitments', 'total commitment', 'committed capital', 'capital commitment'],
  beginning: ['beginning', 'beginning capital', 'beginning balance', 'beginning capital balance', 'opening balance', 'opening capital', 'beginning nav'],
  contributions: ['contributions', 'capital contributions', 'contributions this period', 'period contributions'],
  distributions: ['distributions', 'capital distributions', 'distributions this period', 'period distributions'],
  income: ['income', 'investment income', 'interest and dividends', 'dividend and interest income'],
  expenses: ['expenses', 'fund expenses', 'operating expenses', 'partnership expenses'],
  management_fee: ['management fee', 'management fees'],
  realized: ['realized', 'realized gain', 'realized gains', 'realized gain loss', 'net realized gain', 'net realized gain loss'],
  unrealized: ['unrealized', 'unrealized gain', 'unrealized gains', 'unrealized gain loss', 'change in unrealized', 'net change in unrealized', 'net change in unrealized gain loss'],
  carry: ['carry', 'carried interest', 'carried interest allocation'],
  net_allocation: ['net allocation', 'net income', 'net income allocated', 'net income loss', 'total allocation', 'net increase', 'net increase decrease'],
  ending: ['ending', 'ending capital', 'ending balance', 'ending capital balance', 'closing balance', 'closing capital', 'ending nav', 'nav', 'capital account'],
  unfunded: ['unfunded', 'unfunded commitment', 'remaining commitment'],
  paid_in_to_date: ['paid-in', 'paid in', 'paid-in capital', 'paid in capital', 'called capital', 'contributed capital', 'paid-in to date', 'contributions to date', 'cumulative contributions'],
  distributed_to_date: ['distributions to date', 'cumulative distributions', 'total distributions', 'distributed to date'],
}
const FIGURES = Object.keys(HEADERS).filter(k => !['name', 'external_id', 'lp_entity_id'].includes(k))
const ALLOCATION_COLUMNS = ['income', 'expenses', 'management_fee', 'realized', 'unrealized', 'carry']

const key = (s: string) => s.toLowerCase().replace(/[()$:*]/g, '').replace(/\s+/g, ' ').trim()

export interface CsvPackage {
  partners: Record<string, unknown>[]
  /** The total row, shaped as fund.partner_totals. */
  totals: Record<string, unknown> | null
  /** The figure columns found, by field. */
  columns: string[]
}

/** The partners (and the total row) in a CSV, shaped for cleanPackage, or what is wrong with the file. */
export function packageFromCsv(textIn: string, document = 'CSV upload'): CsvPackage | string {
  const rows = parseCsvRows(textIn)
  if (rows.length < 2) return 'The file needs a header row and at least one partner.'
  const rawHeader = rows[0].map(h => h.trim())
  const header = rawHeader.map(key)
  const col: Record<string, number> = {}
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = header.findIndex((h, idx) => names.includes(h) && !Object.values(col).includes(idx))
    if (i >= 0) col[field] = i
  }
  if (col.name === undefined) return 'The header has no column for the partner name (Name, Partner or Investor).'
  const found = FIGURES.filter(f => col[f] !== undefined)
  if (!found.length) {
    return 'The header names no figures. Use columns such as Commitment, Beginning capital, Contributions, Distributions, ' +
      'Income, Expenses, Management fee, Realized gain, Unrealized gain, Carried interest, Ending capital and Unfunded.'
  }

  const partners: Record<string, unknown>[] = []
  let totals: Record<string, unknown> | null = null
  rows.slice(1).forEach((r, idx) => {
    const name = (r[col.name] ?? '').trim()
    if (!name) return
    const rowNo = idx + 2
    const entry: Record<string, unknown> = {}
    const allocations: Record<string, string> = {}
    const cite: Record<string, { document: string; label: string }> = {}
    for (const f of found) {
      const v = (r[col[f]] ?? '').trim()
      if (!v) continue
      const field = f === 'net_allocation' ? 'total' : f
      if (ALLOCATION_COLUMNS.includes(f) || f === 'net_allocation') allocations[field] = v
      else entry[f] = v
      cite[ALLOCATION_COLUMNS.includes(f) || f === 'net_allocation' ? `allocations.${field === 'management_fee' ? 'managementFee' : field}` : f] =
        { document, label: `${rawHeader[col[f]]}, row ${rowNo}` }
    }
    if (Object.keys(allocations).length) entry.allocations = allocations
    entry.cite = cite
    if (/^(grand )?totals?\b/i.test(name)) { totals = entry; return }
    entry.name = name
    const ext = col.external_id !== undefined ? (r[col.external_id] ?? '').trim() : ''
    if (ext) entry.external_id = ext
    const lp = col.lp_entity_id !== undefined ? (r[col.lp_entity_id] ?? '').trim() : ''
    if (lp) entry.lp_entity_id = lp
    partners.push(entry)
  })
  if (!partners.length) return 'The file has no partner rows.'
  return { partners, totals, columns: found }
}
