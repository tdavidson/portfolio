import { describe, it, expect } from 'vitest'
import { investmentCostCode, investmentUnrealizedCode } from './investments'
import { scheduleOfInvestments, balanceSheet, postingsAsOf } from './statements'
import type { Account, Posting } from './types'

const CO_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const CO_B = 'bbbbbbbb-1111-2222-3333-444444444444'

const accounts: Account[] = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'costA', fundId: 'f', code: investmentCostCode(CO_A), name: 'Investment — A', type: 'asset', subtype: 'investment', companyId: CO_A },
  { id: 'unrlA', fundId: 'f', code: investmentUnrealizedCode(CO_A), name: 'Unrealized — A', type: 'asset', subtype: 'unrealized', companyId: CO_A },
  { id: 'costB', fundId: 'f', code: investmentCostCode(CO_B), name: 'Investment — B', type: 'asset', subtype: 'investment', companyId: CO_B },
  { id: 'unrlB', fundId: 'f', code: investmentUnrealizedCode(CO_B), name: 'Unrealized — B', type: 'asset', subtype: 'unrealized', companyId: CO_B },
  { id: 'cap', fundId: 'f', code: '3100', name: "Partners' capital", type: 'equity', subtype: 'lp_capital' },
  { id: 'unrlInc', fundId: 'f', code: '4200', name: 'Change in unrealized', type: 'income', subtype: 'unrealized' },
]

describe('per-investment account codes', () => {
  it('are derived from the company id, and are distinct per company', () => {
    expect(investmentCostCode(CO_A)).toBe('1100-aaaaaaaa')
    expect(investmentUnrealizedCode(CO_A)).toBe('1200-aaaaaaaa')
    expect(investmentCostCode(CO_B)).not.toBe(investmentCostCode(CO_A))
  })
})

describe('per-company tie-out', () => {
  // A: cost 100, marked to 150. B: cost 200, marked to 180.
  const postings: Posting[] = [
    { accountId: 'costA', amount: 100, currency: 'USD' },
    { accountId: 'unrlA', amount: 50, currency: 'USD' },
    { accountId: 'costB', amount: 200, currency: 'USD' },
    { accountId: 'unrlB', amount: -20, currency: 'USD' },
    { accountId: 'cash', amount: -300, currency: 'USD' },
    { accountId: 'unrlInc', amount: -30, currency: 'USD' },
  ]

  it('reports each position against its OWN ledger accounts', () => {
    const soi = scheduleOfInvestments(accounts, postings, 1_000, [
      { companyId: CO_A, name: 'A', cost: 100, fairValue: 150 },
      { companyId: CO_B, name: 'B', cost: 200, fairValue: 180 },
    ] as any)

    const a = soi.rows.find(r => r.name === 'A')!
    expect(a.ledgerCost).toBe(100)
    expect(a.ledgerFairValue).toBe(150)
    expect(a.tiesOut).toBe(true)

    const b = soi.rows.find(r => r.name === 'B')!
    expect(b.ledgerFairValue).toBe(180)
    expect(b.tiesOut).toBe(true)
  })

  it('CATCHES two offsetting errors that the total-only tie-out would hide', () => {
    // The tracker says A is 50 too high and B is 50 too low. The TOTAL still ties
    // exactly — which is precisely the failure the aggregate account could not see.
    const soi = scheduleOfInvestments(accounts, postings, 1_000, [
      { companyId: CO_A, name: 'A', cost: 150, fairValue: 200 },
      { companyId: CO_B, name: 'B', cost: 150, fairValue: 130 },
    ] as any)

    expect(soi.costVariance).toBe(0)       // total ties…
    expect(soi.fairValueVariance).toBe(0)  // …and so does fair value

    // …but both positions are individually wrong, and now we can say so.
    expect(soi.rows.find(r => r.name === 'A')!.tiesOut).toBe(false)
    expect(soi.rows.find(r => r.name === 'B')!.tiesOut).toBe(false)
  })

  it('leaves tiesOut undefined when the company has no ledger accounts', () => {
    const soi = scheduleOfInvestments(accounts, postings, 1_000, [
      { companyId: 'cccccccc-0000-0000-0000-000000000000', name: 'C', cost: 10, fairValue: 10 },
    ] as any)
    const c = soi.rows[0]
    expect(c.ledgerCost).toBeUndefined()
    expect(c.tiesOut).toBeUndefined() // don't claim a tie-out we can't actually make
  })

  it('a write-off zeroes the carrying value but leaves cost on the books', () => {
    // B written off: its unrealized offsets its full cost.
    const written: Posting[] = [
      { accountId: 'costB', amount: 200, currency: 'USD' },
      { accountId: 'unrlB', amount: -200, currency: 'USD' },
      { accountId: 'cash', amount: -200, currency: 'USD' },
      { accountId: 'unrlInc', amount: 200, currency: 'USD' },
    ]
    const soi = scheduleOfInvestments(accounts, written, 1_000, [
      { companyId: CO_B, name: 'B', cost: 200, fairValue: 0 },
    ] as any)
    const b = soi.rows[0]
    expect(b.ledgerCost).toBe(200)      // cost stays
    expect(b.ledgerFairValue).toBe(0)   // carrying value is nil
    expect(b.tiesOut).toBe(true)
  })

  it('totals still sum every per-company account, so the aggregate is unchanged', () => {
    const soi = scheduleOfInvestments(accounts, postings, 1_000, [])
    expect(soi.ledgerCost).toBe(300)       // 100 + 200
    expect(soi.ledgerFairValue).toBe(330)  // 300 + 50 − 20
  })
})

describe('bootstrapping investments must not double-count equity', () => {
  it('reclassifying out of cash leaves partners’ capital untouched', () => {
    // The cutover opening put the whole NAV in cash and credited capital.
    const opening: Posting[] = [
      { accountId: 'cash', amount: 1_000, currency: 'USD' },
      { accountId: 'cap', amount: -1_000, currency: 'USD' },
    ]
    const before = balanceSheet(accounts, postingsAsOf(opening, null))
    expect(before.partnersCapital.total).toBe(1_000)
    expect(before.check).toBe(0)

    // Bootstrap: move 300 of cost + 30 of unrealized OUT of cash. Equity must not move.
    const bootstrap: Posting[] = [
      ...opening,
      { accountId: 'costA', amount: 100, currency: 'USD' },
      { accountId: 'unrlA', amount: 50, currency: 'USD' },
      { accountId: 'costB', amount: 200, currency: 'USD' },
      { accountId: 'unrlB', amount: -20, currency: 'USD' },
      { accountId: 'cash', amount: -330, currency: 'USD' },
    ]
    const after = balanceSheet(accounts, postingsAsOf(bootstrap, null))

    expect(after.partnersCapital.total).toBe(1_000) // unchanged — the point
    expect(after.assets.total).toBe(1_000)          // 670 cash + 300 cost + 30 unrealized
    expect(after.check).toBe(0)
  })

  it('crediting capital instead would book the fund’s equity TWICE', () => {
    // The bug this guards against.
    const wrong: Posting[] = [
      { accountId: 'cash', amount: 1_000, currency: 'USD' },
      { accountId: 'cap', amount: -1_000, currency: 'USD' },
      { accountId: 'costA', amount: 300, currency: 'USD' },
      { accountId: 'cap', amount: -300, currency: 'USD' }, // ← wrong offset
    ]
    const bs = balanceSheet(accounts, postingsAsOf(wrong, null))
    expect(bs.partnersCapital.total).toBe(1_300) // inflated by the investment
  })
})

describe('ledger-only positions in the schedule of investments', () => {
  // The shape a QuickBooks import leaves: each holding has its own 1100-<id>/1200-<id> accounts
  // carrying cost and marks, and no investment transaction — so the portfolio tracker knows
  // nothing about it.
  const ledgerAccounts: Account[] = [
    { id: 'cost-arden', fundId: 'f', code: '1100-arden', name: 'Arden — cost', type: 'asset', subtype: 'investment', companyId: 'arden' },
    { id: 'mark-arden', fundId: 'f', code: '1200-arden', name: 'Arden — mark', type: 'asset', subtype: 'unrealized', companyId: 'arden' },
    { id: 'cost-filament', fundId: 'f', code: '1100-filament', name: 'Filament — cost', type: 'asset', subtype: 'investment', companyId: 'filament' },
  ]
  const ledgerPostings: Posting[] = [
    { accountId: 'cost-arden', amount: 400, currency: 'USD' },
    { accountId: 'mark-arden', amount: 100, currency: 'USD' },
    { accountId: 'cost-filament', amount: 250, currency: 'USD' },
  ]
  const companies = [
    { id: 'arden', name: 'Arden Endeavor Fund LP', holding_type: 'fund' as const },
    { id: 'filament', name: 'Filament Capital Fund II LP', holding_type: 'fund' as const },
  ]

  it('names holdings the ledger carries and the tracker does not', () => {
    const soi = scheduleOfInvestments(ledgerAccounts, ledgerPostings, 1_000, [], companies)
    expect(soi.rows.map(r => [r.name, r.cost, r.fairValue])).toEqual([
      ['Arden Endeavor Fund LP', 400, 500],
      ['Filament Capital Fund II LP', 250, 250],
    ])
    expect(soi.rows.every(r => r.holdingType === 'fund')).toBe(true)
    // It IS the ledger, so it cannot disagree with it — and the schedule now ties.
    expect(soi.rows.every(r => r.tiesOut === true)).toBe(true)
    expect(soi.costVariance).toBe(0)
    expect(soi.fairValueVariance).toBe(0)
  })

  it('does NOT duplicate a holding the tracker already reports', () => {
    const soi = scheduleOfInvestments(ledgerAccounts, ledgerPostings, 1_000, [
      { name: 'Arden Endeavor Fund LP', companyId: 'arden', cost: 400, fairValue: 500, holdingType: 'fund' },
    ], companies)
    expect(soi.rows.filter(r => r.companyId === 'arden')).toHaveLength(1)
    // Filament is still filled in from the ledger; Arden is left to the tracker.
    expect(soi.rows.map(r => r.name)).toEqual(['Arden Endeavor Fund LP', 'Filament Capital Fund II LP'])
    expect(soi.totalCost).toBe(650)
    expect(soi.costVariance).toBe(0)
  })

  it('skips a company it cannot name rather than inventing a row', () => {
    const soi = scheduleOfInvestments(ledgerAccounts, ledgerPostings, 1_000, [], [companies[0]])
    expect(soi.rows.map(r => r.name)).toEqual(['Arden Endeavor Fund LP'])
    // The unnamed one still counts in the control total, so the variance reports the gap.
    expect(soi.costVariance).toBe(-250)
  })

  it('keeps a written-down holding, at cost with no fair value', () => {
    // A full write-down is a position with a story, not an absent one. Dropping the row would
    // hide the write-off and leave the schedule failing its own tie-out.
    const written: Posting[] = [
      { accountId: 'cost-arden', amount: 400, currency: 'USD' },
      { accountId: 'mark-arden', amount: -400, currency: 'USD' },
      { accountId: 'cost-filament', amount: 250, currency: 'USD' },
    ]
    const soi = scheduleOfInvestments(ledgerAccounts, written, 1_000, [], companies)
    expect(soi.rows.map(r => [r.name, r.cost, r.fairValue])).toEqual([
      ['Arden Endeavor Fund LP', 400, 0],
      ['Filament Capital Fund II LP', 250, 250],
    ])
    expect(soi.costVariance).toBe(0)
    expect(soi.fairValueVariance).toBe(0)
  })

  it('omits an account pair that carries nothing at all', () => {
    const none: Posting[] = [{ accountId: 'cost-filament', amount: 250, currency: 'USD' }]
    const soi = scheduleOfInvestments(ledgerAccounts, none, 1_000, [], companies)
    expect(soi.rows.map(r => r.name)).toEqual(['Filament Capital Fund II LP'])
  })

  it('still falls back to one aggregate line when nothing is held per company', () => {
    const aggregate: Account[] = [
      { id: 'inv', fundId: 'f', code: '1100', name: 'Investments', type: 'asset', subtype: 'investment' },
    ]
    const soi = scheduleOfInvestments(aggregate, [{ accountId: 'inv', amount: 900, currency: 'USD' }], 1_000, [], companies)
    expect(soi.rows.map(r => r.name)).toEqual(['Portfolio investments'])
    expect(soi.source).toBe('ledger')
  })
})
