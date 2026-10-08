// lib/accounting/adopt.ts
//
// LEDGER → TRACKER: read an entry's investment-account lines as the transactions they record.
//
// Pure. The entry was booked first — a QuickBooks import, a hand-written journal entry, the bank
// categorizer — and posting it must leave investment value owned by an investment transaction
// (plans/spec-ledger-one-writer.md §1). This is the inverse of derivation (from-portfolio.ts): an
// entry derivation would build reads back as the transaction that built it.
//
// Netted per company, per kind of investment account:
//   cost debit                → investment at that cost
//   cost credit               → an exit: basis = the credit; proceeds = basis + gain − escrow
//   unrealized, no cost line  → a mark
//   FX translation, no cost   → an FX mark
// A 1200/1250 credit beside a cost credit is the exit unwinding its mark, not a separate mark.
//
// WHAT IT REFUSES TO GUESS, in plain words for the person posting: a pooled account (which
// company?), a pooled gain or escrow across several exits (whose?), a gain with no exit, lines it
// cannot read, and conversions (a SAFE or note becoming equity has its own transaction shape —
// record it on the company).

import { roundCents } from './ledger'
import { investmentKind, isPooledInvestmentAccount, type ChartAccount } from './investment-accounts'

export const ESCROW_CODE = '1350'

export interface ReadPosting { accountId: string; amount: number }

export interface AdoptedTxn {
  company_id: string
  transaction_type: 'investment' | 'proceeds' | 'unrealized_gain_change'
  investment_cost?: number
  cost_basis_exited?: number
  proceeds_received?: number
  proceeds_escrow?: number
  unrealized_value_change?: number
  fx_value_change?: number
  valuation_change_source?: 'mark' | 'fx'
}

export type ReadResult = { transactions: AdoptedTxn[] } | { refused: string }

const CONVERSION = 'This entry converts a SAFE or note into equity. Record it on the company as a conversion, so the tracker and the ledger agree on its basis.'

export function touchesInvestmentAccounts(postings: ReadPosting[], chart: ChartAccount[]): boolean {
  const byId = new Map(chart.map(a => [a.id, a]))
  return postings.some(p => {
    const a = byId.get(p.accountId)
    return !!a && investmentKind(a) !== null && roundCents(p.amount) !== 0
  })
}

export function readInvestmentLines(postings: ReadPosting[], chart: ChartAccount[]): ReadResult {
  const byId = new Map(chart.map(a => [a.id, a]))
  const per = new Map<string, { cost: number; hadCost: boolean; unrealized: number; fx: number; realized: number; interest: number }>()
  const at = (companyId: string) => {
    let c = per.get(companyId)
    if (!c) { c = { cost: 0, hadCost: false, unrealized: 0, fx: 0, realized: 0, interest: 0 }; per.set(companyId, c) }
    return c
  }
  let pooledGain = 0
  let escrow = 0

  for (const p of postings) {
    const a = byId.get(p.accountId)
    if (!a) continue
    const amount = roundCents(p.amount)
    if (isPooledInvestmentAccount(a)) {
      if (amount !== 0) return { refused: `This entry posts to the pooled investment account ${a.code}, which no company owns. Post it to the company's own account instead.` }
      continue
    }
    const kind = investmentKind(a)
    if (kind && a.companyId) {
      const c = at(a.companyId)
      if (kind === 'cost') { c.cost = roundCents(c.cost + amount); c.hadCost = true }
      else if (kind === 'unrealized') c.unrealized = roundCents(c.unrealized + amount)
      else if (kind === 'fx') c.fx = roundCents(c.fx + amount)
      else c.realized = roundCents(c.realized + amount)
      continue
    }
    // Context the reader consults: pooled realized gain, escrow receivable, note interest.
    if (a.subtype === 'realized_gain' && !a.companyId) pooledGain = roundCents(pooledGain + amount)
    else if (a.code === ESCROW_CODE && amount > 0) escrow = roundCents(escrow + amount)
    else if (a.subtype === 'accrued_interest' && a.companyId) {
      const c = per.get(a.companyId)
      if (c) c.interest = roundCents(c.interest + amount)
      else at(a.companyId).interest = amount
    }
  }

  const companies = Array.from(per.keys()).filter(id => {
    const c = per.get(id)!
    return c.hadCost || c.unrealized !== 0 || c.fx !== 0 || c.realized !== 0
  }).sort()
  const exits = companies.filter(id => per.get(id)!.cost < 0)
  if (pooledGain !== 0 && companies.length > 1) {
    return { refused: 'This entry books a realized gain to the pooled 4000 account while more than one company appears in it, so the gain cannot be attributed. Book each gain to the company\'s own realized-gain account.' }
  }
  if (escrow !== 0 && exits.length > 1) {
    return { refused: 'This entry holds back escrow on an exit from more than one company, so the escrow cannot be attributed. Split it into one entry per exit.' }
  }

  const transactions: AdoptedTxn[] = []
  for (const id of companies) {
    const c = per.get(id)!
    if (c.realized !== 0 && c.cost >= 0) {
      return { refused: 'This entry books a realized gain with no exit — nothing is sold from the position. Record the exit with its cost basis, or book the gain elsewhere.' }
    }
    if (c.hadCost && c.cost === 0) {
      if (c.unrealized !== 0 || c.fx !== 0) return { refused: 'This entry\'s investment lines cannot be read as a purchase, an exit or a mark. Split it into one entry per transaction.' }
      continue
    }
    if (c.cost > 0) {
      if (c.unrealized !== 0 || c.interest !== 0) return { refused: CONVERSION }
      if (c.fx !== 0) return { refused: 'This entry records a purchase and a currency move together. Split it into one entry for each.' }
      transactions.push({ company_id: id, transaction_type: 'investment', investment_cost: c.cost })
      continue
    }
    if (c.cost < 0) {
      const basis = roundCents(-c.cost)
      const gain = roundCents(-(c.realized + (companies.length === 1 ? pooledGain : 0)))
      const held = companies.length === 1 || exits.length === 1 ? escrow : 0
      const txn: AdoptedTxn = { company_id: id, transaction_type: 'proceeds', cost_basis_exited: basis, proceeds_received: roundCents(basis + gain - held) }
      if (held !== 0) txn.proceeds_escrow = held
      transactions.push(txn)
      continue
    }
    if (c.unrealized !== 0) {
      transactions.push({ company_id: id, transaction_type: 'unrealized_gain_change', unrealized_value_change: c.unrealized, valuation_change_source: 'mark' })
    }
    if (c.fx !== 0) {
      transactions.push({ company_id: id, transaction_type: 'unrealized_gain_change', fx_value_change: c.fx, valuation_change_source: 'fx' })
    }
  }
  return { transactions }
}
