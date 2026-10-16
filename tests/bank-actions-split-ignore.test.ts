// The agent's bank tools: set_bank_transaction_account's replaceSplit, and ignore_bank_transaction.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('@/lib/accounting/continuous-allocation', () => ({
  setGeneratedAllocationStatus: async () => ({}),
  postExistingEntryWithAllocation: async () => ({}),
}))
import { ignoreBankTransaction, setBankTransactionAccount } from '@/lib/accounting/bank-actions'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', portfolio_group: 'Fund I', code: '1000', type: 'asset', subtype: 'cash', lp_entity_id: null },
  { id: 'cap-a', fund_id: 'f', vehicle_id: 'v', portfolio_group: 'Fund I', code: '3100-aaaaaaaa', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-a' },
  { id: 'cap-b', fund_id: 'f', vehicle_id: 'v', portfolio_group: 'Fund I', code: '3100-bbbbbbbb', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-b' },
]
const posting = (id: string, entry: string, account: string, amount: number, lp: string | null = null) =>
  ({ id, journal_entry_id: entry, book: 'actual', fund_id: 'f', vehicle_id: 'v', account_id: account, amount, currency: 'USD', lp_entity_id: lp })

beforeEach(() => {
  s.m = memoryAdmin({
    chart_of_accounts: chart,
    journal_entries: [
      { id: 'e-split', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2025-11-06', source_ref: null, reversed_by: null },
      { id: 'e-posted', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2025-11-06', source_ref: null, reversed_by: null },
    ],
    journal_postings: [
      posting('p1', 'e-split', 'cash', -1250),
      posting('p2', 'e-split', 'cap-a', 500, 'lp-a'),
      posting('p3', 'e-split', 'cap-b', 750, 'lp-b'),
      posting('p4', 'e-posted', 'cash', -10),
      posting('p5', 'e-posted', 'cap-a', 10, 'lp-a'),
    ],
    bank_transactions: [
      { id: 'b-split', fund_id: 'f', vehicle_id: 'v', journal_entry_id: 'e-split', status: 'drafted', amount: -1250, raw: {} },
      { id: 'b-posted', fund_id: 'f', vehicle_id: 'v', journal_entry_id: 'e-posted', status: 'reconciled', amount: -10, raw: {} },
    ],
    investment_transactions: [],
    journal_entry_allocations: [],
  })
})
const postingsOf = (entry: string) => s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === entry)

describe('set_bank_transaction_account on a split draft', () => {
  it('refuses without replaceSplit and leaves the split', async () => {
    const r = await setBankTransactionAccount(s.m.admin, 'f', 'Fund I', 'b-split', '3100-aaaaaaaa', 'ai')
    expect(r).toMatchObject({ error: expect.stringMatching(/replaceSplit/) })
    expect(postingsOf('e-split')).toHaveLength(3)
  })

  it('replaces the split with one posting to the partner, keeping cash and the balance', async () => {
    const r = await setBankTransactionAccount(s.m.admin, 'f', 'Fund I', 'b-split', '3100-aaaaaaaa', 'ai', { replaceSplit: true })
    expect(r).toMatchObject({ ok: true, replacedSplit: 2 })
    const lines = postingsOf('e-split')
    expect(lines).toHaveLength(2)
    expect(lines.find((p: any) => p.account_id === 'cash').amount).toBe(-1250)
    expect(lines.find((p: any) => p.account_id === 'cap-a')).toMatchObject({ amount: 1250, lp_entity_id: 'lp-a' })
    expect(lines.reduce((sum: number, p: any) => sum + Number(p.amount), 0)).toBe(0)
  })
})

describe('ignore_bank_transaction', () => {
  it('voids the draft entry and sets the row aside', async () => {
    const r = await ignoreBankTransaction(s.m.admin, 'f', 'Fund I', 'u', 'b-split')
    expect(r).toMatchObject({ ok: true, status: 'ignored' })
    expect(s.m.tables.journal_entries.find((e: any) => e.id === 'e-split').status).toBe('void')
    expect(s.m.tables.bank_transactions.find((b: any) => b.id === 'b-split').status).toBe('ignored')
  })

  it('refuses a posted row and changes nothing', async () => {
    const r = await ignoreBankTransaction(s.m.admin, 'f', 'Fund I', 'u', 'b-posted')
    expect(r).toMatchObject({ error: expect.stringMatching(/posted/) })
    expect(s.m.tables.journal_entries.find((e: any) => e.id === 'e-posted').status).toBe('posted')
    expect(s.m.tables.bank_transactions.find((b: any) => b.id === 'b-posted').status).toBe('reconciled')
  })

  it('refuses a row already ignored', async () => {
    await ignoreBankTransaction(s.m.admin, 'f', 'Fund I', 'u', 'b-split')
    expect(await ignoreBankTransaction(s.m.admin, 'f', 'Fund I', 'u', 'b-split')).toMatchObject({ error: expect.stringMatching(/already ignored/) })
  })
})
