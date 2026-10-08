import { describe, expect, it } from 'vitest'
import { fundHoldingRows } from './fof-holdings'

const holdings = [{ id: 'h1', name: 'Acme Ventures III' }, { id: 'h2', name: 'Beta Growth II' }]
const vehicles = [{ id: 'v1', name: 'Fund I' }, { id: 'v2', name: 'Fund II' }]
const call = (company_id: string, vehicle_id: string | null, amount: number) =>
  ({ company_id, vehicle_id, kind: 'call', event_date: '2026-01-15', amount })
const nav = (company_id: string, vehicle_id: string | null, reported_nav: number) =>
  ({ company_id, vehicle_id, as_of_date: '2026-03-31', reported_nav, basis: 'final' })

describe('fundHoldingRows', () => {
  it('gives a fund held by two entities one row each, with that entity\'s own commitment, calls and NAV', () => {
    const rows = fundHoldingRows({
      asOf: '2026-06-30', holdings: [holdings[0]], vehicles,
      terms: [{ company_id: 'h1', vehicle_id: 'v1', commitment: 5000 }, { company_id: 'h1', vehicle_id: 'v2', commitment: 3000 }],
      events: [call('h1', 'v1', 1000), call('h1', 'v2', 600)],
      navs: [nav('h1', 'v1', 1200), nav('h1', 'v2', 700)],
    })
    expect(rows.map(r => [r.key, r.vehicleName, r.commitment, r.contributed, r.reportedNav])).toEqual([
      ['h1:v1', 'Fund I', 5000, 1000, 1200],
      ['h1:v2', 'Fund II', 3000, 600, 700],
    ])
  })

  it('a holding with no entity yet is one row keyed :none, carrying its unassigned terms', () => {
    const rows = fundHoldingRows({
      asOf: '2026-06-30', holdings: [holdings[1]], vehicles,
      terms: [{ company_id: 'h2', vehicle_id: null, commitment: 2000 }], events: [], navs: [],
    })
    expect(rows).toEqual([expect.objectContaining({ key: 'h2:none', vehicleId: null, vehicleName: null, commitment: 2000 })])
  })

  it('a legacy unassigned terms row is the commitment of the only entity, and of neither of two', () => {
    const one = fundHoldingRows({
      asOf: '2026-06-30', holdings: [holdings[0]], vehicles,
      terms: [{ company_id: 'h1', vehicle_id: null, commitment: 5000 }], events: [call('h1', 'v1', 1000)], navs: [],
    })
    expect(one.map(r => [r.key, r.commitment])).toEqual([['h1:v1', 5000]])
    const two = fundHoldingRows({
      asOf: '2026-06-30', holdings: [holdings[0]], vehicles,
      terms: [{ company_id: 'h1', vehicle_id: null, commitment: 5000 }], events: [call('h1', 'v1', 1000), call('h1', 'v2', 600)], navs: [],
    })
    expect(two.map(r => [r.key, r.commitment])).toEqual([['h1:v1', 0], ['h1:v2', 0]])
  })

  it('orders by fund, then entity', () => {
    const rows = fundHoldingRows({
      asOf: '2026-06-30', holdings: [holdings[1], holdings[0]], vehicles,
      terms: [], events: [call('h2', 'v1', 10), call('h1', 'v2', 10), call('h1', 'v1', 10)], navs: [],
    })
    expect(rows.map(r => r.key)).toEqual(['h1:v1', 'h1:v2', 'h2:v1'])
  })
})
