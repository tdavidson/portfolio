// What a month's close writes: the ledger snapshot kept once (in the bundle), and the month's
// allocation entries posted together, all or nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildFixture, FUND, GROUP } from './helpers/close-fixture'
import { closePeriodWithAllocation } from '@/lib/accounting/close'
import { persistEntriesTogether } from '@/lib/accounting/persist'
import type { JournalEntry } from '@/lib/accounting/types'

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

const closeJanuary = (m: ReturnType<typeof buildFixture>) =>
  closePeriodWithAllocation(m.admin, FUND, GROUP, 'user-1', '2020-01-01', '2020-01-31')

describe('the ledger snapshot', () => {
  it('is kept once, in the bundle, not on the period or the review', async () => {
    const m = buildFixture({ months: 3, noisePerMonth: 5 })
    const r = await closeJanuary(m)
    expect('error' in r).toBe(false)
    const [period] = m.tables.fiscal_periods.filter(p => p.status === 'closed')
    const [bundle] = m.tables.close_bundles
    expect(bundle.ledger_text).toContain('2020-01')
    expect(period.close_bundle_sha256).toBe(bundle.bundle_sha256)
    expect(period.snapshot_text ?? null).toBeNull()
    expect(m.tables.close_reviews.every(r => (r.snapshot_text ?? null) === null)).toBe(true)
  })

  it('stays on the period when the bundle cannot be kept', async () => {
    const m = buildFixture({ months: 3, noisePerMonth: 5 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    m.failNext('close_bundles', 'insert', 'boom')
    const r = await closeJanuary(m)
    expect('error' in r).toBe(false)
    expect(m.tables.close_bundles ?? []).toHaveLength(0)
    const [period] = m.tables.fiscal_periods.filter(p => p.status === 'closed')
    expect(period.snapshot_text).toContain('2020-01')
  })
})

describe('posting entries together', () => {
  const entry = (memo: string, amount: number, date = '2020-01-31'): JournalEntry => ({
    fundId: FUND, entryDate: date, memo, sourceType: 'manual', sourceRef: 'test:together',
    postings: [
      { accountId: 'acct-3200', amount, currency: 'USD', lpEntityId: null },
      { accountId: 'acct-1000', amount: -amount, currency: 'USD', lpEntityId: null },
    ],
  })
  const together = (m: ReturnType<typeof buildFixture>) => m.tables.journal_entries.filter(e => e.source_ref === 'test:together')

  it('posts every entry, lines in order, each under its own header', async () => {
    const m = buildFixture({ months: 1 })
    const r = await persistEntriesTogether(m.admin, FUND, GROUP, 'user-1', [entry('first', 100), entry('second', 250)])
    if ('error' in r) throw new Error(r.error)
    expect(together(m).map(e => [e.memo, e.status])).toEqual([['first', 'posted'], ['second', 'posted']])
    const lines = m.tables.journal_postings.filter(p => r.entryIds.includes(p.journal_entry_id))
    expect(lines.map(p => [r.entryIds.indexOf(p.journal_entry_id), p.amount])).toEqual([[0, 100], [0, -100], [1, 250], [1, -250]])
  })

  it('writes nothing when any one entry may not be posted', async () => {
    const m = buildFixture({ months: 1 })
    const unbalanced = { ...entry('bad', 100), postings: [entry('bad', 100).postings[0]] }
    const r = await persistEntriesTogether(m.admin, FUND, GROUP, 'user-1', [entry('good', 100), unbalanced])
    expect(r).toMatchObject({ entryIndex: 1 })
    expect(together(m)).toHaveLength(0)
  })

  it('removes the drafts when the lines cannot be written', async () => {
    const m = buildFixture({ months: 1 })
    m.failNext('journal_postings', 'insert', 'boom')
    const r = await persistEntriesTogether(m.admin, FUND, GROUP, 'user-1', [entry('first', 100), entry('second', 250)])
    expect(r).toMatchObject({ error: 'boom' })
    expect(together(m)).toHaveLength(0)
  })
})
