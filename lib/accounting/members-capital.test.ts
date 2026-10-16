import { describe, it, expect } from 'vitest'
import { changesInMembersCapital, memberNameFromAccount } from './members-capital'
import { balanceSheet } from './statements'
import type { Account } from './types'
import type { SourcedPosting } from './load'

const acct = (id: string, code: string, name: string, type: Account['type'], subtype: string | null = null): Account =>
  ({ id, fundId: 'f', code, name, type, subtype })

// The shape of a management company's chart: P&L closes through the bridge into pooled members'
// capital, draws land in member distributions, and both are reclassed to the members' accounts.
const accounts: Account[] = [
  acct('cash', '1000', 'Cash', 'asset', 'cash'),
  acct('pool', '3000', "Members' capital", 'equity', 'members_capital'),
  acct('a', '3010', "Members' capital — Ann Lee", 'equity', 'member_contributions'),
  acct('b', '3020', "Members' capital — Bo Diaz", 'equity', 'member_contributions'),
  acct('draws', '3100', 'Member distributions', 'equity', 'member_distributions'),
  acct('bridge', '3200', 'Undistributed earnings (bridge)', 'equity', 'undistributed_earnings'),
  acct('fees', '4000', 'Management fee income', 'income'),
  acct('rent', '5100', 'Rent', 'expense'),
]

let n = 0
const entry = (date: string, legs: [string, number, string?][]): SourcedPosting[] => {
  const entryId = `e${++n}`
  return legs.map(([accountId, amount, lpEntityId]) => ({
    entryId, accountId, amount, currency: 'USD', lpEntityId: lpEntityId ?? null, sourceType: null, entryDate: date, memo: null,
  }))
}

const ledger: SourcedPosting[] = [
  // Each member puts in 50.
  ...entry('2024-01-05', [['cash', 100], ['draws', -100]]),
  ...entry('2024-01-05', [['draws', 50], ['a', -50, 'A']]),
  ...entry('2024-01-05', [['draws', 50], ['b', -50, 'B']]),
  // A year of fees and rent, closed through the bridge into pooled capital.
  ...entry('2024-06-30', [['cash', 1000], ['fees', -1000], ['bridge', 1000], ['pool', -1000]]),
  ...entry('2024-07-31', [['rent', 200], ['cash', -200], ['bridge', -200], ['pool', 200]]),
  // Net income allocated 50/50.
  ...entry('2024-12-31', [['pool', 800], ['a', -400, 'A'], ['b', -400, 'B']]),
  // Ann draws 300, reclassed to her account.
  ...entry('2025-02-01', [['draws', 300], ['cash', -300]]),
  ...entry('2025-02-01', [['a', 300, 'A'], ['draws', -300]]),
  // Fees not yet allocated at the period end.
  ...entry('2025-03-01', [['cash', 60], ['fees', -60], ['bridge', 60], ['pool', -60]]),
]

const bySum = (rows: { ending: number }[]) => Math.round(rows.reduce((s, r) => s + r.ending, 0) * 100) / 100

describe('changesInMembersCapital', () => {
  it('rolls each member forward since inception, with what is still pooled as its own row', () => {
    const { partners, totals } = changesInMembersCapital(accounts, ledger, { start: null, end: null })
    expect(partners.map(p => p.name)).toEqual(['Ann Lee', 'Bo Diaz', 'Not yet allocated to members'])
    const [ann, bo, pool] = partners
    expect(ann).toMatchObject({ id: 'A', beginning: 0, contributions: 50, operatingIncome: 400, distributions: -300, ending: 150 })
    expect(bo).toMatchObject({ id: 'B', contributions: 50, operatingIncome: 400, ending: 450 })
    expect(pool).toMatchObject({ operatingIncome: 60, contributions: 0, distributions: 0, transfers: 0, ending: 60 })
    // Every dollar is counted once: the totals are the entity's own activity.
    expect(totals).toMatchObject({ contributions: 100, operatingIncome: 860, distributions: -300, ending: 660 })
    expect(totals.ending).toBe(bySum(partners))
  })

  it('totals equal members\' capital on the balance sheet', () => {
    const { totals } = changesInMembersCapital(accounts, ledger, { start: null, end: null })
    const bs = balanceSheet(accounts, ledger, { equityLabel: "Members' capital", itemizeEquity: true })
    expect(totals.ending).toBe(bs.equity.total)
  })

  it('carries earlier activity into beginning capital for a period', () => {
    const { partners } = changesInMembersCapital(accounts, ledger, { start: '2025-01-01', end: '2025-12-31' })
    const ann = partners.find(p => p.id === 'A')!
    expect(ann).toMatchObject({ beginning: 450, contributions: 0, operatingIncome: 0, distributions: -300, ending: 150 })
    expect(partners.find(p => p.id === 'pool')).toMatchObject({ beginning: 0, operatingIncome: 60, ending: 60 })
  })

  it('stops at the period end', () => {
    const { partners, totals } = changesInMembersCapital(accounts, ledger, { start: null, end: '2024-12-31' })
    expect(partners.map(p => p.id)).toEqual(['A', 'B'])
    expect(totals.ending).toBe(900)
  })

  it('nets a move between two accounts of the same member to nothing', () => {
    const moved = [
      ...ledger,
      ...entry('2025-04-01', [['a', 150, 'A'], ['pool', -150, 'A']]),
    ]
    const ann = changesInMembersCapital(accounts, moved, { start: null, end: null }).partners.find(p => p.id === 'A')!
    expect(ann).toMatchObject({ transfers: 0, ending: 150 })
  })

  it('shows unclosed net income as retained earnings for a book that closes to retained earnings', () => {
    const re: Account[] = [
      acct('cash', '1000', 'Cash', 'asset'),
      acct('d', '3010', 'David Contribution', 'equity', 'member_contributions'),
      acct('re', '3300', 'Retained earnings', 'equity', 'retained_earnings'),
      acct('fees', '4000', 'Fees', 'income'),
    ]
    const postings = [
      ...entry('2025-01-02', [['cash', 10], ['d', -10]]),
      ...entry('2025-05-01', [['cash', 90], ['fees', -90]]),
    ]
    const { partners, totals } = changesInMembersCapital(re, postings, { start: null, end: null })
    expect(partners).toEqual([
      expect.objectContaining({ id: 'd', name: 'David Contribution', contributions: 10, ending: 10 }),
      expect.objectContaining({ id: 'pool', name: 'Retained earnings', operatingIncome: 90, ending: 90 }),
    ])
    expect(totals.ending).toBe(balanceSheet(re, postings, { itemizeEquity: true }).equity.total)
  })
})

describe('memberNameFromAccount', () => {
  it('drops the members\' capital prefix', () => {
    expect(memberNameFromAccount("Members' capital — Jeffrey Silverman")).toBe('Jeffrey Silverman')
    expect(memberNameFromAccount('Member capital - Paul Sethi')).toBe('Paul Sethi')
    expect(memberNameFromAccount('David Contribution')).toBe('David Contribution')
  })
})
