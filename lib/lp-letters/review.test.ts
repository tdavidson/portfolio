import { describe, expect, it } from 'vitest'
import { reviewLetter } from './review'
import { parseLetterText } from './content'
import type { BriefCompany, LetterBrief } from './brief'

const company = (id: string, name: string, events: string[] = []): BriefCompany => ({
  company_id: id, company: name, status: 'active', stage: 'Seed', figures: [{ label: 'Gross MOIC', value: '2.0x', basis: 'gross' }],
  events, updates_this_quarter: [], kpis_this_quarter: [], team_notes: [], stored_business_update: null,
})
const brief = {
  fund: 'Example Fund I', period: 'Q3 2026', as_of: '2026-10-01', instructions: '', skill: {}, basis_notes: [], excluded: '',
  fund_figures: [{ label: 'Net TVPI', value: '1.5x', basis: 'net' }],
  companies: [company('c1', 'Acme Robotics'), company('c2', 'Birch Analytics', ['Written off in Q3 2026']), company('c3', 'Cedar Labs', ['Down round in Q3 2026'])],
  missing_information: ['No update from Acme Robotics this quarter.'],
} as unknown as LetterBrief
const companies = brief.companies.map(c => ({ id: c.company_id, name: c.company }))

describe('reviewLetter', () => {
  it('ties each flag to the section it is about', () => {
    const content = parseLetterText(
      '## Fund performance\nOur net TVPI is 1.5x. Our IRR is 40%.\n\n## Acme Robotics\nAcme is at 2.0x gross. Jane Doe LP joined.\n\n## Birch Analytics\nBirch had a hard quarter.',
      { companies },
    )
    const flags = reviewLetter(content, brief, ['Jane Doe LP'], null)
    const at = (id: string | null) => flags.filter(f => f.section_id === id).map(f => f.kind)
    expect(at(null)).toEqual(expect.arrayContaining(['missing_information', 'unstated_event']))
    expect(at('fund-performance')).toEqual(expect.arrayContaining(['unsupported_number', 'unlabeled_performance']))
    expect(flags.find(f => f.kind === 'unsupported_number')?.quote).toBe('40%')
    expect(at('company:c1')).toEqual(['investor_named'])
    expect(at('company:c2')).toEqual(['unstated_event'])
    // Cedar has no section: its down round is a flag on the letter.
    expect(flags.some(f => f.section_id === null && /Cedar Labs had a down round/.test(f.message))).toBe(true)
  })

  it('has no missing-information flag once the letter keeps its notes, and none for a clean section', () => {
    const content = parseLetterText('## Acme Robotics\nAcme is at 2.0x gross.', { companies: companies.slice(0, 1) })
    const flags = reviewLetter(content, { ...brief, companies: brief.companies.slice(0, 1) }, [], '- No update from Acme.')
    expect(flags).toEqual([])
  })
})

import { avoidTerms, badDates, sharedRun } from './review'

describe('the newer checks', () => {
  it('finds dates that cannot exist or are in the future, and impossible quarters', () => {
    const found = badDates('On February 30, 2026 we closed. On 3 March 2026 we met. Due 2027-01-15. In Q5 2026.', '2026-11-06')
    expect(found.map(f => f.raw)).toEqual(['February 30, 2026', '2027-01-15', 'Q5 2026'])
    expect(found[0].message).toMatch(/not a real date/)
    expect(found[1].message).toMatch(/future/)
  })

  it("reads the words to avoid from the fund's house rules", () => {
    expect(avoidTerms('- Keep it short.\n- Avoid: synergy, "best-in-class"; rockstar\nNever use the words: crushing it.')).toEqual(['synergy', 'best-in-class', 'rockstar', 'crushing it'])
    expect(avoidTerms(null)).toEqual([])
  })

  it('finds a run of words lifted from a source, ignoring case and punctuation', () => {
    expect(sharedRun('As noted, Delta Signed its first two enterprise customers and is hiring now.', 'Delta signed its first two enterprise customers and is hiring a sales lead.', 8))
      .toBe('delta signed its first two enterprise customers and')
    expect(sharedRun('Delta grew.', 'Delta signed its first two enterprise customers.', 8)).toBeNull()
  })

  it('flags avoided terms, stale copying and confidential quotes on their sections', () => {
    const delta = {
      ...company('c9', 'Delta'),
      stored_business_update: 'Delta signed its first two enterprise customers and is hiring a sales lead for the east coast.',
      stored_business_update_at: '2026-03-02', stored_business_update_stale: true,
      updates_this_quarter: [{ received: '2026-10-02', subject: 'Board pack', period: null, text: 'The term sheet was signed at a higher price than the last round.', confidential: true }],
    }
    const b = { ...brief, companies: [delta], missing_information: [] } as LetterBrief
    const content = parseLetterText(
      '## Delta\nDelta signed its first two enterprise customers and is hiring a sales lead for the east coast. ' +
        'The term sheet was signed at a higher price than the last round. Real synergy.',
      { companies: [{ id: 'c9', name: 'Delta' }] },
    )
    const kinds = reviewLetter(content, b, [], null, { avoid: ['synergy'], today: '2026-11-06' }).map(f => [f.section_id, f.kind])
    expect(kinds).toEqual(expect.arrayContaining([['company:c9', 'stale_copy'], ['company:c9', 'confidential_quoted'], ['company:c9', 'avoided_term']]))
  })
})

import { cleanProfile } from './profile'

describe('the checks that read the profile and the last letter', () => {
  const profile = cleanProfile({
    signatories: [{ name: 'Jane Doe LP' }],
    company_names: [{ company_id: 'c1', display_name: 'Acme Robotics', former_names: ['Apex'] }],
    fixed_text: [{ heading: 'About the fund', text: 'x' }],
  })
  const last = 'Example Fund I invests in early stage robotics and analytics companies across North America and has done so since its first close in the spring of that year with a focus on seed rounds'
  const b = { ...brief, companies: [company('c1', 'Acme Robotics')], missing_information: [], last_final_letter: { period: 'Q2 2026', text: last } } as LetterBrief
  const content = parseLetterText([
    '## Acme Robotics', 'Apex grew. Zephyr Labs also did well.',
    '## About the fund', last,
    '## Outlook', 'Zephyr Labs raised a large round. ' + last,
    '## Closing', 'Sincerely, Jane Doe LP',
  ].join('\n'), { companies: [{ id: 'c1', name: 'Acme Robotics' }] })
  const flags = reviewLetter(content, b, ['Jane Doe LP'], 'notes', { profile, otherCompanies: ['Zephyr Labs', 'Acme Robotics'], today: '2026-11-06' })
  const at = (kind: string) => flags.filter(f => f.kind === kind).map(f => f.section_id)

  it('flags a former name used alone, and a company another entity holds outside the market sections', () => {
    expect(at('former_name')).toEqual(['company:c1'])
    expect(at('other_entity_company')).toEqual(['company:c1'])
  })

  it("flags last letter's words outside the fixed paragraphs", () => {
    expect(at('copied_from_last_letter')).toEqual(['outlook'])
  })

  it('lets a signatory who is also an investor sign the last section', () => {
    expect(at('investor_named')).toEqual([])
  })
})
