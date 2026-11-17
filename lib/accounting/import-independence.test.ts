import { describe, expect, it } from 'vitest'
import { scheduleOfInvestments } from './statements'
import { resolveCapitalEvidence } from './capital-evidence'
import { buildEntries } from './quickbooks/build-entries'
import type { Account } from './types'

// Importing books adds another representation of existing economics. It must not rewrite
// the tracker or select partial capital records merely because accounts now exist.
describe('investments and LPs remain independent of accounting imports', () => {
  const positions = [{ companyId: 'company', name: 'Acme', cost: 100, fairValue: 150 }]
  const chart: Account[] = [{ id: 'investment', fundId: 'firm', code: '1100-company', name: 'Acme', type: 'asset', subtype: 'investment', companyId: 'company' }]
  it('keeps tracked investment values when imported ledger balances conflict', () => {
    const before = scheduleOfInvestments([], [], 150, positions)
    const after = scheduleOfInvestments(chart, [{ accountId: 'investment', amount: 80, currency: 'USD' }], 80, positions)
    expect(after.rows[0]).toMatchObject({ companyId: 'company', cost: 100, fairValue: 150, ledgerCost: 80, tiesOut: false })
    expect(after.totalCost).toBe(before.totalCost)
    expect(after.totalFairValue).toBe(before.totalFairValue)
    expect(after.costVariance).toBe(20)
    expect(positions).toEqual([{ companyId: 'company', name: 'Acme', cost: 100, fairValue: 150 }])
  })
  it('does not double the tracked investment when the imported books match', () => {
    const r = scheduleOfInvestments(chart, [{ accountId: 'investment', amount: 100, currency: 'USD' }], 150, positions)
    expect(r.totalCost).toBe(100)
    expect(r.rows).toHaveLength(1)
  })
  it('leaves reported LP balances and identities untouched when QuickBooks brings in overlapping capital', () => {
    const observations = [{ lpEntityId: 'lp', asOfDate: '2025-03-31', commitment: 200, calledCapital: 100, distributions: 10, nav: 120, irr: 0.12 }]
    const original = structuredClone(observations)
    const txn = { date: '2025-03-31', type: 'Journal Entry', num: '1', memo: 'Capital', lines: [
      { account: 'Cash', name: null, memo: null, debit: 100, credit: 0 },
      { account: 'Capital', name: 'LP', memo: null, debit: 0, credit: 100 },
    ] }
    const { entries } = buildEntries([txn], new Map([['Cash', '1000'], ['Capital', '3100']]), new Map([['1000', 'cash'], ['3100', 'capital']]), 'firm')
    const capital = entries.flatMap(e => e.postings.filter(p => p.accountId === 'capital').map(p => ({ ...p, lpEntityId: 'lp', sourceType: e.sourceType, entryDate: e.entryDate })))
    const after = resolveCapitalEvidence(capital, observations, '2025-04-30')
    // The books are the record, so they report; the import stays as it was and the difference shows.
    // An imported journal entry is not classed as a contribution, so it moves NAV only.
    expect(after.evidenceByLp.get('lp')).toMatchObject({
      basis: 'ledger', conflict: true, values: { contributions: 0, distributions: 0, nav: 100 },
      anchor: { date: '2025-03-31', agreesWithBooks: false, variance: { contributions: -100, distributions: -10, nav: -20 } },
    })
    expect(observations).toEqual(original)
  })
})
