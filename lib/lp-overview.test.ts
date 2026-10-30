import { describe, expect, it } from 'vitest'
import { overviewFromLive, type LiveOverviewRow } from './lp-overview'

const row = (portfolio_group: string, extra: Partial<LiveOverviewRow> = {}): LiveOverviewRow => ({
  portfolio_group, commitment: 100_000, paid_in_capital: 50_000, distributions: 10_000, nav: 60_000, ...extra,
})

describe('overviewFromLive IRR', () => {
  it('leaves IRR out when the fund does not show it', () => {
    const o = overviewFromLive([row('Fund I')])!
    expect('irr' in o.vehicles[0]).toBe(false)
  })

  it("shows one entity's IRR per vehicle, and none in the totals", () => {
    const o = overviewFromLive([row('Fund I', { irr: 0.12 }), row('Fund II', { irr: null })])!
    expect(o.vehicles.find(v => v.name === 'Fund I')!.irr).toBe(0.12)
    expect(o.vehicles.find(v => v.name === 'Fund II')!.irr).toBeNull()
    expect('irr' in o.totals).toBe(false)
  })

  it('does not blend the IRRs of several entities in one vehicle', () => {
    const o = overviewFromLive([row('Fund I', { irr: 0.1 }), row('Fund I', { irr: 0.2 })])!
    expect(o.vehicles[0].irr).toBeNull()
  })
})
