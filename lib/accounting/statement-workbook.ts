// Serializes a computed StatementPackage into a multi-tab .xlsx workpaper.
//
// Pure and unit-testable: takes the same package the Statements page renders and
// lays it out as sheets a tax preparer can open and tie out. No accounting logic
// lives here — every number comes straight from buildStatementPackage. Numbers are
// written as real numeric cells (t:'n') with an accounting format so the CPA can
// sum and pivot them, not re-key them.

import * as XLSX from 'xlsx'
import type { StatementPackage, StatementPayload } from './statement-package'
import { ACTIVITY_FIELDS, type CapitalAccount } from './capital-account'
import { accountRegister } from './register'
import { entryRef } from './journal-export'

/** Accounting format — thousands, two decimals, negatives in parentheses. */
const NUM = '#,##0.00;(#,##0.00)'
/** Percent with two decimals, for SOI % of net assets. */
const PCT = '0.00%'

export interface WorkbookMeta {
  fundName: string
  vehicle: string
  /** ISO timestamp the file was generated (the route supplies it — kept out of pure code). */
  generatedAt: string
}

type Cell = string | number | null
/** A cell carrying a number format hint, so aoa cells can request `NUM`/`PCT`. */
interface FmtCell { v: number; z: string }
type Row = (Cell | FmtCell)[]

function isFmt(c: Cell | FmtCell): c is FmtCell {
  return typeof c === 'object' && c !== null && 'z' in c
}
const money = (v: number): FmtCell => ({ v, z: NUM })
const pct = (v: number): FmtCell => ({ v, z: PCT })

/** Build a worksheet from an array-of-rows, applying number formats and column widths. */
function sheet(rows: Row[], colWidths: number[]): XLSX.WorkSheet {
  const aoa = rows.map(r => r.map(c => (isFmt(c) ? c.v : c)))
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // Re-apply number formats: aoa_to_sheet writes bare numbers, so set `.z` per cell.
  rows.forEach((row, ri) => {
    row.forEach((c, ci) => {
      if (!isFmt(c)) return
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci })
      const cell = ws[addr]
      if (cell) { cell.t = 'n'; cell.z = c.z }
    })
  })
  ws['!cols'] = colWidths.map(wch => ({ wch }))
  return ws
}

function append(wb: XLSX.WorkBook, name: string, ws: XLSX.WorkSheet) {
  // Excel sheet names are capped at 31 chars and can't contain : \ / ? * [ ].
  const safe = name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)
  XLSX.utils.book_append_sheet(wb, ws, safe)
}

// ---------------------------------------------------------------------------

function coverSheet(pkg: StatementPackage, meta: WorkbookMeta): XLSX.WorkSheet {
  const { payload } = pkg
  const warnings: string[] = []
  if (!payload.trialBalance.balanced) {
    warnings.push(`Trial balance out of balance: debits ${payload.trialBalance.totalDebits} vs credits ${payload.trialBalance.totalCredits}.`)
  }
  if (payload.balanceSheet.check !== 0) {
    warnings.push(`Balance sheet does not tie — residual ${payload.balanceSheet.check}.`)
  }
  if (payload.balanceSheet.partnersCapital.unallocatedEarnings !== 0) {
    warnings.push(`${payload.balanceSheet.partnersCapital.unallocatedEarnings} of net income is not yet allocated to partners (period not closed); per-partner capital understates until closed.`)
  }

  const rows: Row[] = [
    [meta.fundName],
    ['Accounting workpapers'],
    [],
    ['Vehicle', meta.vehicle],
    ['Basis', pkg.basis === 'tax' ? 'Tax basis — the ledger plus the book-to-tax adjusting entries' : 'Book — the ledger as kept'],
    ['Period', payload.period.label],
    ['Period start', payload.period.start ?? 'inception'],
    ['Period end (as of)', payload.period.end ?? 'today'],
    ['Generated', meta.generatedAt],
    [],
    ['Balance-sheet basis is cumulative to the period end; the income statement and cash flows'],
    ['cover activity within the period. The GL detail opens each account at the balance carried'],
    ['in at the period start, lists the period’s postings, and closes to the trial balance.'],
    [],
    [warnings.length ? 'Tie-out warnings' : 'No tie-out warnings — statements balance.'],
    ...warnings.map(w => [w]),
  ]
  return sheet(rows, [26, 40])
}

interface Section { label: string; rows: { code: string; name: string; amount: number }[]; total: number }

/**
 * Multi-period version of `sectionRows`: unions rows by `code||name` across every
 * payload (so a line present in only one period still shows, blank elsewhere) and
 * emits one money column per payload. Payloads must be pre-aligned — [primary, ...comparisons].
 */
function sectionRowsMulti(pick: (p: StatementPayload) => Section, payloads: StatementPayload[]): Row[] {
  const keys: { code: string; name: string; key: string }[] = []
  const seen = new Set<string>()
  for (const p of payloads) for (const r of pick(p).rows) {
    const key = r.code || r.name
    if (!seen.has(key)) { seen.add(key); keys.push({ code: r.code, name: r.name, key }) }
  }
  const label = pick(payloads[0]).label
  const out: Row[] = []
  if (keys.length > 0) out.push([label])
  for (const k of keys) {
    const amt = (p: StatementPayload) => pick(p).rows.find(r => (r.code || r.name) === k.key)?.amount
    out.push([k.code, k.name, ...payloads.map(p => { const a = amt(p); return a === undefined ? '' : money(a) })])
  }
  out.push([`Total ${label}`, '', ...payloads.map(p => money(pick(p).total))])
  out.push([])
  return out
}

/**
 * One debit/credit column pair per payload — the prior-year column a preparer expects beside
 * the current one. Accounts are unioned by code across the periods, so an account that had a
 * balance only last year still has a row, blank in the current columns.
 */
function trialBalanceSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  const keys: { code: string; name: string; type: string }[] = []
  const seen = new Set<string>()
  for (const p of payloads) for (const r of p.trialBalance.rows) {
    if (!seen.has(r.code)) { seen.add(r.code); keys.push({ code: r.code, name: r.name, type: r.type }) }
  }
  keys.sort((a, b) => a.code.localeCompare(b.code))
  const multi = payloads.length > 1
  const header: Row = ['Code', 'Account', 'Type', ...payloads.flatMap(p => (multi ? [`Debit ${p.period.label}`, `Credit ${p.period.label}`] : ['Debit', 'Credit']))]
  const rows: Row[] = [header]
  for (const k of keys) {
    rows.push([k.code, k.name, k.type, ...payloads.flatMap((p): Row => {
      const r = p.trialBalance.rows.find(x => x.code === k.code)
      return r ? [money(r.debit), money(r.credit)] : ['', '']
    })])
  }
  rows.push(['', 'Totals', '', ...payloads.flatMap(p => [money(p.trialBalance.totalDebits), money(p.trialBalance.totalCredits)])])
  return sheet(rows, [10, 34, 12, ...payloads.flatMap(() => [16, 16])])
}

/** Header row of period labels, aligned under the money columns (after code+name). */
function periodHeader(payloads: StatementPayload[]): Row {
  return ['', '', ...payloads.map(p => p.period.label)]
}

/** The equity's name, as the payload carries it — partners', members' or owner's. */
const equityLabelOf = (p: StatementPayload) => p.balanceSheet.equity.label || 'Partners’ capital'

function balanceSheetSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  const label = equityLabelOf(payloads[0])
  const rows: Row[] = [[`Statement of assets, liabilities and ${label.toLowerCase()}`], [], periodHeader(payloads)]
  rows.push(...sectionRowsMulti(p => p.balanceSheet.assets, payloads))
  rows.push(...sectionRowsMulti(p => p.balanceSheet.liabilities, payloads))
  // Equity is a single total line — per-partner detail is its own sheet. Books that keep retained
  // earnings list it account by account instead, with the current year's net income on its own row.
  if (payloads.some(p => p.balanceSheet.equity.rows.length > 0)) rows.push(...sectionRowsMulti(p => p.balanceSheet.equity, payloads))
  else rows.push([label, '', ...payloads.map(p => money(p.balanceSheet.equity.total))], [])
  return sheet(rows, [10, 34, ...payloads.map(() => 16)])
}

function incomeStatementSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  const rows: Row[] = [['Statement of operations'], [], periodHeader(payloads)]
  rows.push(...sectionRowsMulti(p => p.incomeStatement.income, payloads))
  rows.push(...sectionRowsMulti(p => p.incomeStatement.expenses, payloads))
  rows.push(['Net income', '', ...payloads.map(p => money(p.incomeStatement.netIncome))])
  return sheet(rows, [10, 34, ...payloads.map(() => 16)])
}

const CAP_FIELDS: (keyof CapitalAccount)[] = ['beginning', ...ACTIVITY_FIELDS, 'ending']
const CAP_LABELS: Record<string, string> = {
  beginning: 'Beginning', contributions: 'Contributions', distributions: 'Distributions',
  managementFees: 'Mgmt fees', expenses: 'Partnership exp.', operatingIncome: 'Operating income',
  realizedGains: 'Net realized G/(L)', unrealizedGains: 'Net unrealized G/(L)',
  fxTranslation: 'FX translation', transfers: 'Transfers', carriedInterest: 'Carry accrued',
  unclassified: 'Unclassified', ending: 'Ending',
}

const holderWord = (p: StatementPayload) => (equityLabelOf(p) === "Members' capital" ? 'Member' : 'Partner')

function capitalSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  if (payloads.length === 1) {
    const c = payloads[0].changesInPartnersCapital
    const header: Row = [holderWord(payloads[0]), ...CAP_FIELDS.map(f => CAP_LABELS[f] ?? f)]
    const rows: Row[] = [[`Statement of changes in ${equityLabelOf(payloads[0]).toLowerCase()}`], [], header]
    for (const p of c.partners) rows.push([p.name, ...CAP_FIELDS.map(f => money(p[f] as number))])
    rows.push(['Total', ...CAP_FIELDS.map(f => money(c.totals[f] as number))])
    return sheet(rows, [28, ...CAP_FIELDS.map(() => 16)])
  }
  // Multi-period: detail collapses to a partner × period ending-capital matrix — the
  // per-source roll-forward columns don't compose across periods the way ending balances do.
  const partnerRows: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const p of payloads) for (const partner of p.changesInPartnersCapital.partners) {
    if (!seen.has(partner.id)) { seen.add(partner.id); partnerRows.push({ id: partner.id, name: partner.name }) }
  }
  const header: Row = [holderWord(payloads[0]), ...payloads.map(p => p.period.label)]
  const rows: Row[] = [[`Statement of changes in ${equityLabelOf(payloads[0]).toLowerCase()}`], [], header]
  for (const { id, name } of partnerRows) {
    rows.push([name, ...payloads.map(p => {
      const partner = p.changesInPartnersCapital.partners.find(pp => pp.id === id)
      return partner ? money(partner.ending) : ''
    })])
  }
  rows.push(['Total', ...payloads.map(p => money(p.changesInPartnersCapital.totals.ending))])
  return sheet(rows, [28, ...payloads.map(() => 16)])
}

/**
 * Cost and fair value per position, one column pair per payload; the % of net assets and the
 * industry/geography/asset-type subtotals are the primary period's — a schedule of investments
 * is struck at a date, and the comparison columns are there to show the marks moving.
 */
function soiSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  const soi = payloads[0].scheduleOfInvestments
  const multi = payloads.length > 1
  const names: string[] = []
  const seen = new Set<string>()
  for (const p of payloads) for (const r of p.scheduleOfInvestments.rows) {
    if (!seen.has(r.name)) { seen.add(r.name); names.push(r.name) }
  }
  const valueCols = payloads.flatMap(p => (multi ? [`Cost ${p.period.label}`, `Fair value ${p.period.label}`] : ['Cost', 'Fair value']))
  const rows: Row[] = [
    ['Schedule of investments'], [],
    ['Investment', 'Industry', 'Country', ...valueCols, '% of net assets'],
  ]
  for (const name of names) {
    const primary = soi.rows.find(r => r.name === name)
    rows.push([
      name, primary?.industry ?? '', primary?.country ?? '',
      ...payloads.flatMap((p): Row => {
        const r = p.scheduleOfInvestments.rows.find(x => x.name === name)
        return r ? [money(r.cost), money(r.fairValue)] : ['', '']
      }),
      primary ? pct(primary.pctOfNetAssets) : '',
    ])
  }
  rows.push([
    'Total investments', '', '',
    ...payloads.flatMap(p => [money(p.scheduleOfInvestments.totalCost), money(p.scheduleOfInvestments.totalFairValue)]),
    pct(soi.netAssets ? soi.totalFairValue / soi.netAssets : 0),
  ])
  rows.push([], ['Net assets', '', '', ...payloads.flatMap((p): Row => ['', money(p.scheduleOfInvestments.netAssets)])])

  const group = (title: string, groups: { name: string; cost: number; fairValue: number; pctOfNetAssets: number }[]) => {
    if (groups.length === 0) return
    rows.push([], [title])
    for (const g of groups) rows.push([g.name, '', '', money(g.cost), money(g.fairValue), pct(g.pctOfNetAssets)])
  }
  group('By industry', soi.byIndustry)
  group('By geography', soi.byGeography)
  group('By asset type', soi.byAssetType)
  return sheet(rows, [30, 18, 14, ...valueCols.map(() => 16), 16])
}

/** Adapts one cash-flow section (operating/financing — `lines`, not `rows`) to the shared `Section` shape. */
function cfSection(cf: NonNullable<StatementPayload['cashFlows']>, which: 'operating' | 'financing'): Section {
  const s = cf[which]
  return { label: s.label, rows: s.lines, total: s.total }
}

function cashFlowSheet(payloads: StatementPayload[]): XLSX.WorkSheet {
  const primary = payloads[0]
  if (!primary.cashFlows) return sheet([['Statement of cash flows'], [], ['No cash account on this vehicle.']], [30, 16])
  // Comparison periods on a vehicle without a cash account (shouldn't happen in practice,
  // since the cash account is a vehicle property) are dropped rather than breaking column alignment.
  const withCf = payloads.filter((p): p is StatementPayload & { cashFlows: NonNullable<StatementPayload['cashFlows']> } => !!p.cashFlows)
  const rows: Row[] = [['Statement of cash flows'], [], periodHeader(withCf)]
  rows.push(...sectionRowsMulti(p => cfSection(p.cashFlows!, 'operating'), withCf))
  rows.push(...sectionRowsMulti(p => cfSection(p.cashFlows!, 'financing'), withCf))
  rows.push(['Net change in cash', '', ...withCf.map(p => money(p.cashFlows!.netChange))])
  rows.push(['Opening cash', '', ...withCf.map(p => money(p.cashFlows!.openingCash))])
  rows.push(['Ending cash', '', ...withCf.map(p => money(p.cashFlows!.endingCash))])
  // Non-cash supplemental disclosure is a narrative list, not a comparable figure — primary period only.
  if (primary.cashFlows.nonCash.length > 0) {
    rows.push([], ['Supplemental — non-cash investing and financing activities'])
    rows.push(['Date', 'Description', 'Amount'])
    for (const n of primary.cashFlows.nonCash) rows.push([n.date ?? '', n.description, money(n.amount)])
  }
  return sheet(rows, [12, 34, ...withCf.map(() => 16)])
}

/**
 * The general ledger: every account's register for the period (lib/accounting/register.ts).
 * Each account opens at the balance carried in, lists its postings with the accounts on the
 * other side, runs the balance forward in the account's normal side, and closes at a figure that
 * equals its trial-balance row — the roll a preparer does by hand when the file lacks it.
 *
 * Built from the WHOLE posted ledger when the package carries it (`allSourced`); a package
 * assembled without it opens every account at zero, which is the old activity-only sheet.
 */
function glDetailSheet(pkg: StatementPackage): XLSX.WorkSheet {
  const { accounts, payload } = pkg
  const all = pkg.allSourced ?? pkg.inPeriodSourced
  const byId = new Map(accounts.map(a => [a.id, a]))
  const period = payload.period

  const rows: Row[] = [
    ['General ledger detail'],
    [`${period.start ? `From ${period.start}` : 'From inception'} to ${period.end ?? 'today'}. Opening is the balance carried in at the period start; Balance runs in the account’s normal side and closes to the trial balance.`],
    [],
    ['Account', 'Date', 'Entry', 'Source', 'Memo', 'Against', 'Debit', 'Credit', 'Balance'],
  ]
  for (const acct of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    const reg = accountRegister(acct, all, byId, period)
    if (reg.opening === 0 && reg.lines.length === 0) continue
    rows.push([`${acct.code} · ${acct.name}`, period.start ?? '', '', '', 'Opening balance', '', '', '', money(reg.opening)])
    for (const l of reg.lines) {
      rows.push([
        '', l.entryDate ?? '', entryRef(l.entryId), l.sourceType ?? '', l.memo ?? '',
        l.counterAccounts.map(c => c.code).join(' '),
        money(l.debit), money(l.credit), money(l.running),
      ])
    }
    rows.push(['', period.end ?? '', '', '', `Closing balance ${acct.code}`, '', money(reg.totals.debit), money(reg.totals.credit), money(reg.closing)])
  }
  return sheet(rows, [30, 12, 10, 16, 40, 18, 16, 16, 16])
}

/** Build the full workpaper workbook from a computed package. */
export function buildStatementWorkbook(pkg: StatementPackage, meta: WorkbookMeta): XLSX.WorkBook {
  // [primary, ...comparisons] — the columnized sheets get one money column per payload.
  // With no ?compare= this is a single-element array and every sheet keeps today's shape.
  const payloads: StatementPayload[] = [pkg.payload, ...(pkg.comparisons ?? [])]
  const wb = XLSX.utils.book_new()
  append(wb, 'Cover', coverSheet(pkg, meta))
  append(wb, 'Trial Balance', trialBalanceSheet(payloads))
  append(wb, 'Balance Sheet', balanceSheetSheet(payloads))
  append(wb, 'Income Statement', incomeStatementSheet(payloads))
  append(wb, 'Partners Capital', capitalSheet(payloads))
  append(wb, 'Schedule of Investments', soiSheet(payloads))
  append(wb, 'Cash Flows', cashFlowSheet(payloads))
  append(wb, 'GL Detail', glDetailSheet(pkg))
  return wb
}
