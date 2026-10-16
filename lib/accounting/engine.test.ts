import { describe, it, expect } from 'vitest'
import { apportionCents, allocateAmount, allocateAmountCumulatively, ownershipFractions } from './allocation'
import { computeCapitalAccounts, totalNav, bucketForSourceType } from './capital-account'
import { reconcileCapital } from './reconcile'
import { trialBalance, balanceSheet, incomeStatement, scheduleOfInvestments, changesInPartnersCapital, statementOfCashFlows, postingsInPeriod, postingsAsOf, openingCashBalance, type CashPosting } from './statements'
import type { Account, Posting } from './types'

describe('apportionCents', () => {
  it('sums exactly to the total, handing leftover cents to largest remainders', () => {
    // $100.00 split 1/1/1 → 33.34 / 33.33 / 33.33 (first index gets the extra cent).
    const parts = apportionCents(10000, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000)
    expect(parts).toEqual([3334, 3333, 3333])
  })

  it('respects weights', () => {
    const parts = apportionCents(10000, [50, 30, 20])
    expect(parts).toEqual([5000, 3000, 2000])
  })

  it('falls back to even split when the basis is all zero', () => {
    const parts = apportionCents(1000, [0, 0, 0, 0])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000)
    expect(parts).toEqual([250, 250, 250, 250])
  })

  it('handles negative totals (credit allocations)', () => {
    const parts = apportionCents(-10000, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-10000)
  })
})

describe('allocateAmount', () => {
  it('splits a fee pro-rata by commitment, exact to the cent', () => {
    const owners = [
      { lpEntityId: 'a', commitment: 6_000_000 },
      { lpEntityId: 'b', commitment: 3_000_000 },
      { lpEntityId: 'c', commitment: 1_000_000 },
    ]
    const alloc = allocateAmount(200_000, owners)
    expect(alloc.get('a')).toBe(120_000)
    expect(alloc.get('b')).toBe(60_000)
    expect(alloc.get('c')).toBe(20_000)
    const sum = Array.from(alloc.values()).reduce((x, y) => x + y, 0)
    expect(sum).toBe(200_000)
  })

  it('never loses a penny on awkward ratios', () => {
    const owners = [
      { lpEntityId: 'a', commitment: 1 },
      { lpEntityId: 'b', commitment: 1 },
      { lpEntityId: 'c', commitment: 1 },
    ]
    const alloc = allocateAmount(100.0, owners)
    const sum = Array.from(alloc.values()).reduce((x, y) => x + y, 0)
    expect(sum).toBe(100.0)
  })
})

describe('allocateAmountCumulatively', () => {
  it('pays back the prior rounding cent instead of repeatedly favoring the same owner', () => {
    const owners = [
      { lpEntityId: 'a', commitment: 1 },
      { lpEntityId: 'b', commitment: 1 },
      { lpEntityId: 'c', commitment: 1 },
    ]
    const first = allocateAmountCumulatively(0.01, owners, new Map())
    expect(first.map(line => line.amount)).toEqual([0.01, 0, 0])
    const residual = new Map(first.map(line => [line.lpEntityId, line.exactAmount - line.amount]))
    const second = allocateAmountCumulatively(0.01, owners, residual)
    expect(second.map(line => line.amount)).toEqual([0, 0.01, 0])
    const secondResidual = new Map(second.map(line => [
      line.lpEntityId,
      (residual.get(line.lpEntityId) ?? 0) + line.exactAmount - line.amount,
    ]))
    const third = allocateAmountCumulatively(0.01, owners, secondResidual)
    expect(third.map(line => line.amount)).toEqual([0, 0, 0.01])
    for (const allocation of [first, second, third]) {
      expect(allocation.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(0.01, 8)
    }
  })

  it('handles negative allocations and still ties exactly to the cent', () => {
    const owners = [
      { lpEntityId: 'a', commitment: 2 },
      { lpEntityId: 'b', commitment: 1 },
    ]
    const allocation = allocateAmountCumulatively(-0.01, owners, new Map([['a', 0.003], ['b', -0.003]]))
    expect(allocation.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(-0.01, 8)
  })
})

describe('ownershipFractions', () => {
  it('computes fractions that sum to 1', () => {
    const f = ownershipFractions([
      { lpEntityId: 'a', commitment: 3 },
      { lpEntityId: 'b', commitment: 1 },
    ])
    expect(f.get('a')).toBe(0.75)
    expect(f.get('b')).toBe(0.25)
  })
})

describe('bucketForSourceType', () => {
  it('maps source types to roll-forward lines', () => {
    expect(bucketForSourceType('opening_balance')).toBe('beginning')
    expect(bucketForSourceType('capital_call')).toBe('contributions')
    expect(bucketForSourceType('distribution')).toBe('distributions')
    expect(bucketForSourceType('management_fee')).toBe('managementFees')
    expect(bucketForSourceType('partnership_expense')).toBe('expenses')
    expect(bucketForSourceType('income')).toBe('operatingIncome')
    expect(bucketForSourceType('realized_gain')).toBe('realizedGains')
    expect(bucketForSourceType('valuation')).toBe('unrealizedGains')
    expect(bucketForSourceType('transfer')).toBe('transfers')
    expect(bucketForSourceType('carried_interest')).toBe('carriedInterest')
    expect(bucketForSourceType('mystery')).toBe('unclassified')
  })
})

describe('computeCapitalAccounts', () => {
  it('rolls a period forward per LP; ending ties to the raw sum', () => {
    // LP-a: open 100k, called 50k, fee -2k, gain +10k → 158k
    // LP-b: open 40k, called 20k, distribution -5k → 55k
    const postings = [
      { lpEntityId: 'a', amount: -100_000, sourceType: 'opening_balance' }, // credit = +capital
      { lpEntityId: 'a', amount: -50_000, sourceType: 'capital_call' },
      { lpEntityId: 'a', amount: 2_000, sourceType: 'management_fee' }, // debit reduces capital
      { lpEntityId: 'a', amount: -10_000, sourceType: 'realized_gain' },
      { lpEntityId: 'b', amount: -40_000, sourceType: 'opening_balance' },
      { lpEntityId: 'b', amount: -20_000, sourceType: 'capital_call' },
      { lpEntityId: 'b', amount: 5_000, sourceType: 'distribution' },
    ]
    const accounts = computeCapitalAccounts(postings)
    const a = accounts.get('a')!
    expect(a.beginning).toBe(100_000)
    expect(a.contributions).toBe(50_000)
    expect(a.managementFees).toBe(-2_000)
    expect(a.realizedGains).toBe(10_000)
    expect(a.ending).toBe(158_000)

    const b = accounts.get('b')!
    expect(b.distributions).toBe(-5_000)
    expect(b.ending).toBe(55_000)

    expect(totalNav(accounts)).toBe(213_000)
  })
})

describe('reconcileCapital', () => {
  const ledger = computeCapitalAccounts([
    { lpEntityId: 'a', amount: -100_000, sourceType: 'opening_balance' },
    { lpEntityId: 'a', amount: -50_000, sourceType: 'capital_call' },
  ])

  it('ties out when the admin agrees', () => {
    const admin = new Map([['a', { beginning: 100_000, contributions: 50_000, ending: 150_000 }]])
    const res = reconcileCapital(ledger, admin)
    expect(res.allTieOut).toBe(true)
    expect(res.maxAbsDelta).toBe(0)
    expect(res.reconciled).toEqual(['a'])
  })

  it('localizes a discrepancy to the line and LP', () => {
    const admin = new Map([['a', { ending: 148_000 }]])
    const res = reconcileCapital(ledger, admin)
    expect(res.allTieOut).toBe(false)
    const endingLine = res.lines.find(l => l.line === 'ending')!
    expect(endingLine.delta).toBe(2_000) // ledger is 2k higher than admin
    expect(endingLine.tiesOut).toBe(false)
  })

  it('flags LPs present on only one side', () => {
    const admin = new Map([['b', { ending: 10 }]])
    const res = reconcileCapital(ledger, admin)
    expect(res.ledgerOnly).toEqual(['a'])
    expect(res.adminOnly).toEqual(['b'])
    expect(res.allTieOut).toBe(false)
  })
})

describe('statements', () => {
  const accounts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' },
    { id: 'lp', fundId: 'f', code: '3100', name: 'LP Capital', type: 'equity' },
    { id: 'fee', fundId: 'f', code: '5000', name: 'Management fee', type: 'expense' },
    { id: 'gain', fundId: 'f', code: '4000', name: 'Realized gains', type: 'income' },
  ]
  // Call 100k cash / credit LP capital; pay 2k fee from cash; book 10k gain to cash & income.
  const postings: Posting[] = [
    { accountId: 'cash', amount: 100_000, currency: 'USD' },
    { accountId: 'lp', amount: -100_000, currency: 'USD' },
    { accountId: 'fee', amount: 2_000, currency: 'USD' },
    { accountId: 'cash', amount: -2_000, currency: 'USD' },
    { accountId: 'cash', amount: 10_000, currency: 'USD' },
    { accountId: 'gain', amount: -10_000, currency: 'USD' },
  ]

  it('produces a balanced trial balance', () => {
    const tb = trialBalance(accounts, postings)
    expect(tb.balanced).toBe(true)
    expect(tb.totalDebits).toBe(tb.totalCredits)
    expect(tb.rows.find(r => r.accountId === 'cash')!.balance).toBe(108_000)
  })

  it('income statement nets income minus expenses', () => {
    const is = incomeStatement(accounts, postings)
    expect(is.income.total).toBe(10_000)
    expect(is.expenses.total).toBe(2_000)
    expect(is.netIncome).toBe(8_000)
  })

  it('balance sheet: assets = liabilities + partners’ capital, and it BALANCES', () => {
    const bs = balanceSheet(accounts, postings)
    expect(bs.assets.total).toBe(108_000)

    // Partners' capital is ONE total with no per-partner detail — that belongs in the
    // statement of changes. It folds in the 8k of net income no close has allocated
    // yet; otherwise the balance sheet wouldn't balance and the residual would
    // silently carry the P&L.
    expect(bs.equity.rows).toHaveLength(0)
    expect(bs.equity.total).toBe(108_000)
    expect(bs.partnersCapital).toEqual({ total: 108_000, unallocatedEarnings: 8_000 })
    expect(bs.check).toBe(0)
  })
})

describe('management company balance sheet', () => {
  // A manco whose net income is closed through the bridge into members' accounts: 1,000 of fee
  // income, 600 closed to two members 50/50, 400 not closed yet, and a 100 distribution to one.
  const accounts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { id: 'pool', fundId: 'f', code: '3000', name: "Members' capital", type: 'equity', subtype: 'members_capital' },
    { id: 'a', fundId: 'f', code: '3010', name: "Members' capital — A", type: 'equity', subtype: 'member_contributions' },
    { id: 'b', fundId: 'f', code: '3020', name: "Members' capital — B", type: 'equity', subtype: 'member_contributions' },
    { id: 'bridge', fundId: 'f', code: '3200', name: 'Undistributed earnings (bridge)', type: 'equity', subtype: 'undistributed_earnings' },
    { id: 'fee', fundId: 'f', code: '4000', name: 'Management fee income', type: 'income', subtype: 'management_fee_income' },
  ]
  const postings: Posting[] = [
    { accountId: 'cash', amount: 1_000, currency: 'USD' },
    { accountId: 'fee', amount: -1_000, currency: 'USD' },
    { accountId: 'bridge', amount: 600, currency: 'USD' },
    { accountId: 'a', amount: -300, currency: 'USD' },
    { accountId: 'b', amount: -300, currency: 'USD' },
    { accountId: 'a', amount: 100, currency: 'USD' },
    { accountId: 'cash', amount: -100, currency: 'USD' },
  ]

  it('lists each member account when asked, without the bridge, and still sums to net assets', () => {
    const bs = balanceSheet(accounts, postings, { equityLabel: "Members' capital", itemizeEquity: true })
    expect(bs.equity.rows).toEqual([
      { code: '3010', name: "Members' capital — A", amount: 200 },
      { code: '3020', name: "Members' capital — B", amount: 300 },
      { code: '', name: 'Net income not yet closed', amount: 400 },
    ])
    expect(bs.equity.total).toBe(900)
    expect(bs.equity.rows.reduce((t, row) => t + row.amount, 0)).toBe(900)
    expect(bs.check).toBe(0)
    expect(bs.partnersCapital).toEqual({ total: 900, unallocatedEarnings: 400 })
  })

  it('keeps the single line for a fund', () => {
    const bs = balanceSheet(accounts, postings)
    expect(bs.equity.rows).toHaveLength(0)
    expect(bs.equity.total).toBe(900)
  })
})

describe('period-scoped statements', () => {
  const accounts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { id: 'cap', fundId: 'f', code: '3100', name: 'LP capital', type: 'equity', subtype: 'lp_capital' },
    { id: 'fee', fundId: 'f', code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
  ]
  // 100k called in 2025; a 2k fee in Q1-2026 and a 3k fee in Q2-2026.
  const postings: Posting[] = [
    { accountId: 'cash', amount: 100_000, currency: 'USD', entryDate: '2025-11-01' },
    { accountId: 'cap', amount: -100_000, currency: 'USD', entryDate: '2025-11-01' },
    { accountId: 'fee', amount: 2_000, currency: 'USD', entryDate: '2026-02-10' },
    { accountId: 'cash', amount: -2_000, currency: 'USD', entryDate: '2026-02-10' },
    { accountId: 'fee', amount: 3_000, currency: 'USD', entryDate: '2026-05-10' },
    { accountId: 'cash', amount: -3_000, currency: 'USD', entryDate: '2026-05-10' },
  ]

  it('income statement covers only the window', () => {
    const q2 = incomeStatement(accounts, postingsInPeriod(postings, '2026-04-01', '2026-06-30'))
    expect(q2.expenses.total).toBe(3_000) // NOT 5,000 — the Q1 fee is out of scope
    expect(q2.netIncome).toBe(-3_000)
  })

  it('balance sheet is cumulative to the period end, not just the window', () => {
    const bs = balanceSheet(accounts, postingsAsOf(postings, '2026-06-30'))
    expect(bs.assets.total).toBe(95_000)  // 100k − 2k − 3k
    expect(bs.equity.total).toBe(95_000)  // capital 100k + (−5k) undistributed
    expect(bs.check).toBe(0)
  })

  it('opening cash is the balance carried into the period', () => {
    expect(openingCashBalance('cash', postings, '2026-04-01')).toBe(98_000) // 100k − the Q1 fee
    expect(openingCashBalance('cash', postings, null)).toBe(0)
  })

  it('cash flows tie: opening + net change = ending', () => {
    const cash: CashPosting[] = postingsInPeriod(postings, '2026-04-01', '2026-06-30')
      .map(p => ({ ...p, entryId: 'q2fee', sourceType: 'management_fee' as string | null }))
    const cf = statementOfCashFlows('cash', cash, accounts, openingCashBalance('cash', postings, '2026-04-01'))
    expect(cf.openingCash).toBe(98_000)
    expect(cf.netChange).toBe(-3_000)
    expect(cf.endingCash).toBe(95_000)
  })
})

describe('schedule of investments', () => {
  const accts: Account[] = [
    { id: 'cost', fundId: 'f', code: '1100', name: 'Investments at cost', type: 'asset', subtype: 'investment' },
    { id: 'unrl', fundId: 'f', code: '1200', name: 'Unrealized', type: 'asset', subtype: 'unrealized' },
    // The INCOME side of a mark shares the 'unrealized' subtype. Counting it as part
    // of the carrying value would double every markup.
    { id: 'unrlInc', fundId: 'f', code: '4200', name: 'Change in unrealized', type: 'income', subtype: 'unrealized' },
  ]

  it('fair value counts the unrealized ASSET, not the unrealized income account', () => {
    const p: Posting[] = [
      { accountId: 'cost', amount: 2_749_992.64, currency: 'USD' },
      { accountId: 'unrl', amount: 1_178_583.08, currency: 'USD' },
      { accountId: 'unrlInc', amount: -1_178_583.08, currency: 'USD' }, // the credit side of the mark
    ]
    const soi = scheduleOfInvestments(accts, p, 3_992_163.79)
    expect(soi.ledgerCost).toBe(2_749_992.64)
    expect(soi.ledgerFairValue).toBe(3_928_575.72) // NOT 5,107,158.80
  })
  it('fair value = cost + unrealized, with % of net assets', () => {
    const p: Posting[] = [
      { accountId: 'cost', amount: 4_800_000, currency: 'USD' },
      { accountId: 'unrl', amount: 1_000_000, currency: 'USD' },
    ]
    const soi = scheduleOfInvestments(accts, p, 5_800_000)
    expect(soi.totalCost).toBe(4_800_000)
    expect(soi.totalFairValue).toBe(5_800_000)
    expect(soi.rows[0].pctOfNetAssets).toBe(1)
  })
})

describe('statement of changes in partners capital', () => {
  it('lists each LP plus a GP row with a totals column', () => {
    const caps = computeCapitalAccounts([
      { lpEntityId: 'a', amount: -100_000, sourceType: 'opening_balance' },
      { lpEntityId: 'a', amount: -50_000, sourceType: 'capital_call' },
      { lpEntityId: 'b', amount: -40_000, sourceType: 'opening_balance' },
    ])
    const names = new Map([['a', 'Smith'], ['b', 'Acme']])
    const st = changesInPartnersCapital(caps, names, 25_000)
    expect(st.partners).toHaveLength(3) // 2 LPs + GP
    expect(st.partners.find(p => p.id === 'gp')!.ending).toBe(25_000)
    expect(st.totals.ending).toBe(215_000) // 150k + 40k + 25k
    expect(st.totals.contributions).toBe(50_000)
  })
})

describe('statement of cash flows', () => {
  const accts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { id: 'inv', fundId: 'f', code: '1100', name: 'Investments at cost', type: 'asset', subtype: 'investment' },
    { id: 'cap', fundId: 'f', code: '3100', name: "Partners' capital", type: 'equity', subtype: 'lp_capital' },
    { id: 'note', fundId: 'f', code: '2200', name: 'Note payable', type: 'liability', subtype: 'note_payable' },
    { id: 'exp', fundId: 'f', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
    { id: 'int', fundId: 'f', code: '5300', name: 'Interest expense', type: 'expense', subtype: 'interest_expense' },
    { id: 'unrl', fundId: 'f', code: '1200', name: 'Unrealized appreciation', type: 'asset', subtype: 'unrealized' },
    { id: 'unrlInc', fundId: 'f', code: '4200', name: 'Change in unrealized', type: 'income', subtype: 'unrealized' },
  ]

  it('splits financing (capital, borrowings) from operating and ties to net change', () => {
    const cash: CashPosting[] = [
      { entryId: 'e1', accountId: 'cash', amount: 5_000_000, sourceType: 'capital_call' },
      { entryId: 'e1', accountId: 'cap', amount: -5_000_000, sourceType: 'capital_call' },
      { entryId: 'e2', accountId: 'cash', amount: -4_800_000, sourceType: 'manual' },
      { entryId: 'e2', accountId: 'inv', amount: 4_800_000, sourceType: 'manual' },
      { entryId: 'e3', accountId: 'cash', amount: -12_000, sourceType: 'partnership_expense' },
      { entryId: 'e3', accountId: 'exp', amount: 12_000, sourceType: 'partnership_expense' },
    ]
    const scf = statementOfCashFlows('cash', cash, accts, 0)
    expect(scf.financing.total).toBe(5_000_000)
    expect(scf.operating.total).toBe(-4_812_000) // investment purchase + expense
    expect(scf.netChange).toBe(188_000)
  })

  it('splits ONE payment of principal + interest across financing and operating', () => {
    // A single wire that is part loan principal (financing) and part accrued interest
    // (operating). Classifying by the entry's source_type would dump the whole thing
    // into financing.
    const cash: CashPosting[] = [
      { entryId: 'payoff', accountId: 'cash', amount: -20_689.95, sourceType: 'loan_repayment' },
      { entryId: 'payoff', accountId: 'note', amount: 14_992.64, sourceType: 'loan_repayment' },
      { entryId: 'payoff', accountId: 'int', amount: 5_697.31, sourceType: 'loan_repayment' },
    ]
    const scf = statementOfCashFlows('cash', cash, accts, 100_000)

    expect(scf.financing.total).toBe(-14_992.64)
    expect(scf.financing.lines[0]).toMatchObject({ code: '2200', name: 'Note payable' })

    expect(scf.operating.total).toBe(-5_697.31)
    expect(scf.operating.lines[0]).toMatchObject({ code: '5300', name: 'Interest expense' })

    expect(scf.netChange).toBe(-20_689.95) // still ties to the actual cash moved
    expect(scf.endingCash).toBe(79_310.05)
  })

  it('collapses per-LP capital accounts into one 3100 Partners’ capital line', () => {
    // A cash-flow statement reports "capital contributions", not one line per partner.
    const withLps: Account[] = [
      ...accts,
      { id: 'capA', fundId: 'f', code: '3100-aaaa', name: 'Partners’ capital — A', type: 'equity', subtype: 'lp_capital', lpEntityId: 'a' },
      { id: 'capB', fundId: 'f', code: '3100-bbbb', name: 'Partners’ capital — B', type: 'equity', subtype: 'lp_capital', lpEntityId: 'b' },
    ]
    const cash: CashPosting[] = [
      { entryId: 'c1', accountId: 'cash', amount: 600_000, sourceType: 'capital_call' },
      { entryId: 'c1', accountId: 'capA', amount: -600_000, sourceType: 'capital_call' },
      { entryId: 'c2', accountId: 'cash', amount: 400_000, sourceType: 'capital_call' },
      { entryId: 'c2', accountId: 'capB', amount: -400_000, sourceType: 'capital_call' },
    ]
    const scf = statementOfCashFlows('cash', cash, withLps, 0)
    expect(scf.financing.lines).toHaveLength(1)
    expect(scf.financing.lines[0]).toMatchObject({ code: '3100', name: "Partners' capital", amount: 1_000_000 })
  })

  it('ignores non-cash entries in the cash sections', () => {
    const cash: CashPosting[] = [
      { entryId: 'mark', accountId: 'unrl', amount: 500_000, sourceType: 'valuation' },
      { entryId: 'mark', accountId: 'unrlInc', amount: -500_000, sourceType: 'valuation' },
    ]
    const scf = statementOfCashFlows('cash', cash, accts, 0)
    expect(scf.netChange).toBe(0)
    expect(scf.operating.lines).toHaveLength(0)
    expect(scf.financing.lines).toHaveLength(0)
    // A revaluation is neither investing nor financing, so it isn't disclosed either.
    expect(scf.nonCash).toHaveLength(0)
  })

  it('DISCLOSES an investment bought with borrowed money that bypassed the bank', () => {
    // The lender paid the company directly. No cash moved, so neither the draw nor the
    // purchase can appear in the cash sections — but omitting them entirely makes the
    // loan look like it was repaid without ever being borrowed.
    const cash: CashPosting[] = [
      { entryId: 'draw', accountId: 'inv', amount: 2_749_992.64, sourceType: 'investment', entryDate: '2026-02-02', memo: 'Investment funded by loan' },
      { entryId: 'draw', accountId: 'note', amount: -2_749_992.64, sourceType: 'investment', entryDate: '2026-02-02', memo: 'Investment funded by loan' },
    ]
    const scf = statementOfCashFlows('cash', cash, accts, 0)
    expect(scf.netChange).toBe(0)
    expect(scf.operating.lines).toHaveLength(0)
    expect(scf.financing.lines).toHaveLength(0)

    expect(scf.nonCash).toHaveLength(1)
    expect(scf.nonCash[0]).toMatchObject({
      date: '2026-02-02',
      description: 'Investment funded by loan',
      amount: 2_749_992.64,
    })
  })

  it('DISCLOSES a loan repaid directly by a partner as their capital contribution', () => {
    const cash: CashPosting[] = [
      { entryId: 'direct', accountId: 'note', amount: 130_000, sourceType: 'capital_call', entryDate: '2026-02-26', memo: 'Partner paid the lender directly' },
      { entryId: 'direct', accountId: 'cap', amount: -130_000, sourceType: 'capital_call', entryDate: '2026-02-26', memo: 'Partner paid the lender directly' },
    ]
    const scf = statementOfCashFlows('cash', cash, accts, 0)
    expect(scf.netChange).toBe(0)
    expect(scf.nonCash).toHaveLength(1)
    expect(scf.nonCash[0].amount).toBe(130_000)
  })
})

describe('balance sheet for books that keep retained earnings', () => {
  // QuickBooks-style management company books: each member has their own equity account and
  // net income is never closed into capital. Prior years roll into retained earnings.
  const accounts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { id: 'david', fundId: 'f', code: '3010', name: 'David Contribution', type: 'equity', subtype: 'member_contributions' },
    { id: 'jeff', fundId: 'f', code: '3020', name: 'Jeff Contribution', type: 'equity', subtype: 'member_contributions' },
    { id: 're', fundId: 'f', code: '3300', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' },
    { id: 'fees', fundId: 'f', code: '4010', name: 'Fees', type: 'income', subtype: 'management_fee_income' },
    { id: 'rent', fundId: 'f', code: '5100', name: 'Rent', type: 'expense', subtype: 'occupancy' },
  ]
  const postings: Posting[] = [
    // 2024: 100k of fees, 30k of rent, 20k distributed to David and 10k to Jeff.
    { accountId: 'cash', amount: 100_000, currency: 'USD', entryDate: '2024-03-01' },
    { accountId: 'fees', amount: -100_000, currency: 'USD', entryDate: '2024-03-01' },
    { accountId: 'rent', amount: 30_000, currency: 'USD', entryDate: '2024-06-01' },
    { accountId: 'cash', amount: -30_000, currency: 'USD', entryDate: '2024-06-01' },
    { accountId: 'david', amount: 20_000, currency: 'USD', entryDate: '2024-12-15' },
    { accountId: 'jeff', amount: 10_000, currency: 'USD', entryDate: '2024-12-15' },
    { accountId: 'cash', amount: -30_000, currency: 'USD', entryDate: '2024-12-15' },
    // A journal entry straight to retained earnings, as QuickBooks books allow.
    { accountId: 're', amount: 5_000, currency: 'USD', entryDate: '2024-12-31' },
    { accountId: 'david', amount: -5_000, currency: 'USD', entryDate: '2024-12-31' },
    // 2025: 40k of fees.
    { accountId: 'cash', amount: 40_000, currency: 'USD', entryDate: '2025-02-01' },
    { accountId: 'fees', amount: -40_000, currency: 'USD', entryDate: '2025-02-01' },
  ]

  it('lists each equity account, rolls prior years into retained earnings and shows this year apart', () => {
    const bs = balanceSheet(accounts, postings, { equityLabel: "Members' capital", asOf: '2025-06-30' })
    expect(bs.equity.rows).toEqual([
      { code: '3010', name: 'David Contribution', amount: -15_000 },
      { code: '3020', name: 'Jeff Contribution', amount: -10_000 },
      { code: '3300', name: 'Retained Earnings', amount: 65_000 }, // −5k posted + 70k of 2024 net income
      { code: '', name: 'Net income', amount: 40_000 },
    ])
    expect(bs.equity.total).toBe(80_000)
    expect(bs.check).toBe(0)
    // Nothing waits on a close: earnings belong in retained earnings.
    expect(bs.partnersCapital.unallocatedEarnings).toBe(0)
  })

  it('takes the year from the latest posting when no date is given', () => {
    const bs = balanceSheet(accounts, postings)
    expect(bs.equity.rows.at(-1)).toEqual({ code: '', name: 'Net income', amount: 40_000 })
  })

  it('adds a retained earnings line when the account has no postings of its own', () => {
    const bs = balanceSheet(accounts, postings.slice(0, 7).concat(postings.slice(9)), { asOf: '2025-06-30' })
    expect(bs.equity.rows.find(row => row.code === '3300')).toEqual({ code: '3300', name: 'Retained Earnings', amount: 70_000 })
    expect(bs.check).toBe(0)
  })

  it('leaves a fund without retained earnings on its one total line', () => {
    const fund = accounts.filter(a => a.subtype !== 'retained_earnings')
    const bs = balanceSheet(fund, postings.filter(p => p.accountId !== 're'))
    expect(bs.equity.rows).toHaveLength(0)
  })
})
