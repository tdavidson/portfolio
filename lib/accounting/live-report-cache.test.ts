import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'

const build = vi.fn()
vi.mock('./live-report', () => ({ generateLiveReport: (...args: any[]) => build(...args) }))

import { currentLiveReport, serializeReport, deserializeReport } from './live-report-cache'

const FUND = 'fund-1'
const report = (nav: number) => ({
  asOf: null,
  rows: [{ entity_id: 'lp-1', portfolio_group: 'Example Fund I', source: 'ledger', commitment: 100_000, called_capital: 50_000, paid_in_capital: 50_000, distributions: 0, nav, total_value: nav, outstanding_balance: 50_000, receivable: 0, dpi: 0, rvpi: nav / 50_000, tvpi: nav / 50_000, irr: null }],
  vehicles: [{ group: 'Example Fund I', source: 'ledger', lps: 1 }],
  entityNames: new Map([['lp-1', 'Jane Doe']]),
})

beforeEach(() => { build.mockReset() })

describe('currentLiveReport', () => {
  it('builds once, then serves the stored report while the fund data version is unchanged', async () => {
    const m = memoryAdmin({ fund_data_versions: [{ fund_id: FUND, version: 3 }], lp_report_cache: [] })
    build.mockResolvedValueOnce(report(60_000))
    const first = await currentLiveReport(m.admin, FUND)
    expect(first.fromCache).toBe(false)
    expect(build).toHaveBeenCalledTimes(1)

    const second = await currentLiveReport(m.admin, FUND)
    expect(second.fromCache).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
    expect(second.rows[0].nav).toBe(60_000)
    expect(second.entityNames.get('lp-1')).toBe('Jane Doe')
    expect(second.computedAt).toBe(first.computedAt)
  })

  it('rebuilds once the data version moves on (anything posted, closed or pulled since)', async () => {
    const m = memoryAdmin({ fund_data_versions: [{ fund_id: FUND, version: 3 }], lp_report_cache: [] })
    build.mockResolvedValueOnce(report(60_000)).mockResolvedValueOnce(report(65_000))
    await currentLiveReport(m.admin, FUND)
    m.tables.fund_data_versions[0].version = 4
    const after = await currentLiveReport(m.admin, FUND)
    expect(after.fromCache).toBe(false)
    expect(after.rows[0].nav).toBe(65_000)
    expect(m.tables.lp_report_cache[0].data_version).toBe(4)
  })

  it('rebuilds on refresh, and after a day as a backstop', async () => {
    const m = memoryAdmin({ fund_data_versions: [{ fund_id: FUND, version: 1 }], lp_report_cache: [] })
    build.mockResolvedValue(report(60_000))
    const t0 = new Date('2026-01-01T00:00:00Z')
    await currentLiveReport(m.admin, FUND, { now: () => t0 })
    await currentLiveReport(m.admin, FUND, { refresh: true, now: () => t0 })
    expect(build).toHaveBeenCalledTimes(2)
    const later = await currentLiveReport(m.admin, FUND, { now: () => new Date('2026-01-02T00:00:01Z') })
    expect(later.fromCache).toBe(false)
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('builds every time when the version table is not there yet (migration not applied)', async () => {
    const m = memoryAdmin({})
    m.failNext('fund_data_versions', 'select', 'relation "fund_data_versions" does not exist')
    m.failNext('fund_data_versions', 'select', 'relation "fund_data_versions" does not exist')
    build.mockResolvedValue(report(60_000))
    expect((await currentLiveReport(m.admin, FUND)).fromCache).toBe(false)
    expect((await currentLiveReport(m.admin, FUND)).fromCache).toBe(false)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('round-trips a report through its stored form', () => {
    const r = report(60_000) as any
    const back = deserializeReport(JSON.parse(JSON.stringify(serializeReport(r))))
    expect(back.rows).toEqual(r.rows)
    expect(Array.from(back.entityNames.entries())).toEqual([['lp-1', 'Jane Doe']])
  })
})
