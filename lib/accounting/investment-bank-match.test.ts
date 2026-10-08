import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./persist', () => ({ accountIdByCode: async () => new Map([['1000', 'cash']]) }))
import { checkInvestmentMatch, matchInvestmentToBank, unbankedInvestments } from './investment-bank-match'

const E1 = '00000000-0000-0000-0000-0000000000e1'
const OLD = '00000000-0000-0000-0000-0000000000e0'
const LINKED = '00000000-0000-0000-0000-0000000000e2'
const bankRow = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', amount: -1000, txn_date: '2026-10-06', description: 'Wire', status: 'drafted', journal_entry_id: null, raw: {}, ...over })
const posted = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-10-05', memo: `Investment ${id}`, source_ref: `txn:${id}`, ...over })
const seed = (entries: any[], bank: any[], extra: Record<string, any[]> = {}) => memoryAdmin({
  journal_entries: entries,
  journal_postings: entries.map(e => ({ journal_entry_id: e.id, book: 'actual', fund_id: 'f', account_id: 'cash', amount: -1000 })),
  bank_transactions: bank,
  investment_transactions: entries.filter(e => e.source_ref?.startsWith('txn:')).map(e => ({ id: e.source_ref.slice(4), fund_id: 'f' })),
  ...extra,
}, { unique: [{ table: 'bank_transactions', key: r => r.journal_entry_id ?? null }] })

describe('checkInvestmentMatch', () => {
  const bank = { amount: -1000, status: 'drafted', raw: {} }
  it('needs a posted entry, the same amount, and a row nobody else holds', () => {
    expect(checkInvestmentMatch({ entry: { status: 'posted' }, bank, cash: -1000, claimedBy: null })).toBeNull()
    expect(checkInvestmentMatch({ entry: { status: 'draft' }, bank, cash: -1000, claimedBy: null })).toMatch(/not posted/)
    expect(checkInvestmentMatch({ entry: { status: 'posted' }, bank, cash: -900, claimedBy: null })).toMatch(/same payment/)
    expect(checkInvestmentMatch({ entry: { status: 'posted' }, bank: { ...bank, raw: { investmentReview: true } }, cash: -1000, claimedBy: null })).toMatch(/Review/)
    expect(checkInvestmentMatch({ entry: { status: 'posted' }, bank, cash: -1000, claimedBy: { status: 'posted', source_ref: null } })).toMatch(/already matched/)
  })
})

describe('matchInvestmentToBank', () => {
  it('links the row to the posted entry and retires the auto-draft, posting nothing', async () => {
    const m = seed([posted(E1), { id: 'auto', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', source_ref: null }], [bankRow('b1', { journal_entry_id: 'auto' })])
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ ok: true, entryId: E1 })
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: E1 })
    expect(m.tables.journal_entries.map((e: any) => e.id)).toEqual([E1])
  })
  it('refuses an entry no investment transaction owns', async () => {
    const m = seed([posted(E1, { source_ref: null })], [bankRow('b1')])
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: expect.stringMatching(/investment entry/) })
  })
})

describe('unbankedInvestments', () => {
  it('lists posted owned entries with no bank row, from the first bank row on, with candidates', async () => {
    const m = seed([posted(OLD, { entry_date: '2026-01-01' }), posted(E1), posted(LINKED)],
      [bankRow('first', { txn_date: '2026-06-01', amount: -5, status: 'reconciled' }), bankRow('b1'), bankRow('lk', { journal_entry_id: LINKED, status: 'reconciled' })])
    const list = await unbankedInvestments(m.admin, 'f', 'Fund I')
    expect(list.map(i => i.entryId)).toEqual([E1])
    expect(list[0].candidates.map(c => c.id)).toEqual(['b1'])
  })
  it('lists nothing for a vehicle with no bank rows', async () => {
    expect(await unbankedInvestments(seed([posted(E1)], []).admin, 'f', 'Fund I')).toEqual([])
  })
})
