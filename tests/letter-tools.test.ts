import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * LP letters from chat and the API: listed, read, written and shared through the LP Letters
 * pages' own functions, each within the caller's entities. The assistant can be the writer.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

let access: AccessContext
const store = memoryAdmin()
const letterPdf = vi.fn(async () => ({ pdf: Buffer.from('%PDF-letter'), fileName: 'Q3 2026.pdf' }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) => ({ access: a, vehicleNames: a.vehicles.all ? null : ['Fund I'], companyIds: null }),
}))
vi.mock('@/lib/lp-report-pdf', () => ({
  generateLetterPdf: (...a: unknown[]) => (letterPdf as any)(...a),
  generateInvestorReportPdf: async () => null,
  generateLiveInvestorReportPdf: async () => null,
}))
const company = (id: string, name: string) => ({
  investment: { companyId: id, companyName: name, status: 'active', stage: 'Seed', totalInvested: 100, fmv: 200, moic: 2 },
  metrics: [], notes: [], recentNotes: [], latestUpdate: null,
})
vi.mock('@/lib/lp-letters/aggregate', () => ({
  aggregatePortfolioData: async () => ({
    fundName: 'Hemlock Fund I', fundCurrency: 'USD', periodLabel: 'Q3 2026', portfolioGroup: 'Fund I',
    companies: [company('c1', 'Acme'), company('c2', 'Birch')],
    fundMetrics: null,
    totals: { totalInvested: 200, totalFmv: 400, totalRealized: 0, portfolioMoic: 2, activeCount: 2, exitedCount: 0, writtenOffCount: 0 },
  }),
}))

const createMessage = vi.fn(async () => ({ text: 'Fund AI letter.\n\nMissing information\n- Birch update.', usage: { inputTokens: 1, outputTokens: 1 } }))
vi.mock('@/lib/ai', () => ({ createFundAIProvider: async () => ({ provider: { createMessage }, model: 'm', providerType: 'anthropic' }) }))
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: async () => {} }))

import { LETTER_HANDLERS as H } from '@/lib/agent/letter-tools'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { GET } from '@/app/api/agent/reports/[token]/route'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})
const ctx = (a = member({ lp_relations: 'write' })) => ({ admin: store.admin, fundId: 'fund-1', portfolioGroup: '', userId: 'user-me', access: a, origin: 'https://fund.test' }) as any

beforeEach(() => {
  access = member({ lp_relations: 'read' })
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }]
  store.tables.fund_vehicles = [
    { id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
    { id: 'v2', fund_id: 'fund-1', name: 'Fund II', active: true, kind: 'fund', aliases: null },
  ]
  store.tables.lp_letters = [
    { id: 'l1', fund_id: 'fund-1', period_year: 2026, period_quarter: 3, period_label: 'Q3 2026', portfolio_group: 'Fund I', status: 'draft', is_year_end: false, company_narratives: [{ company_id: 'c2', company_name: 'Birch', narrative: 'Old Birch text', updated_by: null, updated_at: '' }], full_draft: 'old' },
    { id: 'l2', fund_id: 'fund-1', period_year: 2026, period_quarter: 3, period_label: 'Q3 2026', portfolio_group: 'Fund II', status: 'draft', is_year_end: false },
  ]
  store.tables.lp_investors = [{ id: 'inv-1', fund_id: 'fund-1', name: 'Acme' }, { id: 'inv-2', fund_id: 'fund-1', name: 'Birch Family' }]
  store.tables.lp_letter_shares = []
  store.tables.lp_letter_templates = [
    { id: 't1', fund_id: 'fund-1', name: 'House style', style_guide: 'Open with three themes.', is_default: true },
    { id: 't2', fund_id: 'fund-1', name: 'Short', style_guide: 'One page.', is_default: false },
  ]
  store.tables.company_updates = [
    { id: 'u1', fund_id: 'fund-1', company_id: 'c1', received_at: '2026-10-04T10:00:00Z', subject: 'Q3', period_label: 'Q3 2026', period_year: 2026, period_quarter: 3, period_month: null, body_current: 'Acme closed two enterprise pilots. Birch Family visited.', body_original: null, sender_email: 'founder@acme.test' },
    { id: 'u2', fund_id: 'fund-1', company_id: 'c1', received_at: '2026-07-04T10:00:00Z', subject: 'Q2', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, period_month: null, body_current: 'Last quarter.', body_original: null },
  ]
  vi.clearAllMocks()
})

describe('LP letter tools', () => {
  it('are LP relations tools under the letters switch; writes are staged from a chat, sharing needs an admin', () => {
    for (const name of ['lp_create_letter', 'lp_write_letter', 'lp_share_letter']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ scope: 'write', accessDomain: 'lp_relations', accessFeature: 'lp_letters' })
      expect(shouldStage(tool, {}, { keyId: 'oauth:x' }), name).toBe(true)
    }
    expect(adminOnlyToolLabel('lp_share_letter', {})).toBe('share an LP letter')
    expect(adminOnlyToolLabel('lp_write_letter', {})).toBeUndefined()
  })

  it("lists and reads only the caller's entities' letters", async () => {
    expect(((await H.lp_letters(ctx(), {})) as any).letters.map((l: any) => l.id)).toEqual(['l1', 'l2'])
    const scoped = ctx(member({ lp_relations: 'read' }, false))
    expect(((await H.lp_letters(scoped, {})) as any).letters.map((l: any) => l.id)).toEqual(['l1'])
    await expect(H.lp_letter(scoped, { letter_id: 'l2' })).rejects.toThrow('No letter')
    await expect(H.lp_write_letter(scoped, { letter_id: 'l2', full_draft: 'x' })).rejects.toThrow('Not found')
  })

  it('starts a letter only for an entity the caller can see', async () => {
    const out = await H.lp_create_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 4 }) as any
    expect(out.letter).toMatchObject({ period: 'Q4 2026', vehicle: 'Fund I', status: 'draft' })
    await expect(H.lp_create_letter(ctx(member({ lp_relations: 'write' }, false)), { vehicle: 'Fund II', year: 2026, quarter: 4 })).rejects.toThrow()
  })

  it("writes the assistant's sections, keeping the others, and rebuilds the table and draft", async () => {
    const data = await H.lp_letter_data(ctx(), { letter_id: 'l1' }) as any
    expect(data.companies.map((c: any) => c.investment.companyId)).toEqual(['c1', 'c2'])
    await H.lp_write_letter(ctx(), { letter_id: 'l1', sections: [{ company_id: 'c1', narrative: 'Acme grew revenue 40%.' }] })
    const row = store.tables.lp_letters.find((l: any) => l.id === 'l1')!
    expect(row.company_narratives.map((n: any) => [n.company_name, n.narrative])).toEqual([['Acme', 'Acme grew revenue 40%.'], ['Birch', 'Old Birch text']])
    expect(row.full_draft).toContain('Acme grew revenue 40%.')
    expect(row.portfolio_table_html).toContain('Acme')
    await expect(H.lp_write_letter(ctx(), { letter_id: 'l1', sections: [{ company_id: 'nope', narrative: 'x' }] })).rejects.toThrow("Not in this letter's portfolio")
  })

  it("briefs the quarter's letter from the stored updates, with investors kept out", async () => {
    const brief = await H.lp_letter_brief(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3 }) as any
    expect(brief.instructions).toContain('drafting the Q3 2026 LP letter for Fund I')
    expect(brief.template).toBe('House style')
    expect(brief.instructions).toContain('Open with three themes.')
    expect(brief.companies[0].updates_this_quarter.map((u: any) => u.text)).toEqual(['Acme closed two enterprise pilots. [investor] visited.'])
    expect(JSON.stringify(brief)).not.toMatch(/founder@acme\.test|Birch Family/)
    expect(brief.missing_information).toContain('Birch: no company update or KPI values are stored for Q3 2026.')
    await expect(H.lp_letter_brief(ctx(member({ lp_relations: 'read' }, false)), { vehicle: 'Fund II', year: 2026, quarter: 3 })).rejects.toThrow()
  })

  it('drafts as a new unshared draft letter, never staged, and returns review flags', async () => {
    const tool = getTool('lp_draft_letter')!
    expect(tool).toMatchObject({ scope: 'write', accessDomain: 'lp_relations', accessFeature: 'lp_letters' })
    expect(shouldStage(tool, {}, { keyId: 'oauth:x' })).toBe(false)
    expect(adminOnlyToolLabel('lp_draft_letter', {})).toBeUndefined()

    const out = await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, text: 'Acme returned a TVPI of 9.9x.' }) as any
    expect(out.written_by).toBe('assistant')
    expect(out.letter).toMatchObject({ period: 'Q3 2026', vehicle: 'Fund I', status: 'draft' })
    expect(out.review_flags).toEqual(expect.arrayContaining([
      'No "Missing information" section at the end.',
      '"9.9x" does not appear in the sources.',
    ]))
    const row = store.tables.lp_letters.find((l: any) => l.id === out.letter.id)!
    expect(row.full_draft).toBe('Acme returned a TVPI of 9.9x.')
    expect(row.portfolio_table_html).toContain('Gross FMV')
    expect(store.tables.lp_letter_shares).toEqual([])
    // The existing draft for the quarter is untouched.
    expect(store.tables.lp_letters.find((l: any) => l.id === 'l1')!.full_draft).toBe('old')
  })

  it("lets the fund's own AI write it from the brief, in layers: rules, profile, skill, voice", async () => {
    const out = await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, guidance: 'Lead with Acme.' }) as any
    expect(out.written_by).toBe('fund AI')
    expect(out.review_flags).toEqual([])
    const sent = (createMessage.mock.calls[0] as any[])[0].content as string
    expect(sent).toContain('<data label="letter-brief" type="reference-only">')
    expect(sent).toContain('Acme closed two enterprise pilots.')
    expect(sent).not.toContain('Last quarter.')
    const at = (t: string) => { const i = sent.indexOf(t); expect(i, t).toBeGreaterThan(-1); return i }
    const order = [at('1. RULES'), at('2. LETTER PROFILE'), at('3. STRUCTURE (the lp-quarterly-letter skill'), at("4. VOICE (the fund's own"), at('5. GUIDANCE FOR THIS LETTER'), at('<data label="letter-brief"')]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(sent).toContain('Open with three themes.')
    expect(sent).toContain('general outline')
    // The fund's own voice replaces the general examples.
    expect(sent).not.toContain('EXAMPLES (invented')
  })

  it("keeps the draft's Missing information apart from the letter, and records how it was written", async () => {
    const out = await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3 }) as any
    const row = store.tables.lp_letters.find((l: any) => l.id === out.letter.id)!
    expect(row.full_draft).toBe('Fund AI letter.')
    expect(row.internal_notes).toBe('Missing information\n- Birch update.')
    expect(row).toMatchObject({ source: 'generated', generated_by: 'fund_ai', vehicle_id: 'v1' })
    expect(row.skill_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(out.letter).toMatchObject({ source: 'generated', generated_by: 'fund_ai' })
    expect(((await H.lp_letter(ctx(), { letter_id: out.letter.id })) as any).internal_notes).toBe('Missing information\n- Birch update.')

    const mine = await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, text: 'By hand.\n\nMissing information\n- x' }) as any
    expect(store.tables.lp_letters.find((l: any) => l.id === mine.letter.id)).toMatchObject({ generated_by: 'assistant', full_draft: 'By hand.' })

    await H.lp_write_letter(ctx(), { letter_id: 'l1', full_draft: 'Edited.\n\nMissing information\n- y' })
    expect(store.tables.lp_letters.find((l: any) => l.id === 'l1')).toMatchObject({ full_draft: 'Edited.', internal_notes: 'Missing information\n- y' })
  })

  it("serves the skill with the fund's own voice, or the general one", async () => {
    const tool = getTool('lp_letter_skill')!
    expect(tool).toMatchObject({ scope: 'read', accessDomain: 'lp_relations', accessFeature: 'lp_letters' })
    const own = await H.lp_letter_skill(ctx(), {}) as any
    expect(own.files['SKILL.md']).toMatch(/^---\nname: lp-quarterly-letter/)
    expect(own.files['references/voice.md']).toBe('Open with three themes.')
    expect(own.files['references/examples.md']).toBeUndefined()
    expect(own.voice).toMatchObject({ source: 'fund', template: 'House style' })
    store.tables.lp_letter_templates = []
    const general = await H.lp_letter_skill(ctx(), {}) as any
    expect(general.voice.source).toBe('default')
    expect(general.files['references/voice.md']).toMatch(/^# Voice/)
    expect(general.files['references/examples.md']).toMatch(/^# Examples/)
    const brief = await H.lp_letter_brief(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3 }) as any
    expect(brief.instructions).toContain('Read it with lp_letter_skill')
    expect(brief.skill).toMatchObject({ name: 'lp-quarterly-letter', voice: 'default' })
  })

  it("writes in the fund's own structure, examples and house rules, in their layers", async () => {
    Object.assign(store.tables.lp_letter_templates[0], {
      structure: '## Sections\nOpening, then one section per company.', examples: '## New investments\nWe led Zephyr Labs.', house_rules: 'Give ARR to one decimal.',
    })
    await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, guidance: 'Lead with Acme.' })
    const sent = (createMessage.mock.calls.at(-1) as any[])[0].content as string
    const at = (t: string) => { const i = sent.indexOf(t); expect(i, t).toBeGreaterThan(-1); return i }
    const order = [at('3. STRUCTURE'), at("THE FUND'S OWN STRUCTURE"), at('Opening, then one section per company.'), at("4. VOICE (the fund's own"), at('We led Zephyr Labs.'), at('5. HOUSE RULES'), at('Give ARR to one decimal.'), at('6. GUIDANCE FOR THIS LETTER')]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const skill = await H.lp_letter_skill(ctx(), {}) as any
    expect(skill.files['references/examples.md']).toBe('## New investments\nWe led Zephyr Labs.')
    expect(skill.files['references/house-rules.md']).toBe('Give ARR to one decimal.')
    expect(skill.files['references/structure.md']).toBe('## Sections\nOpening, then one section per company.')
    const brief = await H.lp_letter_brief(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3 }) as any
    expect(brief.instructions).toContain('HOUSE RULES')
    expect(brief.instructions).toContain('Give ARR to one decimal.')
  })

  it('uses the template and guidance asked for, and refuses a template that does not exist', async () => {
    const out = await H.lp_draft_letter(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, template: 'short', guidance: 'Lead with Acme.', text: 'x\nMissing information' }) as any
    expect(out.template).toBe('Short')
    const row = store.tables.lp_letters.find((l: any) => l.id === out.letter.id)!
    expect(row).toMatchObject({ template_id: 't2', generation_prompt: 'Lead with Acme.' })
    await expect(H.lp_letter_brief(ctx(), { vehicle: 'Fund I', year: 2026, quarter: 3, template: 'Nope' })).rejects.toThrow('No letter template "Nope"')
  })

  it('reviews any full draft written from chat against the letter\'s sources', async () => {
    const out = await H.lp_write_letter(ctx(), { letter_id: 'l1', full_draft: 'Our IRR is 40%.\nMissing information' }) as any
    expect(out.review_flags).toEqual(expect.arrayContaining(['"40%" does not appear in the sources.']))
    expect(((await H.lp_write_letter(ctx(), { letter_id: 'l1', mark_final: true })) as any).review_flags).toBeUndefined()
  })

  it('marks a letter final, the only kind that can be shared; unsharing a draft is allowed', async () => {
    await expect(H.lp_share_letter(ctx(), { letter_id: 'l1', investors: ['Acme'] })).rejects.toThrow('Mark the letter final')
    expect(store.tables.lp_letter_shares).toEqual([])
    const out = await H.lp_write_letter(ctx(), { letter_id: 'l1', mark_final: true }) as any
    expect(out.letter.status).toBe('final')
    // The name the code used before, which the table never allowed, means final.
    await H.lp_write_letter(ctx(), { letter_id: 'l2', mark_complete: true })
    expect(store.tables.lp_letters.find((l: any) => l.id === 'l2')!.status).toBe('final')
    expect(((await H.lp_share_letter(ctx(), { letter_id: 'l1', investors: ['Acme'] })) as any).shared_with).toEqual(['Acme'])
    store.tables.lp_letters.find((l: any) => l.id === 'l1')!.status = 'draft'
    expect(((await H.lp_share_letter(ctx(), { letter_id: 'l1', investors: [] })) as any).shared_with).toEqual([])
  })

  it('shares with investors by name, replacing the list', async () => {
    store.tables.lp_letters.find((l: any) => l.id === 'l1')!.status = 'final'
    const out = await H.lp_share_letter(ctx(), { letter_id: 'l1', investors: ['Acme', 'birch'] }) as any
    expect(out.shared_with).toEqual(['Acme', 'Birch Family'])
    await H.lp_share_letter(ctx(), { letter_id: 'l1', investors: ['Acme'] })
    expect(store.tables.lp_letter_shares.map((s: any) => s.lp_investor_id)).toEqual(['inv-1'])
  })
})

describe('the letter PDF link', () => {
  const open = (token: string) => GET(new NextRequest(`https://fund.test/api/agent/reports/${token}`), { params: Promise.resolve({ token }) })
  const tokenOf = (url: string) => url.split('/').pop()!

  it('opens for a member who can still read letters and see the entity', async () => {
    const { url } = await H.lp_letter_pdf(ctx(), { letter_id: 'l1' }) as any
    const res = await open(tokenOf(url))
    expect(res.status).toBe(200)
    expect(letterPdf).toHaveBeenCalledWith(store.admin, { fundId: 'fund-1', letterId: 'l1' })
  })

  it('opens nothing once the grant, the switch or the entity is gone', async () => {
    const { url } = await H.lp_letter_pdf(ctx(), { letter_id: 'l1' }) as any
    access = member({})
    expect((await open(tokenOf(url))).status).toBe(404)
    access = { ...member({ lp_relations: 'read' }), features: { ...member({}).features, lp_letters: 'off' } }
    expect((await open(tokenOf(url))).status).toBe(404)
    const other = await H.lp_letter_pdf(ctx(), { letter_id: 'l2' }) as any
    access = member({ lp_relations: 'read' }, false)
    expect((await open(tokenOf(other.url))).status).toBe(404)
    expect(letterPdf).not.toHaveBeenCalled()
  })
})
