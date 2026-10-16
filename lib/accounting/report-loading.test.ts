import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { loadFundPreload } from './fund-preload'
import { loadLedgerChart } from './load'

function database() {
  const calls: URL[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); calls.push(url)
    const table = url.pathname.split('/').at(-1)
    let data: unknown = []
    if (table === 'fund_vehicles') data = url.searchParams.has('name') ? { id: 'v-a' } : [
      { id: 'v-a', name: 'Fund A', aliases: ['Alias A'] }, { id: 'v-b', name: 'Fund B', aliases: [] },
    ]
    if (table === 'chart_of_accounts') {
      const rows = Array.from({ length: 1201 }, (_, i) => ({ id: `a-${i}`, code: `${i}`, name: 'Synthetic', type: 'asset', vehicle_id: 'v-a' }))
      const offset = Number(url.searchParams.get('offset') ?? 0)
      data = rows.slice(offset, offset + Number(url.searchParams.get('limit') ?? 1000))
    }
    return new Response(JSON.stringify(data))
  })
  return { calls, db: createClient('https://synthetic.invalid', 'synthetic', { global: { fetch }, auth: { persistSession: false } }) }
}

describe('scoped report reads', () => {
  it('limits heavy preload queries to the requested vehicle, including aliases', async () => {
    const { db, calls } = database()
    const data = await loadFundPreload(db, 'fund-a', '2026-09-30', ['Alias A'])
    expect([...data.ledgerByVehicleId.keys()]).toEqual(['v-a'])
    expect(data.ledgerByVehicleId.get('v-a')?.acctRows).toHaveLength(1201)
    const scoped = calls.filter(c => c.searchParams.has('vehicle_id'))
    expect(scoped.length).toBeGreaterThan(3)
    for (const url of scoped) {
      expect(url.searchParams.get('vehicle_id')).toBe('in.(v-a)')
      expect(url.searchParams.get('fund_id')).toBe('eq.fund-a')
    }
  })
  it('loads the full chart without reading journal history', async () => {
    const { db, calls } = database()
    expect(await loadLedgerChart(db, 'fund-a', 'Fund A')).toHaveLength(1201)
    expect(calls.every(url => /\/(fund_vehicles|chart_of_accounts)$/.test(url.pathname))).toBe(true)
    for (const url of calls.filter(u => u.pathname.endsWith('/chart_of_accounts'))) {
      expect(url.searchParams.get('fund_id')).toBe('eq.fund-a')
      expect(url.searchParams.get('vehicle_id')).toBe('eq.v-a')
    }
  })
})
