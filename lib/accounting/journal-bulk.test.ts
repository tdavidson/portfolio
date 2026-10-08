import { describe, it, expect, vi, beforeEach } from 'vitest'

// The closed-period lookup is its own tested unit and needs a real DB; pin it per-test so
// these cases exercise the batching and the per-entry guards, nothing else.
const closed: { period_start: string; period_end: string }[] = []
vi.mock('@/lib/accounting/periods', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  closedPeriodRanges: async () => closed,
}))

const postedIds: string[] = []
vi.mock('./continuous-allocation', () => ({
  postExistingEntryWithAllocation: vi.fn(async (_a: any, _f: string, _g: string, _u: string | null, id: string) => { postedIds.push(id); return { allocationEntryIds: [] } }),
}))

import { readBulkScope, runBulkDraftAction, BULK_BATCH } from './journal-bulk'

interface DraftRow { id: string; entry_date: string; journal_postings: { amount: number }[] }

/** Captures what the run wrote, and replays a fixed set of candidate drafts. */
function fakeAdmin(rows: DraftRow[]) {
  const updates: { table: string; patch: Record<string, unknown>; ids: string[] }[] = []
  const from = (table: string) => {
    let mode: 'select' | 'update' = 'select'
    let patch: Record<string, unknown> = {}
    let ids: string[] = []
    const b: any = {
      select: () => b,
      update: (p: Record<string, unknown>) => { mode = 'update'; patch = p; return b },
      in: (_col: string, vals: string[]) => { ids = vals; return b },
      eq: () => b, gt: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b,
      then: (resolve: (v: any) => void) => {
        if (mode === 'update') { updates.push({ table, patch, ids }); return resolve({ error: null }) }
        // Only the candidate-draft read returns rows; the ownership reads find no owners.
        return resolve({ data: table === 'journal_entries' ? rows : [], error: null })
      },
    }
    return b
  }
  return { admin: { from } as any, updates }
}

const balanced = (id: string, date = '2026-06-01'): DraftRow =>
  ({ id, entry_date: date, journal_postings: [{ amount: 100 }, { amount: -100 }] })
const lopsided = (id: string, date = '2026-06-01'): DraftRow =>
  ({ id, entry_date: date, journal_postings: [{ amount: 100 }, { amount: -40 }] })

const run = (admin: any, action: 'post' | 'void', scope = readBulkScope({})) =>
  runBulkDraftAction(admin, { fundId: 'f1', vehicleId: 'v1', group: 'Main', action, scope, userId: null })

beforeEach(() => { closed.length = 0; postedIds.length = 0 })

describe('readBulkScope', () => {
  it('reads ids, window and cursor', () => {
    expect(readBulkScope({ ids: ['a'], start: '2026-01-01', end: '2026-12-31', afterId: 'x' }))
      .toEqual({ ids: ['a'], start: '2026-01-01', end: '2026-12-31', afterId: 'x' })
  })

  it('treats an empty id list as "no id filter", not "act on nothing"', () => {
    // An empty array would otherwise become `.in('id', [])` and silently match zero rows
    // when the caller meant to scope by date.
    expect(readBulkScope({ ids: [] }).ids).toBeNull()
  })

  it('ignores a malformed body', () => {
    expect(readBulkScope(undefined)).toEqual({ ids: null, start: null, end: null, afterId: null })
    expect(readBulkScope({ afterId: 42 }).afterId).toBeNull()
  })
})

describe('runBulkDraftAction', () => {
  it('skips a draft with no lines, so an entry mid-write is never posted empty', async () => {
    const { admin } = fakeAdmin([balanced('a'), { id: 'e', entry_date: '2026-06-01', journal_postings: [] }])
    const res = await run(admin, 'post')
    if (!res.ok) throw new Error('expected success')
    expect(res.outcome.skipped).toEqual([{ id: 'e', reason: 'Has no lines — add them before posting.' }])
    expect(postedIds).toEqual(['a'])
  })

  it('posts balanced drafts and reports the ones that are out of balance', async () => {
    const { admin, updates } = fakeAdmin([balanced('a'), lopsided('b'), balanced('c')])
    const res = await run(admin, 'post')
    if (!res.ok) throw new Error('expected success')

    expect(res.outcome.changed).toBe(2)
    expect(res.outcome.skipped).toEqual([
      { id: 'b', reason: 'Out of balance by 60.00 — fix it before posting.' },
    ])
    // Posting goes through the choke point (adopts, allocates), never a raw status flip.
    expect(postedIds).toEqual(['a', 'c'])
    // The linked bank transactions follow the entry.
    expect(updates[0]).toMatchObject({ table: 'bank_transactions', patch: { status: 'reconciled' } })
  })

  it('voids an out-of-balance draft — a broken draft is exactly what you want to discard', async () => {
    const { admin, updates } = fakeAdmin([balanced('a'), lopsided('b')])
    const res = await run(admin, 'void')
    if (!res.ok) throw new Error('expected success')

    expect(res.outcome.changed).toBe(2)
    expect(res.outcome.skipped).toEqual([])
    expect(updates[0].patch).toEqual({ status: 'void', posted_at: null })
    expect(updates[1]).toMatchObject({ table: 'bank_transactions', patch: { status: 'ignored' } })
  })

  it('refuses a closed period for both actions', async () => {
    closed.push({ period_start: '2026-01-01', period_end: '2026-03-31' })
    for (const action of ['post', 'void'] as const) {
      const { admin, updates } = fakeAdmin([balanced('a', '2026-02-15'), balanced('b', '2026-06-01')])
      const res = await run(admin, action)
      if (!res.ok) throw new Error('expected success')
      expect(res.outcome.changed).toBe(1)
      expect(res.outcome.skipped[0]).toEqual({
        id: 'a',
        reason: 'In a closed period (2026-02-15) — reopen it first.',
      })
      expect(updates[0].ids).toEqual(['b'])
    }
  })

  it('writes nothing when every candidate is refused', async () => {
    const { admin, updates } = fakeAdmin([lopsided('a')])
    const res = await run(admin, 'post')
    if (!res.ok) throw new Error('expected success')
    expect(res.outcome.changed).toBe(0)
    expect(updates).toEqual([])
  })

  it('signals hasMore and a cursor when the page overflows the batch', async () => {
    const rows = Array.from({ length: BULK_BATCH + 1 }, (_, i) => balanced(`id-${i}`))
    const { admin } = fakeAdmin(rows)
    const res = await run(admin, 'post')
    if (!res.ok) throw new Error('expected success')

    // The extra row is the lookahead: it proves there's more, but isn't acted on.
    expect(res.outcome.changed).toBe(BULK_BATCH)
    expect(res.outcome.hasMore).toBe(true)
    expect(res.outcome.cursor).toBe(`id-${BULK_BATCH - 1}`)
  })

  it('reports no cursor and no more pages on an empty batch', async () => {
    const { admin } = fakeAdmin([])
    const res = await run(admin, 'void')
    if (!res.ok) throw new Error('expected success')
    expect(res.outcome).toMatchObject({ changed: 0, hasMore: false, cursor: null })
  })

  it('surfaces a query error instead of reporting a silent success', async () => {
    const admin = { from: () => ({
      select: () => admin.from(), eq: () => admin.from(), order: () => admin.from(),
      limit: () => admin.from(), gt: () => admin.from(), gte: () => admin.from(), lte: () => admin.from(),
      then: (resolve: (v: any) => void) => resolve({ data: null, error: { message: 'boom' } }),
    }) } as any
    const res = await run(admin, 'post')
    expect(res.ok).toBe(false)
  })
})

describe('bulk actions and investment transactions', () => {
  const T = '00000000-0000-4000-8000-0000000000c1'
  const seed = async () => {
    const { memoryAdmin } = await import('@/tests/helpers/memory-admin')
    return memoryAdmin({
      journal_entries: [
        { id: 'owned', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-06-01', source_ref: `txn:${T}` },
        { id: 'plain', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-06-01', source_ref: null },
      ],
      journal_postings: [],
      investment_transactions: [{ id: T, fund_id: 'f1', company_id: 'c', transaction_type: 'investment' }],
      companies: [{ id: 'c', fund_id: 'f1', name: 'Acme' }],
      bank_transactions: [],
    })
  }
  it('bulk void skips a draft an investment transaction owns, and keeps the transaction', async () => {
    const m = await seed()
    const r = await run(m.admin, 'void')
    expect(r.ok && r.outcome.skipped).toEqual([{ id: 'owned', reason: expect.stringMatching(/void it on its own/) }])
    expect(m.tables.journal_entries.map((e: any) => e.status)).toEqual(['draft', 'void'])
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
  it('bulk void refuses a draft whose ownership cannot be read', async () => {
    const m = await seed()
    m.failNext('investment_transactions', 'select', 'read failed')
    const r = await run(m.admin, 'void')
    expect(r.ok && r.outcome.skipped.map(x => x.id)).toContain('owned')
    expect(m.tables.journal_entries[0].status).toBe('draft')
  })
  it('bulk post reports what posting a reversal draft released, and any warning', async () => {
    const { postExistingEntryWithAllocation } = await import('./continuous-allocation')
    vi.mocked(postExistingEntryWithAllocation).mockResolvedValueOnce({
      allocationEntryIds: [], removedTransactions: [{ id: T, companyId: 'c', company: 'Acme', type: 'investment', date: null }],
      unlinkedRegisterRows: ['the call of 2026-03-01'], warning: 'The reversal was posted, but …',
    })
    const rows = [balanced('r1')]
    const { admin } = fakeAdmin(rows)
    const r = await run(admin, 'post')
    expect(r.ok && r.outcome).toMatchObject({
      changed: 1, skipped: [],
      removedTransactions: [{ id: T }], unlinkedRegisterRows: ['the call of 2026-03-01'],
      warnings: [{ id: 'r1', warning: 'The reversal was posted, but …' }],
    })
  })
})
