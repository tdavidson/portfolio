import { describe, it, expect } from 'vitest'
import { balanceSheet } from './statements'
import { computeCapitalAccounts, rollForwardTies } from './capital-account'
import { allocateAmount } from './allocation'
import { monthWindows, loadWalletCloseInputs, checkReadiness } from './close'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { Account, Posting } from './types'

describe('monthWindows', () => {
  it('splits a quarter into its three months', () => {
    expect(monthWindows('2026-01-01', '2026-03-31')).toEqual([
      { start: '2026-01-01', end: '2026-01-31', label: 'January 2026' },
      { start: '2026-02-01', end: '2026-02-28', label: 'February 2026' },
      { start: '2026-03-01', end: '2026-03-31', label: 'March 2026' },
    ])
  })

  it('keeps a partial first month (the ledger starts mid-month)', () => {
    const w = monthWindows('2026-02-19', '2026-03-31')
    expect(w).toHaveLength(2)
    expect(w[0]).toEqual({ start: '2026-02-19', end: '2026-02-28', label: 'February 2026' })
    expect(w[1].start).toBe('2026-03-01')
  })

  it('keeps a partial last month (closing mid-month)', () => {
    const w = monthWindows('2026-01-01', '2026-02-14')
    expect(w).toHaveLength(2)
    expect(w[1]).toEqual({ start: '2026-02-01', end: '2026-02-14', label: 'February 2026' })
  })

  it('handles a single month and crosses a year boundary', () => {
    expect(monthWindows('2026-05-01', '2026-05-31')).toHaveLength(1)
    const w = monthWindows('2025-11-01', '2026-01-31')
    expect(w.map(x => x.label)).toEqual(['November 2025', 'December 2025', 'January 2026'])
  })

  it('covers the span with no gaps and no overlaps', () => {
    const w = monthWindows('2026-01-15', '2026-04-10')
    for (let i = 1; i < w.length; i++) {
      const prevEnd = new Date(`${w[i - 1].end}T00:00:00Z`)
      const thisStart = new Date(`${w[i].start}T00:00:00Z`)
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(86_400_000) // exactly one day
    }
    expect(w[0].start).toBe('2026-01-15')
    expect(w[w.length - 1].end).toBe('2026-04-10')
  })

  it('returns nothing when the range is inverted', () => {
    expect(monthWindows('2026-03-01', '2026-01-01')).toEqual([])
  })
})

// Mirrors what closePeriodWithAllocation posts, so the arithmetic is locked down
// without needing a database. The real function does exactly this per category.
const accounts: Account[] = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'unrl', fundId: 'f', code: '1200', name: 'Unrealized', type: 'asset', subtype: 'unrealized' },
  { id: 'capA', fundId: 'f', code: '3100-a', name: 'Capital — A', type: 'equity', subtype: 'lp_capital', lpEntityId: 'a' },
  { id: 'capB', fundId: 'f', code: '3100-b', name: 'Capital — B', type: 'equity', subtype: 'lp_capital', lpEntityId: 'b' },
  { id: 'bridge', fundId: 'f', code: '3200', name: 'Undistributed earnings', type: 'equity', subtype: 'undistributed_earnings' },
  { id: 'unrlInc', fundId: 'f', code: '4200', name: 'Change in unrealized', type: 'income', subtype: 'unrealized' },
  { id: 'fee', fundId: 'f', code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
]

const owners = [{ lpEntityId: 'a', commitment: 600_000 }, { lpEntityId: 'b', commitment: 400_000 }]

// Books BEFORE any close: 1M called, a 100k fee, a 500k markup. Nothing allocated.
const preClose: Posting[] = [
  { accountId: 'cash', amount: 1_000_000, currency: 'USD', entryDate: '2026-01-15' },
  { accountId: 'capA', amount: -600_000, currency: 'USD', lpEntityId: 'a', entryDate: '2026-01-15' },
  { accountId: 'capB', amount: -400_000, currency: 'USD', lpEntityId: 'b', entryDate: '2026-01-15' },
  { accountId: 'fee', amount: 100_000, currency: 'USD', entryDate: '2026-02-01' },
  { accountId: 'cash', amount: -100_000, currency: 'USD', entryDate: '2026-02-01' },
  { accountId: 'unrl', amount: 500_000, currency: 'USD', entryDate: '2026-03-31' },
  { accountId: 'unrlInc', amount: -500_000, currency: 'USD', entryDate: '2026-03-31' },
]

/** One balanced allocation entry per category, exactly as the close posts them. */
function allocationPostings(capitalEffect: number, capAccount: Record<string, string>): Posting[] {
  const split = allocateAmount(capitalEffect, owners)
  return [
    { accountId: 'bridge', amount: capitalEffect, currency: 'USD', entryDate: '2026-03-31' },
    ...Array.from(split.entries()).map(([lp, share]) => ({
      accountId: capAccount[lp],
      amount: -share,
      currency: 'USD',
      lpEntityId: lp,
      entryDate: '2026-03-31',
    })),
  ]
}

const capAccount = { a: 'capA', b: 'capB' }
// Fee reduces capital (−100k); the mark increases it (+500k).
const feeAlloc = allocationPostings(-100_000, capAccount)
const markAlloc = allocationPostings(500_000, capAccount)
const postClose = [...preClose, ...feeAlloc, ...markAlloc]

describe('period close allocation', () => {
  it('before closing, capital accounts hold only contributions', () => {
    const caps = computeCapitalAccounts(
      preClose.filter(p => p.lpEntityId).map(p => ({ lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: 'capital_call', entryDate: p.entryDate }))
    )
    expect(caps.get('a')!.ending).toBe(600_000)
    expect(caps.get('b')!.ending).toBe(400_000)

    const bs = balanceSheet(accounts, preClose)
    expect(bs.partnersCapital.total).toBe(1_400_000)       // net assets
    expect(bs.partnersCapital.unallocatedEarnings).toBe(400_000) // 500k mark − 100k fee
    expect(bs.check).toBe(0)
  })

  it('each allocation entry balances on its own', () => {
    for (const entry of [feeAlloc, markAlloc]) {
      expect(entry.reduce((s, p) => s + p.amount, 0)).toBe(0)
    }
  })

  it('after closing, capital accounts carry each partner’s share, split by commitment', () => {
    const capitalPostings = [
      ...preClose.filter(p => p.lpEntityId).map(p => ({ lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: 'capital_call', entryDate: p.entryDate })),
      ...feeAlloc.filter(p => p.lpEntityId).map(p => ({ lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: 'management_fee', entryDate: p.entryDate })),
      ...markAlloc.filter(p => p.lpEntityId).map(p => ({ lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: 'valuation', entryDate: p.entryDate })),
    ]
    const caps = computeCapitalAccounts(capitalPostings)
    const a = caps.get('a')!
    const b = caps.get('b')!

    // A holds 60% of commitments, B 40%.
    expect(a.contributions).toBe(600_000)
    expect(a.managementFees).toBe(-60_000)
    expect(a.unrealizedGains).toBe(300_000)
    expect(a.ending).toBe(840_000)
    expect(rollForwardTies(a)).toBe(true)

    expect(b.managementFees).toBe(-40_000)
    expect(b.unrealizedGains).toBe(200_000)
    expect(b.ending).toBe(560_000)
    expect(rollForwardTies(b)).toBe(true)

    // Capital accounts now sum to net assets — the whole point of the close.
    expect(a.ending + b.ending).toBe(1_400_000)
  })

  it('the bridge cancels the double-count, so the balance sheet still balances', () => {
    const bs = balanceSheet(accounts, postClose)
    expect(bs.assets.total).toBe(1_400_000)
    expect(bs.partnersCapital.total).toBe(1_400_000)
    expect(bs.partnersCapital.unallocatedEarnings).toBe(0) // fully allocated now
    expect(bs.check).toBe(0)
  })

  it('reopening (voiding the allocation entries) restores the pre-close state exactly', () => {
    // Voiding removes the allocation postings from the ledger — nothing else changes.
    const reopened = postClose.filter(p => !feeAlloc.includes(p) && !markAlloc.includes(p))
    expect(reopened).toEqual(preClose)

    const bs = balanceSheet(accounts, reopened)
    expect(bs.partnersCapital.unallocatedEarnings).toBe(400_000)
    expect(bs.check).toBe(0)
  })
})

describe('loadWalletCloseInputs', () => {
  const buy = (company: string, group: string, date: string) => ({
    id: `${company}-${group}-${date}`, fund_id: 'f', company_id: company, transaction_type: 'investment',
    portfolio_group: group, transaction_date: date, shares_acquired: 10, investment_cost: 100,
  })
  const wallet = (id: string, company: string, group: string | null = null) => ({
    id, fund_id: 'f', company_id: company, chain: 'ethereum', address: `0x${id}`, portfolio_group: group, active: true,
  })
  const bal = (walletId: string, date: string) => ({ fund_id: 'f', wallet_id: walletId, as_of_date: date, units: '5', block_height: 1 })
  const companies = [{ id: 'c1', fund_id: 'f', name: 'Coin' }, { id: 'c2', fund_id: 'f', name: 'Other' }]
  const load = (seed: Record<string, any[]>, group = 'Fund I') =>
    loadWalletCloseInputs(memoryAdmin({ companies, ...seed }).admin as any, 'f', group, '2026-03-31')

  it("leaves another entity's wallet out of this entity's close", async () => {
    const out = await load({
      investment_transactions: [buy('c1', 'Fund I', '2026-01-05'), buy('c2', 'Fund II', '2026-01-05')],
      crypto_wallets: [wallet('w1', 'c1', 'Fund I'), wallet('w2', 'c2', 'Fund II')],
      crypto_wallet_balances: [bal('w1', '2026-03-30'), bal('w2', '2026-03-30')],
    })
    expect(out!.wallets.map(w => w.id)).toEqual(['w1'])
    expect(out!.balances.map(b => b.walletId)).toEqual(['w1'])
    expect(await load({
      investment_transactions: [buy('c2', 'Fund II', '2026-01-05')],
      crypto_wallets: [wallet('w2', 'c2', 'Fund II')],
    })).toBeNull()
  })

  it('counts an untagged wallet for neither entity when two hold the holding', async () => {
    const seed = {
      investment_transactions: [buy('c1', 'Fund I', '2026-01-05'), buy('c1', 'Fund II', '2026-02-05')],
      crypto_wallets: [wallet('w1', 'c1')],
    }
    expect(await load(seed, 'Fund I')).toBeNull()
    expect(await load(seed, 'Fund II')).toBeNull()
  })

  it('still counts an untagged wallet for the first holder when the second bought after the period end', async () => {
    const out = await load({
      investment_transactions: [buy('c1', 'Fund I', '2026-01-05'), buy('c1', 'Fund II', '2026-05-05')],
      crypto_wallets: [wallet('w1', 'c1')],
    })
    expect(out!.wallets.map(w => w.id)).toEqual(['w1'])
  })

  it('excludes a balance dated after the period end', async () => {
    const out = await load({
      investment_transactions: [buy('c1', 'Fund I', '2026-01-05')],
      crypto_wallets: [wallet('w1', 'c1', 'Fund I')],
      crypto_wallet_balances: [bal('w1', '2026-03-30'), bal('w1', '2026-04-02')],
    })
    expect(out!.balances.map(b => b.asOfDate)).toEqual(['2026-03-30'])
  })

  it('rejects when the balances read fails, and the close turns that into a blocker', async () => {
    const seed = {
      companies,
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }],
      investment_transactions: [buy('c1', 'Fund I', '2026-01-05')],
      crypto_wallets: [wallet('w1', 'c1', 'Fund I')],
    }
    const a = memoryAdmin(seed)
    a.failNext('crypto_wallet_balances', 'select', 'boom')
    await expect(loadWalletCloseInputs(a.admin as any, 'f', 'Fund I', '2026-03-31')).rejects.toThrow(/boom/)

    const b = memoryAdmin(seed)
    b.failNext('crypto_wallet_balances', 'select', 'boom')
    const readiness = await checkReadiness(b.admin as any, 'f', 'Fund I', '2026-01-01', '2026-03-31')
    expect(readiness.blockers.some(x => x.includes('could not be read') && x.includes('boom'))).toBe(true)
  })
})
