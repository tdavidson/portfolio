import { describe, it, expect } from 'vitest'
import { exitPostings, type ExitAccounts } from './from-portfolio'
import { assertBalanced } from './ledger'

const ACC: ExitAccounts = {
  cashId: 'cash',
  gainId: 'gain4000',
  costId: 'cost1100',
  unrealizedId: 'unreal1200',
  fxId: 'fx1250',
  escrowId: 'escrow1350',
  unrealizedIncomeId: 'unrealInc4200',
  fxIncomeId: 'fxInc4300',
}

const bal = (postings: ReturnType<typeof exitPostings>, id: string) =>
  Math.round(postings.filter(p => p.accountId === id).reduce((s, p) => s + p.amount, 0) * 100) / 100

const balanced = (postings: ReturnType<typeof exitPostings>) =>
  assertBalanced({ fundId: 'f', entryDate: '2026-01-01', postings } as any)

describe('exitPostings', () => {
  it('unwinds the accumulated mark on a full exit, so nothing lingers on the balance sheet', () => {
    // Bought at 1m, marked up to 3m (so 1200 carries 2m), exited for 3m.
    const p = exitPostings(
      { proceeds: 3_000_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: 2_000_000, fx: 0 } },
      ACC
    )
    expect(() => balanced(p)).not.toThrow()

    expect(bal(p, 'cash')).toBe(3_000_000)
    expect(bal(p, 'cost1100')).toBe(-1_000_000) // cost off the books
    expect(bal(p, 'unreal1200')).toBe(-2_000_000) // the mark comes off too — this was the bug
    expect(bal(p, 'gain4000')).toBe(-2_000_000) // realized gain = proceeds - basis

    // The unwind is a RECLASSIFICATION: it debits back the 4200 that recognised the markup,
    // so cumulative P&L is 2m of gain, not 4m.
    expect(bal(p, 'unrealInc4200')).toBe(2_000_000)
    const cumulativePnl = bal(p, 'gain4000') + bal(p, 'unrealInc4200')
    expect(cumulativePnl).toBe(0) // net-zero *for this entry* — the 2m was already in 4200
  })

  it('leaves no residual asset balance after a full exit', () => {
    const carried = { cost: 500_000, unrealized: 250_000, fx: 40_000 }
    const p = exitPostings({ proceeds: 790_000, basis: 500_000, carried }, ACC)

    // Every asset account for this company must net to zero once the entry posts.
    expect(carried.cost + bal(p, 'cost1100')).toBe(0)
    expect(carried.unrealized + bal(p, 'unreal1200')).toBe(0)
    expect(carried.fx + bal(p, 'fx1250')).toBe(0)
    expect(() => balanced(p)).not.toThrow()
  })

  it('unwinds FX separately from the mark — a rate move is not investment performance', () => {
    const p = exitPostings(
      { proceeds: 1_500_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: 300_000, fx: 100_000 } },
      ACC
    )
    expect(bal(p, 'unreal1200')).toBe(-300_000)
    expect(bal(p, 'fx1250')).toBe(-100_000)
    // They land in DIFFERENT income accounts, so an LP can still see performance apart from
    // what the exchange rate did.
    expect(bal(p, 'unrealInc4200')).toBe(300_000)
    expect(bal(p, 'fxInc4300')).toBe(100_000)
    expect(() => balanced(p)).not.toThrow()
  })

  it('unwinds pro-rata on a partial exit', () => {
    // Half the cost basis leaves → half the accumulated mark and FX leave with it.
    const p = exitPostings(
      { proceeds: 900_000, basis: 500_000, carried: { cost: 1_000_000, unrealized: 400_000, fx: 60_000 } },
      ACC
    )
    expect(bal(p, 'cost1100')).toBe(-500_000)
    expect(bal(p, 'unreal1200')).toBe(-200_000) // 50% of 400k
    expect(bal(p, 'fx1250')).toBe(-30_000)      // 50% of 60k
    expect(bal(p, 'gain4000')).toBe(-400_000)
    expect(() => balanced(p)).not.toThrow()
  })

  it('handles a markdown (negative accumulated unrealized) without flipping signs', () => {
    // Bought at 1m, written down to 400k (1200 carries -600k), sold for 400k → 600k loss.
    const p = exitPostings(
      { proceeds: 400_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: -600_000, fx: 0 } },
      ACC
    )
    expect(bal(p, 'unreal1200')).toBe(600_000)   // reversing a negative balance is a debit
    expect(bal(p, 'unrealInc4200')).toBe(-600_000)
    expect(bal(p, 'gain4000')).toBe(600_000)     // a realized LOSS (debit)
    expect(() => balanced(p)).not.toThrow()
  })

  it('treats an exit with no cost left on the books as a full unwind', () => {
    // A fully written-off position that later returns something (escrow, clawback).
    const p = exitPostings(
      { proceeds: 50_000, basis: 0, carried: { cost: 0, unrealized: 120_000, fx: 0 } },
      ACC
    )
    expect(bal(p, 'unreal1200')).toBe(-120_000) // fraction = 1, not 0/0 = NaN
    expect(bal(p, 'gain4000')).toBe(-50_000)
    expect(() => balanced(p)).not.toThrow()
  })

  it('never unwinds more than what is carried, even if the basis overshoots', () => {
    const p = exitPostings(
      { proceeds: 100_000, basis: 5_000_000, carried: { cost: 1_000_000, unrealized: 200_000, fx: 0 } },
      ACC
    )
    // fraction is clamped to 1 — we cannot take off more mark than exists.
    expect(bal(p, 'unreal1200')).toBe(-200_000)
    expect(() => balanced(p)).not.toThrow()
  })

  it('recognises escrow as a receivable, so the gain matches the tracker', () => {
    // Sold for 3m: 2.5m wired, 500k held back in escrow. The TRACKER counts all 3m as
    // proceeds at close (computeSummary). The ledger used to book only the 2.5m, so its
    // realized gain was short by exactly the escrow — on every exit with a holdback.
    const p = exitPostings(
      { proceeds: 2_500_000, escrow: 500_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: 0, fx: 0 } },
      ACC
    )
    expect(() => balanced(p)).not.toThrow()

    expect(bal(p, 'cash')).toBe(2_500_000)       // only the cash that actually arrived
    expect(bal(p, 'escrow1350')).toBe(500_000)   // earned, not yet collected
    expect(bal(p, 'cost1100')).toBe(-1_000_000)
    // Gain is on TOTAL consideration (3m - 1m), which is what the tracker reports.
    expect(bal(p, 'gain4000')).toBe(-2_000_000)
  })

  it('does not double-count when the escrow is later received', () => {
    // At exit: Dr escrow 500k. When the money lands, the escrow receipt on the holding posts
    // Dr Cash / Cr 1350 — the receivable clears and NO new gain is booked.
    const atExit = exitPostings(
      { proceeds: 0, escrow: 500_000, basis: 0, carried: { cost: 0, unrealized: 0, fx: 0 } },
      ACC
    )
    expect(bal(atExit, 'escrow1350')).toBe(500_000)
    expect(bal(atExit, 'gain4000')).toBe(-500_000) // recognised ONCE, at the exit

    // The later receipt (from-portfolio.escrow.test.ts derives it) nets 1350 to zero.
    const onReceipt = -500_000
    expect(bal(atExit, 'escrow1350') + onReceipt).toBe(0)
  })

  it('falls back to cash-only when the chart has no escrow account', () => {
    // A vehicle whose chart was seeded before 1350 existed must not post an unbalanced entry.
    // It books the old way until the chart is re-synced.
    const { escrowId, ...noEscrow } = ACC
    const p = exitPostings(
      { proceeds: 2_500_000, escrow: 500_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: 0, fx: 0 } },
      noEscrow
    )
    expect(() => balanced(p)).not.toThrow()
    expect(bal(p, 'escrow1350')).toBe(0)
    expect(bal(p, 'gain4000')).toBe(-1_500_000) // gain on cash only — the old, understated figure
  })

  it('denominates every posting in the fund currency', () => {
    const p = exitPostings(
      { proceeds: 1_000, escrow: 100, basis: 500, carried: { cost: 500, unrealized: 200, fx: 50 } },
      ACC,
      'EUR'
    )
    expect(p.every(x => x.currency === 'EUR')).toBe(true)
    expect(() => balanced(p)).not.toThrow()
  })

  it('books a plain exit with no marks exactly as before', () => {
    // Regression guard: a position never marked has no 1200/1250 balance, so the entry must
    // be the original three lines and nothing more.
    const p = exitPostings(
      { proceeds: 1_200_000, basis: 1_000_000, carried: { cost: 1_000_000, unrealized: 0, fx: 0 } },
      ACC
    )
    expect(p).toHaveLength(3)
    expect(bal(p, 'cash')).toBe(1_200_000)
    expect(bal(p, 'cost1100')).toBe(-1_000_000)
    expect(bal(p, 'gain4000')).toBe(-200_000)
  })
})
