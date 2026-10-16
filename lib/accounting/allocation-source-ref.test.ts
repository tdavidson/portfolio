import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { AccessContext } from '@/lib/access/effective'

/**
 * Two chat sessions each posted the same carry reallocation through the agent `allocation` tool,
 * because it wrote no source_ref and nothing could tell the second from the first. The entry now
 * carries a ref derived from what it does, a live copy is refused by name, and the unique index
 * (20261013141500) is the backstop when two posts race — persistEntry turns that into the same
 * named refusal.
 */

vi.mock('./currency', () => ({ fundCurrency: async () => 'USD' }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./continuous-allocation', () => ({ allocatePostedEntry: async () => ({ allocationEntryIds: [] }), rollbackGeneratedAllocations: async () => {} }))
const built = vi.hoisted(() => ({ entry: null as any }))
vi.mock('./allocation-actions', async importOriginal => ({
  ...(await importOriginal<typeof import('./allocation-actions')>()),
  buildAllocationEntry: async () => ({ entry: built.entry }),
}))

import { allocationSourceRef, AGENT_ALLOCATION_REF_PREFIX } from './allocation-actions'
import { persistEntry } from './persist'
import { getTool } from './agent-tools'

const LP_A = '00000000-0000-0000-0000-00000000000a'
const LP_B = '00000000-0000-0000-0000-00000000000b'
const chart = [
  { id: 'gp', fund_id: 'f', vehicle_id: 'v', code: '3000', type: 'equity', subtype: 'gp_capital', company_id: null, lp_entity_id: null },
  { id: 'capA', fund_id: 'f', vehicle_id: 'v', code: 'lp-a', type: 'equity', subtype: 'lp_capital', company_id: null, lp_entity_id: LP_A },
  { id: 'capB', fund_id: 'f', vehicle_id: 'v', code: 'lp-b', type: 'equity', subtype: 'lp_capital', company_id: null, lp_entity_id: LP_B },
]
const carry = (over: Record<string, unknown> = {}) => ({
  fundId: 'f', entryDate: '2026-09-30', memo: 'Carry reallocation',
  postings: [
    { accountId: 'capA', amount: 61250.37, currency: 'USD', lpEntityId: LP_A },
    { accountId: 'capB', amount: 61250.37, currency: 'USD', lpEntityId: LP_B },
    { accountId: 'gp', amount: -122500.74, currency: 'USD', lpEntityId: null },
  ],
  ...over,
})
// The index, as memoryAdmin can express it.
const agentAllocationOnce = {
  table: 'journal_entries',
  key: (r: any) => (String(r.source_ref ?? '').startsWith(AGENT_ALLOCATION_REF_PREFIX) && r.status !== 'void' ? `${r.fund_id}|${r.vehicle_id}|${r.book}|${r.source_ref}` : null),
}
const seed = () => memoryAdmin({ chart_of_accounts: chart, lp_entities: [{ id: LP_A, fund_id: 'f' }, { id: LP_B, fund_id: 'f' }] }, { unique: [agentAllocationOnce] })
const access = { fundId: 'f', userId: 'u', role: 'admin', vehicles: { all: true, ids: [] }, features: {}, grants: {}, defaults: {} } as unknown as AccessContext

describe('allocationSourceRef', () => {
  it('is the same for the same entry, whatever the memo or line order', () => {
    const a = allocationSourceRef('carry', carry())
    const reordered = carry({ memo: 'Q3 carry realloc (second chat)' })
    reordered.postings.reverse()
    expect(allocationSourceRef('carry', reordered)).toBe(a)
    expect(a).toMatch(/^agent-allocation:carry:[0-9a-f]{32}$/)
  })
  it('differs when the action, date, amount or partner differs', () => {
    const a = allocationSourceRef('carry', carry())
    expect(allocationSourceRef('distribution', carry())).not.toBe(a)
    expect(allocationSourceRef('carry', carry({ entryDate: '2026-10-01' }))).not.toBe(a)
    const more = carry()
    more.postings = [{ ...more.postings[0], amount: 61250.38 }, more.postings[1], { ...more.postings[2], amount: -122500.75 }]
    expect(allocationSourceRef('carry', more)).not.toBe(a)
    const swapped = carry()
    swapped.postings = [{ ...swapped.postings[0], lpEntityId: LP_B, accountId: 'capB', amount: 100000 }, { ...swapped.postings[1], lpEntityId: LP_A, accountId: 'capA', amount: 22500.74 }, swapped.postings[2]]
    expect(allocationSourceRef('carry', swapped)).not.toBe(a)
  })
  it('does not use the `allocation:` prefix the ledger reserves for generated allocations', () => {
    expect(allocationSourceRef('carry', carry()).startsWith('allocation:')).toBe(false)
  })
})

describe('the allocation tool', () => {
  const handler = getTool('allocation')!.handler
  const ctx = (admin: any) => ({ admin, fundId: 'f', portfolioGroup: 'Fund I', userId: 'u', access })
  beforeEach(() => { built.entry = carry() })

  it('posts with the derived ref', async () => {
    const m = seed()
    const out = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30' })
    expect(out.entryId).toEqual(expect.any(String))
    expect(m.tables.journal_entries).toEqual([expect.objectContaining({ id: out.entryId, status: 'posted', source_ref: allocationSourceRef('carry', carry()) })])
  })

  it('refuses the same posting a second time, naming the entry already in the books', async () => {
    const m = seed()
    const first = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30', memo: 'one' })
    built.entry = carry({ memo: 'two' })
    await expect(handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30', memo: 'two' }))
      .rejects.toThrow(new RegExp(`already in the books as entry ${first.entryId} \\(posted, dated 2026-09-30\\)`))
    expect(m.tables.journal_entries).toHaveLength(1)
  })

  it('posts again once the first copy is void', async () => {
    const m = seed()
    const first = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30' })
    m.tables.journal_entries.find(e => e.id === first.entryId)!.status = 'void'
    const second = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30' })
    expect(second.entryId).not.toBe(first.entryId)
  })

  it('says in a preview that the entry is already booked', async () => {
    const m = seed()
    const first = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30' })
    const preview = await handler(ctx(m.admin), { action: 'carry', entryDate: '2026-09-30', post: false })
    expect(preview).toMatchObject({ preview: { sourceRef: expect.stringMatching(/^agent-allocation:/) }, alreadyBooked: { id: first.entryId } })
    expect(m.tables.journal_entries).toHaveLength(1)
  })
})

describe('persistEntry under a source_ref unique index', () => {
  it('names the entry that won when a concurrent copy is refused', async () => {
    const m = seed()
    const ref = allocationSourceRef('carry', carry())
    const first = await persistEntry(m.admin, 'f', 'Fund I', 'u', carry({ sourceRef: ref }), 'posted')
    const second = await persistEntry(m.admin, 'f', 'Fund I', 'u', carry({ sourceRef: ref }), 'posted')
    expect(second).toEqual({
      error: expect.stringContaining(`already in the books as entry ${(first as any).entryId}`),
      duplicateOf: (first as any).entryId,
    })
    expect(m.tables.journal_entries).toHaveLength(1)
  })
})
