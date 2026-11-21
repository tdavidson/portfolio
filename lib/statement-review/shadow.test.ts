import { describe, expect, it } from 'vitest'
import { carryFreeFrom, feePeriodStarts, shadowFromLedger } from './shadow'

const accounts = [
  { id: 'a-cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' as const, subtype: 'cash' },
  { id: 'a-fee', fundId: 'f', code: '5100', name: 'Management fees', type: 'expense' as const },
  { id: 'a-cap', fundId: 'f', code: '3000-acme', name: 'Capital: Acme Partners LP', type: 'equity' as const, lpEntityId: 'lp-acme' },
]
const p = (accountId: string, amount: number, entryDate: string, lpEntityId?: string) => ({ accountId, amount, currency: 'USD', entryDate, ...(lpEntityId ? { lpEntityId } : {}) })
const postings = [
  p('a-cash', 100_000, '2026-04-15'), p('a-cap', -100_000, '2026-04-15', 'lp-acme'),
  p('a-cash', 50_000, '2026-08-01'), p('a-cap', -50_000, '2026-08-01', 'lp-acme'),
  p('a-fee', 5_000, '2026-09-30'), p('a-cash', -5_000, '2026-09-30'),
]
const capitalPostings = [
  { accountId: 'a-cap', amount: -100_000, currency: 'USD', entryDate: '2026-04-15', lpEntityId: 'lp-acme', sourceType: 'capital_call' },
  { accountId: 'a-cap', amount: -50_000, currency: 'USD', entryDate: '2026-08-01', lpEntityId: 'lp-acme', sourceType: 'capital_call' },
]
const data = { accounts, postings, capitalPostings, names: new Map([['lp-acme', 'Acme Partners LP']]) } as any
const period = { start: '2026-07-01', end: '2026-09-30' }

describe('shadowFromLedger', () => {
  it("takes each partner's flows for the period only", () => {
    const s = shadowFromLedger(data, period, null, null)
    expect(s.partners).toEqual([{ lpEntityId: 'lp-acme', name: 'Acme Partners LP', contributions: 50_000, distributions: 0, carry: 0 }])
  })

  it('takes account balances at the period end and movement within it, on the normal side', () => {
    const s = shadowFromLedger(data, period, null, null)
    expect(s.accounts?.find(a => a.code === '1000')).toMatchObject({ balance: 145_000, movement: 45_000 })
    expect(s.accounts?.find(a => a.code === '5100')).toMatchObject({ balance: 5_000, movement: 5_000 })
    expect(s.cash).toEqual({ ledger: 145_000, bank: null, bankThrough: null })
  })

  it("works out the bank balance from the feed when it reaches the period", () => {
    const s = shadowFromLedger(data, period, null, { amounts: [{ date: '2026-08-01', amount: 50_000 }, { date: '2026-09-30', amount: -5_000 }] })
    // Opening: ledger cash before the feed's first day (100,000), then the feed's own rows.
    expect(s.cash).toEqual({ ledger: 145_000, bank: 145_000, bankThrough: '2026-09-30' })
  })

  it('leaves partners null when the books hold no capital postings', () => {
    expect(shadowFromLedger({ ...data, capitalPostings: [] }, period, null, null).partners).toBeNull()
  })
})

describe('feePeriodStarts', () => {
  const schedule = { frequency: 'quarterly' as const, start: '2026-02-15', end: '2030-02-15' }
  it('takes the fee periods that start in the review period', () => {
    expect(feePeriodStarts(schedule, { start: '2026-07-01', end: '2026-09-30' })).toEqual(['2026-08-15'])
    expect(feePeriodStarts({ ...schedule, frequency: 'annual' }, { start: '2026-07-01', end: '2026-09-30' })).toEqual([])
    expect(feePeriodStarts(schedule, { start: '2026-01-01', end: '2026-12-31' })).toEqual(['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15'])
  })
  it('stops at the end of the schedule', () => {
    expect(feePeriodStarts({ ...schedule, end: '2026-06-01' }, { start: '2026-01-01', end: '2026-12-31' })).toEqual(['2026-02-15', '2026-05-15'])
  })
})

describe('carryFreeFrom', () => {
  const left = [{ lpEntityId: 'lp-staff', category: 'carried_interest' as const, participates: false, weightOverride: null, rateOverride: null }]
  it('frees the recipients and anyone the terms leave out of carry', () => {
    expect(carryFreeFrom({ recipients: [{ lpEntityId: 'lp-gp' }] }, left).sort()).toEqual(['lp-gp', 'lp-staff'])
  })
  it('charges the recipients when the GP commit bears carry', () => {
    expect(carryFreeFrom({ recipients: [{ lpEntityId: 'lp-gp' }], gpCommitBearsCarry: true }, left)).toEqual(['lp-staff'])
  })
})
