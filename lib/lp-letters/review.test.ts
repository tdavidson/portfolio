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
