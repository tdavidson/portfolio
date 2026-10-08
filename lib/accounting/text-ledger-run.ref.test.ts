import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

const { persistEntry } = vi.hoisted(() => ({ persistEntry: vi.fn() }))
vi.mock('./persist', () => ({ persistEntry }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('./import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))

import { postLedgerText, exportLedgerText } from './text-ledger-run'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lp_entity_id: null },
  { id: 'exp', fund_id: 'f', vehicle_id: 'v1', code: '5000', name: 'Expenses', type: 'expense', subtype: null, lp_entity_id: null },
]
const live = (over = {}) => ({ id: 'e1', fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted', source_ref: 'txn:t1', ...over })
const text = (ref?: string) => [
  '2026-03-01 * "Fees"',
  ...(ref ? [`  ref: "${ref}"`] : []),
  '  Expenses:5000  10.00 USD',
  '  Assets:Cash:1000  -10.00 USD',
  '',
].join('\n')

let admin: any
const setup = (entries: any[]) => { admin = memoryAdmin({ chart_of_accounts: chart, journal_entries: entries }).admin }
beforeEach(() => { persistEntry.mockReset().mockResolvedValue({ entryId: 'new' }) })

describe('postLedgerText refuses entries already in the books', () => {
  it('refuses a ref that a live entry already carries', async () => {
    setup([live()])
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text('txn:t1'))
    expect(r.posted).toBe(0)
    expect(r.errors.join()).toMatch(/already in the books/)
    expect(persistEntry).not.toHaveBeenCalled()
  })
  it('proceeds when the ref is only on a void entry', async () => {
    setup([live({ status: 'void' })])
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text('txn:t1'))
    expect(r.errors).toEqual([])
    expect(r.posted).toBe(1)
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })
  it('does not touch an entry with no ref', async () => {
    setup([live()])
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text())
    expect(r.posted).toBe(1)
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })
})

describe('postLedgerText fails closed', () => {
  it('refuses the whole import when the check cannot read the books', async () => {
    setup([live()])
    const real = admin
    admin = { ...real, from: (t: string) => {
      if (t !== 'journal_entries') return real.from(t)
      const q: any = new Proxy({}, { get: (_o, k) => k === 'then' ? (res: any) => res({ data: null, error: { message: 'timeout' } }) : () => q })
      return q
    } }
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text('txn:t1'))
    expect(r).toMatchObject({ posted: 0, errors: ['Could not check for entries already in the books: timeout'] })
    expect(persistEntry).not.toHaveBeenCalled()
  })
  it('checks refs in chunks of 200', async () => {
    const refs = Array.from({ length: 450 }, (_, i) => `qb:${i}`)
    setup([live({ source_ref: 'qb:449' })])
    const real = admin
    const sizes: number[] = []
    admin = { ...real, from: (t: string) => {
      const q = real.from(t)
      if (t !== 'journal_entries') return q
      const inner = q.in
      q.in = (k: string, vs: unknown[]) => { sizes.push(vs.length); return inner(k, vs) }
      return q
    } }
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', refs.map(ref => text(ref)).join('\n'))
    expect(sizes).toEqual([200, 200, 50])
    expect(r.errors).toEqual([expect.stringMatching(/already in the books \(qb:449\)/)])
  })
})

describe('an adopted manual entry round-trips without being adopted twice', () => {
  const E = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
  const seed = (status = 'posted') => {
    const m = memoryAdmin({
      chart_of_accounts: chart,
      journal_entries: [{ id: E, fund_id: 'f', vehicle_id: 'v1', book: 'actual', status, entry_date: '2026-03-01', memo: 'Hand entry', source_type: 'manual', source_ref: null }],
      journal_postings: [
        { journal_entry_id: E, book: 'actual', fund_id: 'f', account_id: 'exp', amount: 10, currency: 'USD' },
        { journal_entry_id: E, book: 'actual', fund_id: 'f', account_id: 'cash', amount: -10, currency: 'USD' },
      ],
      investment_transactions: [{ id: 't9', fund_id: 'f', adopted_entry_id: E }],
    })
    admin = m.admin
  }
  it('exports adopted:<entryId> as its ref', async () => {
    seed()
    expect(await exportLedgerText(admin, 'f', 'Fund I')).toContain(`ref: "adopted:${E}"`)
  })
  it('refuses the re-import while that entry is live', async () => {
    seed()
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text(`adopted:${E}`))
    expect(r.posted).toBe(0)
    expect(r.errors.join()).toMatch(/already in the books/)
  })
  it('lets it through once that entry is void', async () => {
    seed('void')
    const r = await postLedgerText(admin, 'f', 'Fund I', 'u', text(`adopted:${E}`))
    expect(r.posted).toBe(1)
  })
})
