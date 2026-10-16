import { describe, expect, it } from 'vitest'

import { createDemoFetch, expand } from './mock-api'
import type { DemoAnswers, DemoApi, DemoSnapshot } from './types'

/**
 * The recorder stores a repeated top-level field once (`{ $same: "<key>#<field>" }`) and the
 * mock API puts it back. Also pins which recording stands in for an unrecorded query.
 */
const CHART = [{ code: '1000', name: 'Cash' }, { code: '2100', name: 'Due to GP' }]
const api = {
  responses: {
    'GET /api/accounting/ledger?account=1000&group=Fund+I&preset=itd': { status: 200, body: { accounts: CHART, register: { code: '1000' } } },
    'GET /api/accounting/ledger?account=2100&group=Fund+I&preset=itd': { status: 200, body: { accounts: { $same: 'GET /api/accounting/ledger?account=1000&group=Fund+I&preset=itd#accounts' }, register: { code: '2100' } } },
    'GET /api/accounting/ledger?group=Fund+I&preset=ytd': { status: 200, body: { accounts: { $same: 'GET /api/accounting/ledger?account=1000&group=Fund+I&preset=itd#accounts' }, register: null } },
  },
} as unknown as DemoApi

const demoFetch = createDemoFetch({ snapshot: {} as DemoSnapshot, answers: { answers: [] } as unknown as DemoAnswers, api })
const get = async (href: string) => (await demoFetch(href)).json()

describe('demo mock API', () => {
  it('expands a shared field back to the recorded value', async () => {
    const body = await get('/api/accounting/ledger?preset=itd&group=Fund+I&account=2100')
    expect(body.accounts).toEqual(CHART)
    expect(body.register).toEqual({ code: '2100' })
  })

  it('leaves bodies without references untouched', () => {
    const body = { rows: [1, 2], meta: { a: 1 } }
    expect(expand(body, {})).toBe(body)
  })

  it('stands in the plainest recording for an unrecorded query, not a per-account one', async () => {
    const body = await get('/api/accounting/ledger?group=Fund+I&preset=last_year')
    expect(body.register).toBeNull()
    expect(body.accounts).toEqual(CHART)
  })
})

describe('demo mock API fallback', () => {
  const statements = {
    responses: {
      'GET /api/accounting/lp-statement?group=Fund+I&lp=a&preset=ytd': { status: 200, body: { lp: 'a', preset: 'ytd' } },
      'GET /api/accounting/lp-statement?group=Fund+I&lp=a&preset=itd': { status: 200, body: { lp: 'a', preset: 'itd' } },
      'GET /api/accounting/lp-statement?group=Fund+I&lp=b&preset=ytd': { status: 200, body: { lp: 'b', preset: 'ytd' } },
    },
  } as unknown as DemoApi
  const f = createDemoFetch({ snapshot: {} as DemoSnapshot, answers: { answers: [] } as unknown as DemoAnswers, api: statements })

  it('keeps the same LP when only the period is unrecorded', async () => {
    const body = await (await f('/api/accounting/lp-statement?lp=b&preset=last_quarter&group=Fund+I')).json()
    expect(body.lp).toBe('b')
  })
})

describe('batched chart compatibility', () => {
  it('assembles old per-metric recordings and falls back to synthetic snapshot series', async () => {
    const snapshot = {
      generatedAt: '2026-04-01',
      companies: [{ id: 'c1', metrics: [
        { id: 'cash', values: [] },
        { id: 'mrr', values: [{ year: 2026, quarter: 1, month: null, period_label: 'Q1 2026', number: 25 }] },
      ] }],
    } as unknown as DemoSnapshot
    const fetch = createDemoFetch({ snapshot, answers: { answers: [] } as unknown as DemoAnswers,
      api: { responses: { 'GET /api/companies/c1/metrics/cash/values': {
        status: 200, body: [{ metric_id: 'cash', value_number: 100 }],
      } } } as unknown as DemoApi })
    const response = await fetch('/api/companies/c1/metrics/values')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      cash: [{ metric_id: 'cash', value_number: 100 }],
      mrr: [{ metric_id: 'mrr', value_number: 25, period_label: 'Q1 2026' }],
    })
    expect((await fetch('/api/companies/unavailable/metrics/values')).status).toBe(404)
  })
})
