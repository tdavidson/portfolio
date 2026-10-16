import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

/**
 * The cutover bootstrap posted "Opening capital bootstrapped from LP data" with no source_ref and
 * no check, so running it twice booked every partner's opening capital twice. It now refuses when the partners already have capital on the books, and carries the
 * `partner-opening` ref so the per-date unique index refuses a concurrent copy.
 */

vi.mock('./currency', () => ({ fundCurrency: async () => 'USD' }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./continuous-allocation', () => ({ allocatePostedEntry: async () => ({ allocationEntryIds: [] }), rollbackGeneratedAllocations: async () => {} }))
const LP_A = '00000000-0000-0000-0000-00000000000a'
const LP_B = '00000000-0000-0000-0000-00000000000b'
vi.mock('./load', () => ({
  loadOwnership: async () => [
    { lpEntityId: LP_A, paidIn: 1_000_000, distributions: 0, commitment: 2_000_000 },
    { lpEntityId: LP_B, paidIn: 830_000, distributions: 0, commitment: 1_000_000 },
  ],
}))

import { bootstrapOpeningBalances, PARTNER_OPENING_REF } from './bootstrap'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null, lp_entity_id: null },
  { id: 'capA', fund_id: 'f', vehicle_id: 'v', code: 'lp-a', type: 'equity', subtype: 'lp_capital', company_id: null, lp_entity_id: LP_A },
  { id: 'capB', fund_id: 'f', vehicle_id: 'v', code: 'lp-b', type: 'equity', subtype: 'lp_capital', company_id: null, lp_entity_id: LP_B },
]
// journal_entries_partner_opening_once_per_date (20261006200000), as memoryAdmin can express it.
const openingOncePerDate = {
  table: 'journal_entries',
  key: (r: any) => (r.source_ref === 'partner-opening' && r.status !== 'void' ? `${r.fund_id}|${r.vehicle_id}|${r.book}|${r.entry_date}` : null),
}
// journal_postings.book defaults to 'actual' in the database (20260827000000); persistEntry leaves it to that.
const bookDefault = (table: string, op: string, payload: any) => {
  if (table === 'journal_postings' && op === 'insert') for (const r of [].concat(payload)) (r as any).book ??= 'actual'
}
const seed = (extra: Record<string, any[]> = {}) => memoryAdmin({
  chart_of_accounts: chart, lp_entities: [{ id: LP_A, fund_id: 'f' }, { id: LP_B, fund_id: 'f' }], ...extra,
}, { unique: [openingOncePerDate], before: bookDefault })

describe('bootstrapOpeningBalances', () => {
  it('posts the opening once, under the partner-opening ref', async () => {
    const m = seed()
    const r = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-01-01')
    expect(r).toMatchObject({ ok: true, lpCount: 2, total: 1_830_000 })
    expect(m.tables.journal_entries).toEqual([expect.objectContaining({ source_ref: PARTNER_OPENING_REF, status: 'posted', entry_date: '2026-01-01' })])
  })

  it('refuses a second run, naming the entry already booked, and writes nothing', async () => {
    const m = seed()
    const first = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-01-01')
    const again = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-03-31')
    expect(again).toEqual({ error: expect.stringContaining(`entry ${(first as any).entryId}`) })
    expect((again as any).error).toMatch(/twice — nothing was posted/)
    expect(m.tables.journal_entries).toHaveLength(1)
  })

  it('also refuses over a legacy bootstrap that carried no ref', async () => {
    const m = seed({
      journal_entries: [{ id: 'legacy', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', source_ref: null, entry_date: '2025-12-31' }],
      journal_postings: [{ id: 'p1', fund_id: 'f', vehicle_id: 'v', book: 'actual', journal_entry_id: 'legacy', account_id: 'capA', amount: -1_000_000, lp_entity_id: LP_A }],
    })
    const r = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-01-01')
    expect(r).toEqual({ error: expect.stringContaining('entry legacy') })
    expect(m.tables.journal_entries).toHaveLength(1)
  })

  it('refuses when the check cannot read the books', async () => {
    const m = seed()
    m.failNext('journal_postings', 'select', 'timeout')
    const r = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-01-01')
    expect(r).toEqual({ error: 'Could not check for opening capital already in the books: timeout' })
    expect(m.tables.journal_entries ?? []).toEqual([])
  })

  it('loses a race on the same date to the unique index, by name', async () => {
    // A concurrent request books the same opening between this one's check and its insert.
    let raced = false
    const m = memoryAdmin({ chart_of_accounts: chart, lp_entities: [{ id: LP_A, fund_id: 'f' }, { id: LP_B, fund_id: 'f' }] }, {
      unique: [openingOncePerDate],
      before: (table, op, _payload, tables) => {
        if (raced || table !== 'journal_entries' || op !== 'insert') return
        raced = true
        tables.journal_entries ??= []
        tables.journal_entries.push({ id: 'winner', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', source_ref: 'partner-opening', entry_date: '2026-01-01' })
      },
    })
    const r = await bootstrapOpeningBalances(m.admin, 'f', 'Fund I', 'u', '2026-01-01')
    expect(r).toEqual({ error: expect.stringContaining('already in the books as entry winner') })
    expect(m.tables.journal_entries.map(e => e.id)).toEqual(['winner'])
  })
})
