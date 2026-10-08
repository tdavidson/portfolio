import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./persist', () => ({ accountIdByCode: async () => new Map([['1000', 'cash']]) }))
import { checkInvestmentMatch, rankBankCandidates, matchInvestmentToBank, unbankedInvestments } from './investment-bank-match'

const E1 = '00000000-0000-0000-0000-0000000000e1'
const OLD = '00000000-0000-0000-0000-0000000000e0'
const LINKED = '00000000-0000-0000-0000-0000000000e2'
const bankRow = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', amount: -1000, txn_date: '2026-10-06', description: 'Wire', status: 'drafted', journal_entry_id: null, raw: {}, ...over })
const posted = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-10-05', memo: `Investment ${id}`, source_ref: `txn:${id}`, ...over })
const seed = (entries: any[], bank: any[], extra: Record<string, any[]> = {}, opts: any = {}) => memoryAdmin({
  journal_entries: entries,
  journal_postings: entries.map(e => ({ journal_entry_id: e.id, book: 'actual', fund_id: 'f', account_id: 'cash', amount: -1000 })),
  bank_transactions: bank,
  investment_transactions: entries.filter(e => e.source_ref?.startsWith('txn:')).map(e => ({ id: e.source_ref.slice(4), fund_id: 'f' })),
  ...extra,
}, { unique: [{ table: 'bank_transactions', key: r => r.journal_entry_id ?? null }], ...opts })

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

describe('checkInvestmentMatch — the rest of the rules', () => {
  const entry = { status: 'posted' }
  const bank = { amount: -1000, status: 'drafted', raw: {} }
  it('accepts a difference under a cent — rounding, not a different payment', () => {
    expect(checkInvestmentMatch({ entry, bank: { ...bank, amount: -999.996 }, cash: -1000, claimedBy: null })).toBeNull()
  })
  it('refuses the opposite direction — a deposit is not a purchase', () => {
    expect(checkInvestmentMatch({ entry, bank: { ...bank, amount: 1000 }, cash: -1000, claimedBy: null })).toBeTruthy()
  })
  it('refuses a bank row already reconciled to something else', () => {
    expect(checkInvestmentMatch({ entry, bank: { ...bank, status: 'reconciled' }, cash: -1000, claimedBy: null })).toMatch(/already/)
  })
  it('refuses a bank row claimed by a derived draft', () => {
    expect(checkInvestmentMatch({ entry, bank, cash: -1000, claimedBy: { status: 'draft', source_ref: 'txn:t9' } })).toMatch(/already/)
  })
})

describe('rankBankCandidates', () => {
  const row = (id: string, over: any = {}) => ({ id, amount: -1000, txn_date: '2026-03-02', status: 'drafted', raw: {}, ...over })
  it('keeps only same-amount open rows not under review, nearest date first', () => {
    const ranked = rankBankCandidates(-1000, '2026-03-01', [
      row('far', { txn_date: '2026-03-20' }), row('near', { txn_date: '2026-02-28' }),
      row('wrong-amount', { amount: -500 }), row('taken', { status: 'reconciled' }),
      row('held', { raw: { investmentReview: true } }), row('qb', { raw: { quickbooksReview: true } }),
    ])
    expect(ranked.map(r => r.id)).toEqual(['near', 'far'])
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

describe('matchInvestmentToBank — refusals write nothing', () => {
  const world = (opts: any = {}) => seed([posted(E1), { id: 'auto', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', source_ref: null }],
    [bankRow('b1', { journal_entry_id: 'auto' })], {}, opts)
  const untouched = (m: any) => {
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'drafted', journal_entry_id: 'auto' })
    expect(m.tables.journal_entries.map((e: any) => e.id).sort()).toEqual(['auto', E1].sort())
  }
  it('when the bank row changed between reading and claiming it', async () => {
    const m = world({ before: (t: string, op: string, _p: any, tables: any) => {
      if (t === 'bank_transactions' && op === 'update') Object.assign(tables.bank_transactions[0], { status: 'reconciled', journal_entry_id: 'other' })
    } })
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: expect.stringMatching(/changed while you were matching/) })
    expect(m.tables.journal_entries.map((e: any) => e.id).sort()).toEqual(['auto', E1].sort())
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'other' })
  })
  it('maps a unique-index error to "already matched to another bank transaction"', async () => {
    const m = world()
    m.failNext('bank_transactions', 'update', 'duplicate key value violates unique constraint')
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: expect.stringMatching(/already matched to another bank transaction/) })
    untouched(m)
  })
  it('a bank row from another vehicle', async () => {
    const m = world(); m.tables.bank_transactions[0].vehicle_id = 'v2'
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: 'Bank transaction not found' })
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'drafted', journal_entry_id: 'auto' })
  })
  it("another fund's bank row", async () => {
    const m = world(); m.tables.bank_transactions[0].fund_id = 'f2'
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: 'Bank transaction not found' })
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'drafted', journal_entry_id: 'auto' })
  })
  it('an amount mismatch', async () => {
    const m = world(); m.tables.bank_transactions[0].amount = -900
    expect('error' in (await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1'))).toBe(true)
    untouched(m)
  })
  it('an entry whose txn: ref names no transaction', async () => {
    const m = world(); m.tables.investment_transactions.length = 0
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toEqual({ error: expect.stringMatching(/investment entry/) })
    untouched(m)
  })
  it('warns when the auto-draft could not be deleted, still matched', async () => {
    const m = world()
    m.failNext('journal_entries', 'delete', 'boom')
    expect(await matchInvestmentToBank(m.admin, 'f', 'Fund I', E1, 'b1')).toMatchObject({ ok: true, entryId: E1, warning: expect.stringMatching(/auto/) })
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: E1 })
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
  it('does not list an entry whose txn: ref names no transaction', async () => {
    const m = seed([posted(E1), posted('00000000-0000-0000-0000-0000000000e9')], [bankRow('first', { txn_date: '2026-06-01', amount: -5, status: 'reconciled' })])
    m.tables.investment_transactions = m.tables.investment_transactions.filter((t: any) => t.id === E1)
    expect((await unbankedInvestments(m.admin, 'f', 'Fund I')).map(i => i.entryId)).toEqual([E1])
  })
  it('lists nothing for a vehicle with no bank rows', async () => {
    expect(await unbankedInvestments(seed([posted(E1)], []).admin, 'f', 'Fund I')).toEqual([])
  })
})
