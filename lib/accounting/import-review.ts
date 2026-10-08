import { cashCapitalSource } from './cash-capital-source'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger } from './load'
import { loadPositions } from './lp-positions'
import { buildSoiPositions, txnsForVehicle } from './soi'
import { computeCapitalAccounts } from './capital-account'
import { scheduleOfInvestments } from './statements'
import { roundCents } from './ledger'
import { readInvestmentLines } from './adopt'
import type { ChartAccount } from './investment-accounts'
import type { JournalEntry, Account } from './types'
import type { ParsedTxn } from './bank'

export interface ImportDifference {
  domain: 'investment' | 'lp'
  name: string
  date: string
  metric: string
  recorded: number | null
  imported: number | null
  difference: number | null
  message: string
}
export interface ImportReview {
  token: string
  checked: { investments: number; lpPositions: number; lpComparisonAvailable?: boolean }
  differences: ImportDifference[]
}

/** A read-only, dated comparison. Imported records never write back to the tracker or LPs. */
export async function reviewImport(admin: SupabaseClient, fundId: string, group: string,
  input: { entries?: JournalEntry[]; bankRows?: ParsedTxn[]; previewAccounts?: Account[]; includeLp?: boolean },
): Promise<ImportReview> {
  const dates = [...(input.entries ?? []).map(e => e.entryDate), ...(input.bankRows ?? []).map(r => r.date)].sort()
  const end = dates.at(-1)
  if (!end) return { token: '', checked: { investments: 0, lpPositions: 0 }, differences: [] }
  const [ledger, observations, txns, companies, names] = await Promise.all([
    loadPostedLedger(admin, fundId, group),
    input.includeLp ? loadPositions(admin, fundId, group) : Promise.resolve([]),
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    admin.from('companies' as any).select('*').eq('fund_id', fundId),
    input.includeLp ? admin.from('lp_entities' as any).select('id, entity_name').eq('fund_id', fundId) : Promise.resolve({ data: [], error: null }),
  ])
  for (const result of [txns, companies, names]) if (result.error) throw result.error
  const accounts = [...ledger.accounts, ...(input.previewAccounts ?? []).filter(a => !ledger.accounts.some(existing => existing.id === a.id))]
  const companyRows = (companies.data ?? []) as any[]
  // Imported entries are posted after this review, and posting ADOPTS their investment lines into
  // transactions (adoption.ts). Compare against the tracker as it will be, not as it is — otherwise
  // every clean import of a fund's history reads as a disagreement. A shape adoption would refuse
  // is listed, so the person sees it before importing rather than when a post fails.
  const chart: ChartAccount[] = accounts.map(a => ({ id: a.id, code: a.code, type: a.type, subtype: a.subtype ?? null, companyId: a.companyId ?? null }))
  const adoptionRefusals: { date: string; reason: string }[] = []
  const adopted: any[] = []
  for (const e of input.entries ?? []) {
    const read = readInvestmentLines(e.postings, chart)
    if ('refused' in read) { adoptionRefusals.push({ date: e.entryDate, reason: read.refused }); continue }
    for (const t of read.transactions) adopted.push({ ...t, fund_id: fundId, portfolio_group: group, transaction_date: e.entryDate })
  }
  const transactions = [...((txns.data ?? []) as any[]), ...adopted]
  const positions = buildSoiPositions(transactions, companyRows, group, new Date(end + 'T00:00:00Z'))
  const nameById = new Map(((names.data ?? []) as any[]).map(n => [n.id, n.entity_name]))
  const differences: ImportDifference[] = []
  for (const r of adoptionRefusals) {
    differences.push({ domain: 'investment', name: group, date: r.date, metric: 'Investment entry', recorded: null, imported: null, difference: null, message: r.reason })
  }
  const entries = input.entries ?? []
  const importedPostings = entries.flatMap(e => e.postings.map(p => ({ ...p, entryDate: e.entryDate, sourceType: e.sourceType === 'quickbooks' ? cashCapitalSource(e.postings, accounts) ?? e.sourceType : e.sourceType })))
  const touchedAccounts = new Set(importedPostings.map(p => p.accountId))
  const investmentTouched = accounts.some(a => touchedAccounts.has(a.id) && ['investment', 'unrealized', 'fx_translation'].includes(a.subtype ?? ''))
  if (investmentTouched) {
    const projected = scheduleOfInvestments(accounts, [...ledger.postings.filter(p => !p.entryDate || p.entryDate <= end), ...importedPostings], 0, positions)
    for (const [metric, recorded, imported] of [
      ['Investment cost', projected.totalCost, projected.ledgerCost],
      ['Investment value', projected.totalFairValue, projected.ledgerFairValue],
    ] as const) {
      if (Math.abs(recorded - imported) >= 0.005) differences.push({ domain: 'investment', name: group, date: end, metric, recorded, imported, difference: roundCents(imported - recorded), message: 'Projected books differ from investment records. A partial import may explain the difference; existing investment records will be retained.' })
    }
    for (const row of projected.rows) if (row.tiesOut === false) differences.push({ domain: 'investment', name: row.name, date: end, metric: 'Investment value', recorded: row.fairValue, imported: row.ledgerFairValue ?? null, difference: row.ledgerFairValue == null ? null : roundCents(row.ledgerFairValue - row.fairValue), message: 'This company does not reconcile. Check the account mapping and imported dates.' })
  }
  const importedCapital = importedPostings.flatMap(p => {
    const account = accounts.find(a => a.id === p.accountId)
    return account?.type === 'equity' && (account.lpEntityId || p.lpEntityId) ? [{ ...p, lpEntityId: (account.lpEntityId ?? p.lpEntityId)! }] : []
  })
  const touchedLpIds = new Set(importedCapital.map(p => p.lpEntityId))
  const pooled = accounts.some(a => touchedAccounts.has(a.id) && a.subtype === 'lp_capital' && !a.lpEntityId)
  const latest = new Map<string, typeof observations[number]>()
  for (const p of observations) if (!latest.has(p.lpEntityId) || latest.get(p.lpEntityId)!.asOfDate < p.asOfDate) latest.set(p.lpEntityId, p)
  for (const p of latest.values()) {
    if (!pooled && !touchedLpIds.has(p.lpEntityId)) continue
    const capital = computeCapitalAccounts([...ledger.capitalPostings, ...importedCapital], { end: p.asOfDate }).get(p.lpEntityId)
    for (const [metric, recorded, imported] of [
      ['Capital balance', p.nav, capital?.ending ?? null],
      ['Contributions', p.calledCapital, capital?.contributions ?? null],
      ['Distributions', p.distributions, capital ? -capital.distributions : null],
    ] as const) {
      const different = recorded == null || imported == null || Math.abs(imported - recorded) >= 0.005
      if (different || (metric === 'Capital balance' && (pooled || end > p.asOfDate))) differences.push({ domain: 'lp', name: nameById.get(p.lpEntityId) ?? p.lpEntityId, date: p.asOfDate, metric, recorded, imported, difference: recorded == null || imported == null ? null : roundCents(imported - recorded), message: pooled ? 'Imported capital is not assigned to an LP. Match it to a partner before posting.' : end > p.asOfDate ? 'The import extends beyond this LP’s reported balance date. Review overlapping activity and obtain a later valuation; the statement is retained.' : 'Projected accounting capital differs from the reported LP record. Reconcile the opening balance, allocation, and dates; the statement is retained.' })
    }
  }
  // A bank movement is a flow, while an LP position is a cumulative observation. Never compare
  // those as if they were the same quantity or silently create investment/LP records from a name.
  for (const row of input.bankRows ?? []) {
    const text = `${row.description} ${row.counterparty ?? ''}`.toLowerCase()
    const candidates = transactions.filter(t => txnsForVehicle([t], group).length && t.transaction_date && Math.abs(Date.parse(t.transaction_date) - Date.parse(row.date)) <= 7 * 86400000)
    const named = companyRows.filter(c => c.name && text.includes(c.name.toLowerCase()) && transactions.some(t => t.company_id === c.id && txnsForVehicle([t], group).length))
    for (const c of named) {
      const matches = candidates.filter(t => t.company_id === c.id && (row.amount < 0 ? t.transaction_type === 'investment' : t.transaction_type === 'proceeds'))
      const recorded = matches.length ? matches.reduce((n, t) => n + Number(row.amount < 0 ? t.investment_cost ?? 0 : t.proceeds_received ?? 0), 0) : null
      const imported = Math.abs(row.amount)
      differences.push({ domain: 'investment', name: c.name, date: row.date, metric: 'Cash movement', recorded, imported, difference: recorded == null ? null : roundCents(imported - recorded), message: recorded === imported ? 'Possible existing investment transaction. Link the accounting representation; do not add another investment.' : 'Bank activity names an existing company but differs from nearby investment transactions. Review the date, amount, and company match.' })
    }
    if (!named.length) {
      const matches = candidates.filter(t => row.amount < 0 ? t.transaction_type === 'investment' && Math.abs(Number(t.investment_cost) + row.amount) < 0.005 : t.transaction_type === 'proceeds' && Math.abs(Number(t.proceeds_received) - row.amount) < 0.005)
      if (matches.length) differences.push({ domain: 'investment', name: matches.map(t => companyRows.find(c => c.id === t.company_id)?.name ?? t.company_id).join(', '), date: row.date, metric: 'Possible matching cash movement', recorded: Math.abs(row.amount), imported: Math.abs(row.amount), difference: 0, message: 'Amount and nearby dates match investment activity. Confirm the identity and link the accounting record; this is not proof of a duplicate.' })
    }
    const namedLps = Array.from(latest.values()).filter(p => { const name = nameById.get(p.lpEntityId); return name && text.includes(String(name).toLowerCase()) })
    if (namedLps.length || (/capital|contribution|distribution/.test(text) || (row.amount > 0 && /\bsubscription\b/.test(text)))) {
      differences.push({ domain: 'lp', name: namedLps.map(p => nameById.get(p.lpEntityId)).join(', ') || 'Partner match needed', date: row.date, metric: 'Cash movement', recorded: null, imported: row.amount, difference: null, message: 'Match this movement to its LP and existing call, distribution, or reported balance. Cumulative LP balances are not cash transactions and will not be changed by this import.' })
    }
  }
  const checked = { investments: positions.length, lpPositions: latest.size, lpComparisonAvailable: !!input.includeLp }
  const token = createHash('sha256').update(JSON.stringify({ fundId, group, input, checked, differences })).digest('hex')
  return { token, checked, differences }
}
