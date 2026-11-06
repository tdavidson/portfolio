import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The structured letter's routes: one generator for the whole letter, a section edited or
 * rewritten on its own (keeping what it was written from), and a review whose flags name sections.
 */

const store = memoryAdmin()
let scope: { vehicleNames: string[] | null } | null = { vehicleNames: null }

const acme = {
  company_id: 'c1', company: 'Acme Robotics', status: 'active', stage: 'Seed', figures: [{ label: 'Gross MOIC', value: '2.0x', basis: 'gross' }],
  events: [], updates_this_quarter: [], kpis_this_quarter: [], team_notes: [], stored_business_update: null,
}
const brief = {
  fund: 'Example Fund I', period: 'Q3 2026', as_of: '2026-10-01', instructions: '', skill: {}, basis_notes: [], excluded: '',
  fund_figures: [{ label: 'Net TVPI', value: '1.5x', basis: 'net' }], companies: [acme], missing_information: [],
}
const preview = {
  fundName: 'Example Fund I', fundCurrency: 'USD', periodLabel: 'Q3 2026', portfolioGroup: 'Fund I', fundMetrics: null,
  companies: [{ investment: { companyId: 'c1', companyName: 'Acme Robotics', status: 'active', stage: 'Seed', totalInvested: 100_000, totalRealized: 0, unrealizedValue: 200_000, fmv: 200_000, moic: 2 } }],
  totals: { totalInvested: 100_000, totalFmv: 200_000, totalRealized: 0, portfolioMoic: 2, activeCount: 1, exitedCount: 0, writtenOffCount: 0 },
}
const writeWithFundAI = vi.fn(async (..._a: unknown[]) => 'Dear partners.\n\n## Fund performance\nNet TVPI is 1.5x.\n\n## Acme Robotics\nAcme is at 2.0x gross.\n\n## Missing information\n- None.')
const rewriteSection = vi.fn(async (..._a: unknown[]) => 'Acme is at 2.0x gross, and grew.')

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'fund-1', userId: 'u1', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => scope }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/lp-letters/draft-from-brief', async orig => ({
  ...(await orig<any>()),
  templateForLetter: async () => ({ id: 't1', name: 'Default' }),
  loadLetterBrief: async () => ({ brief, preview, investorNames: [], template: { id: 't1', name: 'Default' }, voice: {} }),
  writeWithFundAI: (...a: unknown[]) => (writeWithFundAI as any)(...a),
  rewriteSection: (...a: unknown[]) => (rewriteSection as any)(...a),
}))

import { POST as generate } from '@/app/api/lp-letters/[id]/generate/route'
import { PATCH as editSection, POST as rewrite } from '@/app/api/lp-letters/[id]/sections/[sectionId]/route'
import { GET as review } from '@/app/api/lp-letters/[id]/review/route'

const req = (body?: unknown) => new NextRequest('http://localhost/x', { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
const p = (id: string) => ({ params: Promise.resolve({ id }) })
const ps = (id: string, sectionId: string) => ({ params: Promise.resolve({ id, sectionId: encodeURIComponent(sectionId) }) })
const row = (id = 'l1') => store.tables.lp_letters.find((l: any) => l.id === id)!

beforeEach(() => {
  scope = { vehicleNames: null }
  writeWithFundAI.mockClear(); rewriteSection.mockClear()
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'u1' }]
  store.tables.lp_letters = [
    { id: 'l1', fund_id: 'fund-1', portfolio_group: 'Fund I', period_year: 2026, period_quarter: 3, period_label: 'Q3 2026', is_year_end: false, status: 'draft', full_draft: null, company_prompts: null },
    { id: 'l2', fund_id: 'fund-1', portfolio_group: 'Fund II', period_year: 2026, period_quarter: 3, period_label: 'Q3 2026', is_year_end: false, status: 'draft', full_draft: 'Other.' },
  ]
})

describe('the structured letter routes', () => {
  it('generates the whole letter as sections with their sources, notes kept apart', async () => {
    const res = await generate(req(), p('l1'))
    expect(res.status).toBe(200)
    const l = row()
    expect(l.content.sections.map((s: any) => s.id)).toEqual(['opening', 'fund-performance', 'company:c1'])
    expect(l.content.sections[2].sources).toMatchObject({ company: { company_id: 'c1' }, as_of: '2026-10-01' })
    expect(l.full_draft).toBe('Dear partners.\n\nFund performance\n\nNet TVPI is 1.5x.\n\nAcme Robotics\n\nAcme is at 2.0x gross.')
    expect(l.internal_notes).toBe('Missing information\n- None.')
    expect(l.company_narratives).toEqual([expect.objectContaining({ company_id: 'c1', narrative: 'Acme is at 2.0x gross.' })])
    expect(l).toMatchObject({ status: 'draft', generated_by: 'fund_ai', generation_error: null })
  })

  it('puts the letter back to draft with an error when the AI fails, and refuses while generating', async () => {
    writeWithFundAI.mockRejectedValueOnce(new Error('down'))
    expect((await generate(req(), p('l1'))).status).toBe(500)
    expect(row()).toMatchObject({ status: 'draft', generation_error: expect.stringMatching(/failed/) })
    row().status = 'generating'
    expect((await generate(req(), p('l1'))).status).toBe(409)
  })

  it('edits one section in place and rewrites one with a kept prompt, keeping its sources', async () => {
    await generate(req(), p('l1'))
    const edited = (await editSection(req({ body: 'Acme grew.' }), ps('l1', 'company:c1')))!
    expect(edited.status).toBe(200)
    expect(row().content.sections[2]).toMatchObject({ body: 'Acme grew.', sources: { as_of: '2026-10-01' } })
    expect(row().full_draft).toMatch(/Acme Robotics\n\nAcme grew\.$/)

    const res = (await rewrite(req({ prompt: 'Mention growth.' }), ps('l1', 'company:c1')))!
    expect(res.status).toBe(200)
    expect(rewriteSection.mock.calls[0][5]).toBe('company:c1')
    expect(rewriteSection.mock.calls[0][7]).toBe('Mention growth.')
    expect(row().company_prompts).toEqual({ 'company:c1': { prompt: 'Mention growth.', mode: 'add' } })
    expect(row().content.sections[2]).toMatchObject({ body: 'Acme is at 2.0x gross, and grew.', sources: { as_of: '2026-10-01' } })
    expect(row().company_narratives[0].narrative).toBe('Acme is at 2.0x gross, and grew.')
  })

  it('refuses an unknown section, and a letter outside the caller\'s entities', async () => {
    await generate(req(), p('l1'))
    expect((await editSection(req({ body: 'x' }), ps('l1', 'nope')))!.status).toBe(404)
    expect((await rewrite(req({}), ps('l1', 'nope')))!.status).toBe(404)
    scope = { vehicleNames: ['Fund I'] }
    expect((await editSection(req({ body: 'x' }), ps('l2', 'opening')))!.status).toBe(404)
    expect(row('l2').full_draft).toBe('Other.')
  })

  it('reviews the letter with each flag naming its section', async () => {
    await generate(req(), p('l1'))
    await editSection(req({ body: 'Acme is at 9.9x.' }), ps('l1', 'company:c1'))
    const res = await review(new NextRequest('http://localhost/x'), p('l1'))
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.as_of).toBe('2026-10-01')
    expect(out.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ section_id: 'company:c1', kind: 'unsupported_number', quote: '9.9x' }),
    ]))
    expect(out.flags.every((f: any) => f.section_id === 'company:c1')).toBe(true)
  })
})
