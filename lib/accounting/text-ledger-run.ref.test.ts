import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

const { persistEntry } = vi.hoisted(() => ({ persistEntry: vi.fn() }))
vi.mock('./persist', () => ({ persistEntry }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('./import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))

import { postLedgerText } from './text-ledger-run'

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
