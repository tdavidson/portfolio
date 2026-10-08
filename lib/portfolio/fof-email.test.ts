// lib/portfolio/fof-email.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { CreateMessageParams } from '@/lib/ai/types'
import { proposeFundReviews, proposalsFromRows, CAPS } from './fof-email'

const statement = {
  rows: [{
    fundName: 'Meridian Growth Partners IV', navAsOf: '2025-09-30', reportedNav: 9_445_000,
    calls: 1_250_000, distributions: 475_000, eventDate: null, confidence: 'high', sourceText: 'Ending capital 9,445,000',
  }],
}
const provider = (reply: unknown) => ({
  createMessage: vi.fn(async (_p: CreateMessageParams) => ({ text: JSON.stringify(reply), usage: { inputTokens: 0, outputTokens: 0 }, truncated: false })),
})
const ALL = { vehicles: { all: true, ids: [] as string[] } }

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  m = memoryAdmin({
    companies: [
      { id: 'h1', fund_id: 'f', name: 'Meridian Growth Partners IV', aliases: [], holding_type: 'fund' },
      { id: 'co', fund_id: 'f', name: 'Beta Inc', aliases: [], holding_type: 'company' },
    ],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
    fund_capital_events: [{ id: 'e0', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2025-03-01', amount: 500 }],
    fund_nav_statements: [], chart_of_accounts: [], parsing_reviews: [],
  })
})
const run = (p = provider(statement), companyId = 'h1') => proposeFundReviews(m.admin, {
  fundId: 'f', emailId: 'em1', companyId, access: ALL, ai: { provider: p, model: 'm' },
  content: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBER' }], fallbackDate: '2025-11-14',
})

describe('proposeFundReviews', () => {
  it('writes one review per proposed register row, for the holding\'s only entity', async () => {
    const r = await run()
    expect(r.written).toBe(3)
    const reviews = m.tables.parsing_reviews
    expect(reviews.map((x: any) => x.issue_type).sort()).toEqual(['fund_capital_call', 'fund_distribution', 'fund_nav'])
    expect(reviews.every((x: any) => x.vehicle_id === 'v1' && x.company_id === 'h1' && x.email_id === 'em1' && x.fund_id === 'f')).toBe(true)
    expect(reviews.find((x: any) => x.issue_type === 'fund_nav')?.payload).toMatchObject({ kind: 'nav', asOfDate: '2025-09-30', reportedNav: 9_445_000 })
    // A statement's period totals carry no date of their own: the valuation date stands in, flagged.
    expect(reviews.find((x: any) => x.issue_type === 'fund_distribution')?.payload).toMatchObject({ eventDate: '2025-09-30', amount: 475_000, dateAssumed: true })
    expect(m.tables.fund_nav_statements).toEqual([])
    expect(m.tables.fund_capital_events).toHaveLength(1)
  })

  it('leaves the entity to the approver when two entities hold the fund', async () => {
    m.tables.fund_capital_events.push({ id: 'e1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', kind: 'call', event_date: '2025-03-02', amount: 300 })
    await run()
    expect(m.tables.parsing_reviews.every((x: any) => x.vehicle_id === null)).toBe(true)
  })

  it('does not propose a call already recorded from its notice, nor the same email twice', async () => {
    m.tables.fund_capital_events.push({ id: 'e2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2025-08-12', amount: 1_250_000 })
    const first = await run()
    expect(first.written).toBe(2)
    expect(m.tables.parsing_reviews.map((x: any) => x.issue_type).sort()).toEqual(['fund_distribution', 'fund_nav'])
    const again = await run()
    expect(again.written).toBe(0)
    expect(m.tables.parsing_reviews).toHaveLength(2)
  })

  it('does nothing for a company that is not a fund holding', async () => {
    const p = provider(statement)
    expect(await run(p, 'co')).toEqual({ written: 0, warnings: [] })
    expect(p.createMessage).not.toHaveBeenCalled()
  })

  it('turns a reader failure into a warning', async () => {
    const p = { createMessage: vi.fn(async (_p: CreateMessageParams) => { throw new Error('rate limited') }) }
    const r = await run(p as any)
    expect(r).toMatchObject({ written: 0, warnings: [expect.stringMatching(/rate limited/)] })
  })
})

describe('proposalsFromRows', () => {
  const row = (fundName: string) => ({ ...statement.rows[0], fundName, dueDate: null, noticeNumber: null, purpose: null, eventDate: null, confidence: 'high' as const, sourceText: null })
  it('takes a one-fund document as this fund even under a longer legal name', () => {
    expect(proposalsFromRows([row('Meridian Growth Partners IV, L.P.')], { id: 'h1', name: 'Meridian Growth Partners IV' }, { fallbackDate: '2025-11-14' }).proposals).toHaveLength(3)
  })
  it('takes only this fund\'s rows from a several-fund document, and says when none is this fund', () => {
    const many = [row('Meridian Growth Partners IV'), row('Acme Ventures III')]
    expect(proposalsFromRows(many, { id: 'h1', name: 'Meridian Growth Partners IV' }, { fallbackDate: '2025-11-14' }).proposals.every(p => p.fundName === 'Meridian Growth Partners IV')).toBe(true)
    const none = proposalsFromRows([row('Acme Ventures III'), row('Beta II')], { id: 'h1', name: 'Meridian Growth Partners IV' }, { fallbackDate: '2025-11-14' })
    expect(none.proposals).toEqual([])
    expect(none.warnings.join(' ')).toMatch(/none is named/)
  })
})

describe('proposalsFromRows caps untrusted free text', () => {
  const base = { fundName: 'Meridian Growth Partners IV', navAsOf: '2025-09-30', reportedNav: 1, calls: 5, distributions: 0, eventDate: null, dueDate: null, confidence: 'high' as const }
  const holding = { id: 'h1', name: 'Meridian Growth Partners IV' }
  it('truncates noticeNumber, purpose and sourceText, keeping the proposal', () => {
    const { proposals } = proposalsFromRows([{ ...base, noticeNumber: 'n'.repeat(5000), purpose: 'p'.repeat(5000), sourceText: 's'.repeat(5000) }], holding, { fallbackDate: '2025-11-14' })
    const call: any = proposals.find(p => p.kind === 'call')
    expect(call.noticeNumber).toHaveLength(CAPS.noticeNumber)
    expect(call.purpose).toHaveLength(CAPS.purpose)
    expect(call.sourceText).toHaveLength(CAPS.sourceText)
    expect(proposals.find(p => p.kind === 'nav')!.sourceText).toHaveLength(CAPS.sourceText)
  })
  it('stringifies a finite numeric noticeNumber instead of dropping it', () => {
    const { proposals } = proposalsFromRows([{ ...base, noticeNumber: 7 as any, purpose: null, sourceText: null }], holding, { fallbackDate: '2025-11-14' })
    expect((proposals.find(p => p.kind === 'call') as any).noticeNumber).toBe('7')
  })
})

describe('proposeFundReviews robustness', () => {
  const failing = (table: string, op = 'select') => {
    const real = m.admin as any
    return new Proxy(real, {
      get(t, prop) {
        if (prop !== 'from') return t[prop]
        return (name: string) => {
          const b = t.from(name)
          if (name !== table) return b
          const wrap: any = new Proxy({}, {
            get: (_o, k) => k === 'then'
              ? (res: any) => res({ data: null, error: { message: 'db down' } })
              : () => wrap,
          })
          return wrap
        }
      },
    })
  }
  const runWith = (admin: any, p = provider(statement)) => proposeFundReviews(admin, {
    fundId: 'f', emailId: 'em1', companyId: 'h1', access: ALL, ai: { provider: p, model: 'm' },
    content: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBER' }], fallbackDate: '2025-11-14',
  })
  it.each(['companies', 'parsing_reviews', 'fund_nav_statements', 'fund_capital_events'])('a failed %s read writes nothing and warns', async table => {
    const r = await runWith(failing(table))
    expect(r.written).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/db down/)
    expect(m.tables.parsing_reviews).toEqual([])
  })

  it('writes a row the model emitted twice once', async () => {
    const r = await run(provider({ rows: [statement.rows[0], statement.rows[0]] }))
    expect(r.written).toBe(3)
    expect(m.tables.parsing_reviews).toHaveLength(3)
  })

  it('a call on the previous quarter end does not suppress this quarter\'s assumed-date call', async () => {
    m.tables.fund_capital_events.push({ id: 'e3', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2025-06-30', amount: 1_250_000 })
    await run()
    expect(m.tables.parsing_reviews.map((x: any) => x.issue_type)).toContain('fund_capital_call')
  })
  it('a call just inside the window still counts as recorded', async () => {
    m.tables.fund_capital_events.push({ id: 'e4', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2025-07-01', amount: 1_250_000 })
    await run()
    expect(m.tables.parsing_reviews.map((x: any) => x.issue_type)).not.toContain('fund_capital_call')
  })

  it('with no entity inferred, only entity-less rows count as recorded', async () => {
    m.tables.fund_capital_events.push({ id: 'e5', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', kind: 'call', event_date: '2025-08-12', amount: 1_250_000 })
    await run()
    expect(m.tables.parsing_reviews.every((x: any) => x.vehicle_id === null)).toBe(true)
    expect(m.tables.parsing_reviews.map((x: any) => x.issue_type)).toContain('fund_capital_call')
  })

  it('caps the fund name', () => {
    const row = { ...statement.rows[0], fundName: 'F'.repeat(900), dueDate: null, noticeNumber: null, purpose: null, confidence: 'high' as const, sourceText: null, eventDate: null }
    const { proposals } = proposalsFromRows([row], { id: 'h1', name: 'X' }, { fallbackDate: '2025-11-14' })
    expect(proposals[0].fundName).toHaveLength(200)
  })
})
