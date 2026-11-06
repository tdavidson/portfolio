import { describe, expect, it } from 'vitest'
import {
  COMMON_HEADINGS, attachSources, fromLetter, knownCompanies, narrativesOf, orderCompanies, parseLetterText, renderLetterText, reparse, replaceSection,
} from './content'
import type { BriefCompany, LetterBrief } from './brief'

const companies = [{ id: 'c1', name: 'Acme Robotics' }, { id: 'c2', name: 'Birch Analytics' }]

const company = (id: string, name: string): BriefCompany => ({
  company_id: id, company: name, status: 'active', stage: 'Seed', figures: [{ label: 'Gross MOIC', value: '2.0x', basis: 'gross' }],
  events: [], updates_this_quarter: [], kpis_this_quarter: [], team_notes: [], stored_business_update: null,
})
const brief = {
  as_of: '2026-10-01', fund_figures: [{ label: 'Net TVPI', value: '1.5x', basis: 'net' }], basis_notes: ['Marks are the latest.'],
  companies: [company('c1', 'Acme Robotics'), company('c2', 'Birch Analytics')],
} as unknown as LetterBrief

describe('parseLetterText', () => {
  it('splits marked text at its "## " lines, and knows a company by its name', () => {
    const c = parseLetterText('Dear partners,\n\nA good quarter.\n\n## Fund performance\nNet TVPI 1.5x.\n\n## Acme Robotics\nAcme grew.\n\n## Closing\nThanks.', { companies })
    expect(c.sections.map(s => [s.id, s.kind, s.heading])).toEqual([
      ['opening', 'text', null],
      ['fund-performance', 'fund', 'Fund performance'],
      ['company:c1', 'company', 'Acme Robotics'],
      ['closing', 'text', 'Closing'],
    ])
    expect(c.sections[2]).toMatchObject({ company_id: 'c1', body: 'Acme grew.' })
  })

  it('splits unmarked text at company names and the headings the letter already had', () => {
    const c = parseLetterText('Intro.\nAcme Robotics (formerly Apex)\nAcme grew.\nOutlook\nSteady.\nBirch Analytics\nBirch shipped.', {
      companies, headings: ['Outlook'],
    })
    expect(c.sections.map(s => s.id)).toEqual(['opening', 'company:c1', 'outlook', 'company:c2'])
  })

  it('splits unmarked text at usual section names, taglines and colons, and keeps a repeated name in its section', () => {
    const text = [
      'Dear partners,', '', 'Fund Performance Metrics', 'IRR, gross 18.30%.', '',
      'Acme Robotics: warehouse automation', 'Acme grew.', 'Acme Robotics: raised a Series A this quarter.', '',
      'Valuation updates:', 'Birch Analytics', 'Marked down.', '', 'Birch Analytics – data tools', 'Birch shipped.',
    ].join('\n')
    const c = parseLetterText(text, { companies, headings: COMMON_HEADINGS })
    expect(c.sections.map(s => s.id)).toEqual(['opening', 'fund-performance-metrics', 'company:c1', 'valuation-updates', 'company:c2'])
    expect(c.sections[2].body).toContain('raised a Series A')
    // The name in the valuation list is text there; its last line of its own opens Birch's section.
    expect(c.sections[3].body).toBe('Birch Analytics\nMarked down.')
    expect(c.sections[4].body).toBe('Birch shipped.')
  })

  it('does not split unmarked lines at a heading-like line once the text is marked', () => {
    const c = parseLetterText('## Acme Robotics\nBirch Analytics\nis a partner.', { companies })
    expect(c.sections).toHaveLength(1)
    expect(c.sections[0].body).toBe('Birch Analytics\nis a partner.')
  })

  it('gives repeated headings their own ids', () => {
    const c = parseLetterText('## Notes\na\n## Notes\nb')
    expect(c.sections.map(s => s.id)).toEqual(['notes', 'notes-2'])
  })
})

describe('sources and copies', () => {
  const parsed = parseLetterText('Hello.\n## Fund performance\nx\n## Acme Robotics\ny', { companies })
  const withSources = attachSources(parsed, brief)

  it("attaches each company's and the fund's sources from the brief", () => {
    expect(withSources.sections[0].sources).toBeUndefined()
    expect(withSources.sections[1].sources?.fund?.figures[0].value).toBe('1.5x')
    expect(withSources.sections[2].sources).toMatchObject({ company: { company: 'Acme Robotics' }, as_of: '2026-10-01' })
  })

  it('renders the text with headings on their own lines, and the narratives in the old shape', () => {
    expect(renderLetterText(withSources)).toBe('Hello.\n\nFund performance\n\nx\n\nAcme Robotics\n\ny')
    expect(narrativesOf(withSources, 'u1', 't')).toEqual([
      { company_id: 'c1', company_name: 'Acme Robotics', narrative: 'y', updated_by: 'u1', updated_at: 't' },
    ])
  })

  it('keeps the sources when the whole letter is written again as text', () => {
    const letter = { content: withSources }
    const again = reparse(letter, renderLetterText(withSources).replace('y', 'Acme grew a lot.'))
    expect(again.sections.find(s => s.id === 'company:c1')).toMatchObject({ body: 'Acme grew a lot.', sources: { as_of: '2026-10-01' } })
    expect(again.sections.find(s => s.id === 'fund-performance')?.sources?.fund).toBeTruthy()
  })

  it('replaces one section and refuses an unknown id', () => {
    const next = replaceSection(withSources, 'company:c1', { body: 'New.  \n' })
    expect(next.sections[2]).toMatchObject({ body: 'New.', sources: { as_of: '2026-10-01' } })
    expect(() => replaceSection(withSources, 'nope', { body: 'x' })).toThrow(/No section/)
  })
})

describe('reading a stored letter', () => {
  it('reads a letter saved before content existed from its text, adding sections kept only as narratives', () => {
    const letter = {
      full_draft: 'Dear partners.\n\nAcme Robotics\n\nAcme grew.\n\nMissing information\n- Birch update.',
      portfolio_summary: [{ company_id: 'c1', company_name: 'Acme Robotics' }],
      company_narratives: [{ company_id: 'c2', company_name: 'Birch Analytics', narrative: 'Birch shipped.' }],
    }
    expect(knownCompanies(letter).map(c => c.id).sort()).toEqual(['c1', 'c2'])
    const c = fromLetter(letter)
    expect(c.sections.map(s => s.id)).toEqual(['opening', 'company:c1', 'company:c2'])
    // The partners' notes are not part of the letter.
    expect(renderLetterText(c)).not.toMatch(/Missing information/)
  })

  it('puts company sections in portfolio order, in the places company sections hold', () => {
    const c = parseLetterText('## Intro\na\n## Birch Analytics\nb\n## Acme Robotics\nc\n## Closing\nd', { companies })
    expect(orderCompanies(c, ['c1', 'c2']).sections.map(s => s.id)).toEqual(['intro', 'company:c1', 'company:c2', 'closing'])
  })
})
