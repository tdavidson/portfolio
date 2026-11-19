// The period close reads only what changed since the last closed period (lib/accounting/close-cache.ts).
// These tests hold it to the promise that matters: a close with the cache writes exactly what a close
// without it writes, row for row, while reading a fraction of the ledger.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildFixture, instrument, closeOutput, FUND, GROUP, VEHICLE, type FixtureOptions } from './helpers/close-fixture'
import { memoryAdmin } from './helpers/memory-admin'
import { closeThrough, previewCloseThrough } from '@/lib/accounting/close'
import { closeCacheStats, frozenWindow } from '@/lib/accounting/close-cache'
import { withCloseCache } from '@/lib/accounting/close-cache-scope'
import { loadPostedLedger } from '@/lib/accounting/load'
import { exportLedgerText } from '@/lib/accounting/text-ledger-run'
import { adoptedEntryIds } from '@/lib/accounting/adoption'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

beforeEach(() => {
  // The close stamps closed_at and the bundle's createdAt; pin the clock so two runs can be compared.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const CASES: [string, FixtureOptions, string][] = [
  ['a year of monthly activity', { months: 14, noisePerMonth: 5, allocatedEvery: 4 }, '2020-12-31'],
  ['carried interest accrued every month', { months: 10, noisePerMonth: 3, allocatedEvery: 6, carry: true }, '2020-10-31'],
  ['entries dated after the close', { months: 30, noisePerMonth: 20, allocatedEvery: 5, carry: true }, '2020-11-30'],
  ['a ledger past the 1000-row page', { months: 8, noisePerMonth: 160, allocatedEvery: 7 }, '2020-08-31'],
]

async function closeTwice(opts: FixtureOptions, through: string, cache: boolean) {
  const m = buildFixture(opts)
  const io = instrument(m.admin)
  // Two requests, as a long re-close is: the second starts from periods the first closed.
  const first = await closeThrough(io.admin, FUND, GROUP, 'user-1', '2020-03-31', { budgetMs: 1e9, cache })
  const second = await closeThrough(io.admin, FUND, GROUP, 'user-1', through, { budgetMs: 1e9, cache })
  return { first, second, output: closeOutput(m.tables), postingRowsRead: io.rowsOf('journal_postings') }
}

describe('a close with the cache writes exactly what a close without it writes', () => {
  for (const [name, opts, through] of CASES) {
    it(name, async () => {
      const uncached = await closeTwice(opts, through, false)
      const cached = await closeTwice(opts, through, true)
      expect('closed' in uncached.second && uncached.second.closed.length).toBeGreaterThan(0)
      expect(cached.first).toEqual(uncached.first)
      expect(cached.second).toEqual(uncached.second)
      // Every entry, posting, rounding row, period (with its ledger snapshot), review and bundle.
      expect(cached.output).toEqual(uncached.output)
      expect(cached.postingRowsRead).toBeLessThan(uncached.postingRowsRead / 2)
    })
  }

  it('reads a small fraction of the ledger on a big book', async () => {
    const opts: FixtureOptions = { months: 24, noisePerMonth: 150, allocatedEvery: 5, carry: true }
    const uncached = await closeTwice(opts, '2020-09-30', false)
    const cached = await closeTwice(opts, '2020-09-30', true)
    expect(cached.output).toEqual(uncached.output)
    expect(cached.postingRowsRead).toBeLessThan(uncached.postingRowsRead / 5)
  })
})

describe('which entries are already allocated', () => {
  it('is read for the month being closed, not the whole vehicle', async () => {
    const m = buildFixture({ months: 24, noisePerMonth: 40, allocatedEvery: 2 })
    const total = m.tables.journal_entry_allocations.length
    await closeThrough(m.admin, FUND, GROUP, 'user-1', '2021-10-31', { budgetMs: 1e9 })
    const io = instrument(m.admin)
    const r = await closeThrough(io.admin, FUND, GROUP, 'user-1', '2021-11-30', { budgetMs: 1e9 })
    expect('closed' in r && r.closed).toHaveLength(1)
    expect(total).toBeGreaterThan(450)
    expect(io.rowsOf('journal_entry_allocations')).toBeLessThan(total / 10)
  })
})

describe('the close preview with the cache', () => {
  it('previews every month exactly as without it', async () => {
    const a = buildFixture({ months: 14, noisePerMonth: 10, allocatedEvery: 4, carry: true })
    const b = buildFixture({ months: 14, noisePerMonth: 10, allocatedEvery: 4, carry: true })
    await closeThrough(a.admin, FUND, GROUP, 'user-1', '2020-02-29', { budgetMs: 1e9, cache: false })
    await closeThrough(b.admin, FUND, GROUP, 'user-1', '2020-02-29', { budgetMs: 1e9, cache: false })
    const uncached = await previewCloseThrough(a.admin, FUND, GROUP, '2020-12-31', { cache: false })
    const cached = await previewCloseThrough(b.admin, FUND, GROUP, '2020-12-31')
    expect('months' in uncached && uncached.months).toHaveLength(10)
    expect(cached).toEqual(uncached)
  })
})

describe('what the cache may keep', () => {
  const closedJanuary = () => {
    const m = buildFixture({ months: 4, noisePerMonth: 2 })
    m.tables.fiscal_periods = [{ id: 'fp-jan', fund_id: FUND, vehicle_id: VEHICLE, period_start: '2020-01-01', period_end: '2020-01-31', status: 'closed', closed_at: '2020-02-05T00:00:00Z' }]
    return m
  }
  const postIn = (m: ReturnType<typeof buildFixture>, id: string, date: string, amount: number) => {
    m.tables.journal_entries.push({ id, fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, book: 'actual', status: 'posted', entry_date: date, memo: 'Late entry', source_type: 'manual' })
    m.tables.journal_postings.push(
      { id: `${id}-1`, journal_entry_id: id, fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-5100', amount, currency: 'USD', lp_entity_id: null },
      { id: `${id}-2`, journal_entry_id: id, fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-1000', amount: -amount, currency: 'USD', lp_entity_id: null },
    )
  }

  it('re-reads only entries outside the closed periods, and still sees a new one there', async () => {
    const m = closedJanuary()
    const io = instrument(m.admin)
    await withCloseCache(async () => {
      const first = await loadPostedLedger(io.admin, FUND, GROUP)
      expect(closeCacheStats(io.admin)).toEqual({ fullReads: 1, tailReads: 0 })
      postIn(m, 'je-late', '2020-03-15', 123.45)
      const second = await loadPostedLedger(io.admin, FUND, GROUP)
      expect(closeCacheStats(io.admin)).toEqual({ fullReads: 1, tailReads: 1 })
      expect(second.postings.length).toBe(first.postings.length + 2)
      expect(second).toEqual(await loadPostedLedger(fresh(m.admin), FUND, GROUP))
      // Up to a date, too.
      expect(await loadPostedLedger(io.admin, FUND, GROUP, '2020-02-29')).toEqual(await loadPostedLedger(fresh(m.admin), FUND, GROUP, '2020-02-29'))
    })
  })

  it('drops what it kept when a closed period is reopened, by this request or any other', async () => {
    const m = closedJanuary()
    await withCloseCache(async () => {
      await loadPostedLedger(m.admin, FUND, GROUP)
      m.tables.fiscal_periods[0].status = 'open'
      postIn(m, 'je-reopened', '2020-01-20', 50)
      const after = await loadPostedLedger(m.admin, FUND, GROUP)
      expect(closeCacheStats(m.admin)).toEqual({ fullReads: 2, tailReads: 0 })
      expect(after.postings.some(p => p.amount === 50)).toBe(true)
    })
  })

  it('drops it when a period is closed again, even over the same dates', async () => {
    const m = closedJanuary()
    await withCloseCache(async () => {
      await loadPostedLedger(m.admin, FUND, GROUP)
      m.tables.fiscal_periods[0].closed_at = '2020-02-06T00:00:00Z'
      await loadPostedLedger(m.admin, FUND, GROUP)
      expect(closeCacheStats(m.admin)).toEqual({ fullReads: 2, tailReads: 0 })
    })
  })

  it('serves the snapshot export the same way', async () => {
    const m = closedJanuary()
    await withCloseCache(async () => {
      await exportLedgerText(m.admin, FUND, GROUP, '2020-02-29')
      postIn(m, 'je-feb', '2020-02-10', 75)
      expect(await exportLedgerText(m.admin, FUND, GROUP, '2020-03-31')).toBe(await exportLedgerText(fresh(m.admin), FUND, GROUP, '2020-03-31'))
      expect(closeCacheStats(m.admin)).toEqual({ fullReads: 1, tailReads: 1 })
    })
  })

  it('does nothing outside a close', async () => {
    const m = closedJanuary()
    await loadPostedLedger(m.admin, FUND, GROUP)
    expect(closeCacheStats(m.admin)).toBeNull()
  })
})

/** A new client over the same tables: the cache is per client, so its first read is a full one. */
const fresh = (admin: any) => ({ ...admin })

describe('frozenWindow', () => {
  const p = (id: string, start: string, end: string) => ({ id, period_start: start, period_end: end, closed_at: null })

  it('joins periods that follow on, and stops at a gap', () => {
    const w = frozenWindow([p('b', '2020-02-01', '2020-02-29'), p('a', '2020-01-01', '2020-01-31'), p('d', '2020-05-01', '2020-05-31')])
    expect(w).toMatchObject({ start: '2020-01-01', end: '2020-02-29' })
    expect(w!.periods.map(x => x.id)).toEqual(['a', 'b'])
  })

  it('takes the run holding the anchor', () => {
    const periods = [p('a', '2019-01-01', '2019-01-31'), p('b', '2020-01-01', '2020-03-31'), p('c', '2020-04-01', '2020-04-30')]
    expect(frozenWindow(periods, '2020-02-15')).toMatchObject({ start: '2020-01-01', end: '2020-04-30' })
    expect(frozenWindow(periods, '2019-06-01')).toBeNull()
  })

  it('is null with nothing closed', () => {
    expect(frozenWindow([])).toBeNull()
  })
})

describe('adoptedEntryIds on a whole-ledger export', () => {
  it('answers the same in one read as in chunks', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `je-${i}`)
    const seed = {
      investment_transactions: [
        { id: 'it-1', fund_id: FUND, adopted_entry_id: 'je-3' },
        { id: 'it-2', fund_id: FUND, adopted_entry_id: 'je-1499' },
        { id: 'it-3', fund_id: FUND, adopted_entry_id: 'je-elsewhere' },
        { id: 'it-4', fund_id: 'fund-2', adopted_entry_id: 'je-7' },
        { id: 'it-5', fund_id: FUND, adopted_entry_id: null },
      ],
    }
    const bulk = instrument(memoryAdmin(seed).admin)
    expect([...await adoptedEntryIds(bulk.admin, FUND, ids)].sort()).toEqual(['je-1499', 'je-3'])
    expect(bulk.calls).toHaveLength(1)
    const few = await adoptedEntryIds(memoryAdmin(seed).admin, FUND, ['je-3', 'je-7', 'je-8'])
    expect([...few]).toEqual(['je-3'])
  })
})

describe('vehicle lookups inside a close', () => {
  it('resolve a name once, and do not keep a failed read', async () => {
    const m = memoryAdmin({ fund_vehicles: [{ id: VEHICLE, fund_id: FUND, name: GROUP, aliases: [] }] })
    const io = instrument(m.admin)
    await withCloseCache(async () => {
      m.failNext('fund_vehicles', 'select', 'connection reset')
      await expect(vehicleIdByName(io.admin, FUND, GROUP)).rejects.toThrow('connection reset')
      expect(await vehicleIdByName(io.admin, FUND, GROUP)).toBe(VEHICLE)
      expect(await vehicleIdByName(io.admin, FUND, GROUP)).toBe(VEHICLE)
    })
    expect(io.calls).toHaveLength(2)
  })
})
