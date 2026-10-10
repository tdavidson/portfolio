// A failed read must throw, not become an empty list: an empty list is a wrong digest whose keys
// then get logged as delivered. The cron turns a throw into a per-fund error with nothing sent.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadFundReminderData, loadReminderSettings } from './load'

type Result = { data: unknown; error: { message: string } | null }
type Call = { table: string; orders: string[]; range?: [number, number] }

/** Chainable PostgREST stand-in: every builder method returns the builder; awaiting it yields the
 *  table's configured result (a function of the requested range, for paginated reads). */
function fakeDb(results: Record<string, Result | ((range?: [number, number]) => Result)>) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, orders: [] }
    calls.push(call)
    const builder: unknown = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const r = results[table]
          const value = typeof r === 'function' ? r(call.range) : (r ?? { data: [], error: null })
          return (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject)
        }
        if (prop === 'order') return (col: string) => { call.orders.push(col); return builder }
        if (prop === 'range') return (f: number, t: number) => { call.range = [f, t]; return builder }
        return () => builder
      },
    })
    return builder
  }
  return { db: { from } as unknown as SupabaseClient, calls }
}

const ok = (data: unknown): Result => ({ data, error: null })
const fail = (message: string): Result => ({ data: null, error: { message } })

describe('loadReminderSettings', () => {
  it('throws when fund_settings fails to load', async () => {
    const { db } = fakeDb({ fund_settings: fail('boom'), funds: ok({ name: 'Acme' }) })
    await expect(loadReminderSettings(db, 'f')).rejects.toThrow('reminders: fund_settings load failed: boom')
  })

  it('throws when funds fails to load', async () => {
    const { db } = fakeDb({ fund_settings: ok(null), funds: fail('down') })
    await expect(loadReminderSettings(db, 'f')).rejects.toThrow('reminders: funds load failed: down')
  })
})

describe('loadFundReminderData', () => {
  const tables = [
    'compliance_items', 'fund_compliance_profile', 'compliance_fund_settings', 'compliance_deadlines',
    'fund_vehicles', 'fund_cash_flows', 'vehicle_closings', 'email_requests', 'companies', 'metric_values', 'ask_response_overrides',
    'capital_calls',
  ]

  it.each(tables)('throws when %s fails to load', async table => {
    const { db } = fakeDb({ [table]: fail('timeout') })
    await expect(loadFundReminderData(db, 'f', '2026-09-18', 0)).rejects.toThrow(`reminders: ${table} load failed: timeout`)
  })

  it('pages the closes, metric_values and the closed compliance_deadlines read past 1000 rows, in a stable order', async () => {
    const pageOf = (row: object) => (range?: [number, number]) =>
      ok(range && range[0] === 0 ? Array.from({ length: 1000 }, () => row) : [row])
    const { db, calls } = fakeDb({
      fund_cash_flows: pageOf({ portfolio_group: 'Fund I', flow_date: '2026-03-01' }),
      vehicle_closings: pageOf({ vehicle_id: 'v1', close_date: '2026-04-01' }),
      fund_vehicles: ok([{ id: 'v1', name: 'Fund I' }]),
      metric_values: pageOf({ company_id: 'c1', period_year: 2026, period_quarter: 2, period_month: null }),
      compliance_deadlines: pageOf({ compliance_item_id: 'form-adv', portfolio_group: '', quarter: 0, year: 2026 }),
    })
    const data = await loadFundReminderData(db, 'f', '2026-09-18', 0)

    for (const table of ['fund_cash_flows', 'vehicle_closings', 'metric_values', 'compliance_deadlines']) {
      const reads = calls.filter(c => c.table === table)
      expect(reads.map(c => c.range), table).toEqual([[0, 999], [1000, 1999]])
      expect(reads[0].orders.at(-1), table).toBe('id')
    }
    expect(data.compliance.closed).toHaveLength(1001)
    // Every page was read; a close is a date, so the same date many times is one close.
    expect(data.compliance.closeDates['Fund I']).toEqual(['2026-03-01', '2026-04-01'])
  })
})
