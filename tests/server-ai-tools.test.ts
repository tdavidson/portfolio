import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ hasKey: true, summaries: [] as any[], parses: [] as any[], limited: false }))
vi.mock('@/lib/ai/keyless', async orig => ({
  ...(await orig<typeof import('@/lib/ai/keyless')>()),
  fundHasAIKey: async () => m.hasKey,
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => (m.limited ? { status: 429 } : null) }))
vi.mock('@/lib/companies/summary', () => ({
  generateCompanySummary: async (_admin: unknown, access: any, companyId: string, opts: any) => {
    m.summaries.push({ userId: access.userId, companyId, opts })
    return { ok: true, value: { summary: 'Acme grew MRR 12% in Q3.', period_label: 'Q3 2026', generated_at: '2026-10-14T00:00:00Z' } }
  },
}))
vi.mock('@/lib/portfolio/ai-import', () => ({
  parsePortfolioImport: async (_admin: unknown, fundId: string, userId: string, text: unknown) => {
    m.parses.push({ fundId, userId, text })
    return { ok: true, value: { companies: [
      { name: 'Acme', metrics: [{ name: 'MRR', historical_values: [{ period: 'Q2 2026', value: 100 }, { period: 'Q3 2026', value: 112 }] }] },
      { name: 'Nova Robotics', stage: 'Seed', metrics: [] },
    ] } }
  },
}))

import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { stageToolCall } from '@/lib/agent/tool-call-action'
import { SERVER_AI_HANDLERS } from '@/lib/agent/server-ai-tools'
import { AI_CAPABILITIES } from '@/lib/ai/capabilities'
import { memoryAdmin } from './helpers/memory-admin'

const everyone = { fundId: 'f1', userId: 'u1', role: 'admin', vehicles: { all: true, ids: [] }, features: {}, grants: {}, defaults: {} } as any
const member = { fundId: 'f1', userId: 'u2', role: 'member', vehicles: { all: false, ids: ['v1'] }, features: {}, grants: {}, defaults: {} } as any

function seed() {
  return memoryAdmin({
    companies: [{ id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company' }, { id: 'c2', fund_id: 'f1', name: 'Beta', holding_type: 'company' }],
    company_vehicles: [{ fund_id: 'f1', company_id: 'c1', vehicle_id: 'v1' }],
  })
}
const ctx = (admin: any, access = everyone) => ({ admin, fundId: 'f1', portfolioGroup: '', userId: access.userId, access })

beforeEach(() => { m.hasKey = true; m.summaries = []; m.parses = []; m.limited = false })

describe('company_generate_summary', () => {
  it('runs the Summarise button\'s function for the company, and is staged from a chat', async () => {
    const { admin } = seed()
    const out = await SERVER_AI_HANDLERS.company_generate_summary(ctx(admin), { company: 'acme', provider: 'openai' }) as any
    expect(m.summaries).toEqual([{ userId: 'u1', companyId: 'c1', opts: { provider: 'openai' } }])
    expect(out).toMatchObject({ company: 'Acme', summary: 'Acme grew MRR 12% in Q3.', saved: true })
    expect(shouldStage(getTool('company_generate_summary')!, {}, { keyId: 'oauth:x' })).toBe(true)
  })

  it('with no server key, refuses (at the call and before staging) and says what to do in chat', async () => {
    m.hasKey = false
    const { admin } = seed()
    await expect(SERVER_AI_HANDLERS.company_generate_summary(ctx(admin), { company: 'Acme' }))
      .rejects.toThrow(/no server AI key.*company_detail, company_metrics and get_updates.*company_save_summary/)
    await expect(stageToolCall({ admin, fundId: 'f1', userId: 'u1', access: everyone }, 'company_generate_summary', { company: 'Acme' }))
      .rejects.toThrow(/company_save_summary/)
    expect(m.summaries).toEqual([])
  })

  it('keeps to the button\'s rate limit and the caller\'s companies', async () => {
    const { admin } = seed()
    await expect(SERVER_AI_HANDLERS.company_generate_summary(ctx(admin, member), { company: 'Beta' })).rejects.toThrow(/No company named/)
    m.limited = true
    await expect(SERVER_AI_HANDLERS.company_generate_summary(ctx(admin), { company: 'Acme' })).rejects.toThrow(/Too many AI requests/)
  })
})

describe('portfolio_import_preview', () => {
  it('returns the parsed proposal, matched to existing companies, and writes nothing', async () => {
    const { admin, tables } = seed()
    const before = JSON.stringify(tables)
    const out = await SERVER_AI_HANDLERS.portfolio_import_preview(ctx(admin), { text: 'name,mrr q2,mrr q3\nAcme,100,112\nNova Robotics,,' }) as any
    expect(m.parses[0]).toMatchObject({ fundId: 'f1', userId: 'u1' })
    expect(out.written).toBe(false)
    expect(out.companies[0]).toMatchObject({ name: 'Acme', match: { existingCompanyId: 'c1' } })
    expect(out.companies[1]).toMatchObject({ name: 'Nova Robotics', match: null, action: expect.stringMatching(/^new company/) })
    expect(out.counts).toEqual({ companies: 2, existing: 1, new: 1, metricValues: 2 })
    expect(out.next).toMatch(/create_company[^]*record_metric_value[^]*stage_run/)
    expect(JSON.stringify(tables)).toBe(before)
  })

  it('a scoped member is told a company outside their entities needs an admin', async () => {
    const { admin } = seed()
    const out = await SERVER_AI_HANDLERS.portfolio_import_preview(ctx(admin, member), { text: 'x' }) as any
    expect(out.companies[1].action).toMatch(/an admin must add it/)
  })

  it('runs directly (it changes nothing) under the imports switch, and refuses with no key', async () => {
    const tool = getTool('portfolio_import_preview')!
    expect(tool).toMatchObject({ scope: 'write', accessFeature: 'imports', runsDirectly: true })
    expect(shouldStage(tool, {}, { keyId: 'oauth:x' })).toBe(false)
    m.hasKey = false
    const { admin } = seed()
    await expect(SERVER_AI_HANDLERS.portfolio_import_preview(ctx(admin), { text: 'x' })).rejects.toThrow(/read the rows yourself.*create_company/)
    expect(m.parses).toEqual([])
  })

  it('both are named where the capabilities list says how to do the same in chat', () => {
    const tools = AI_CAPABILITIES.flatMap(c => c.tools ?? [])
    expect(tools).toContain('company_save_summary')
    expect(AI_CAPABILITIES.find(c => c.key === 'company_summary')!.why).toContain('company_generate_summary')
    expect(AI_CAPABILITIES.find(c => c.key === 'imports')!.why).toContain('portfolio_import_preview')
  })
})
