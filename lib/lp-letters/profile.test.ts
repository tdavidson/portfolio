import { describe, expect, it } from 'vitest'
import { cleanProfile, EMPTY_PROFILE, formerNamesUsed, mergeProfiles, profileAsLayer } from './profile'
import { parseSeededProfile } from './seed-profile'

describe('letter profiles', () => {
  const firm = cleanProfile({
    firm_name: 'Example Capital', signatories: [{ name: 'Jane Doe', title: 'Managing Partner' }],
    footnotes: 'Past performance is not a guide.', fixed_text: [{ heading: 'About us', text: 'Firm-wide paragraph.' }],
  })
  const own = cleanProfile({
    legal_name: 'Example Fund I, L.P.', short_name: 'Fund I', fund_stage: 'harvesting',
    company_names: [{ company_id: 'c1', display_name: 'Acme Robotics', former_names: ['Apex'], status: 'Wound Down' }],
    fixed_text: [{ heading: 'about us', text: 'This entity\'s own paragraph.' }],
    signatories: [], junk: 'dropped', fund_stage_bad: 1,
  })

  it('keeps known fields only, bounded, and drops bad values', () => {
    expect(cleanProfile({ fund_stage: 'winding', signatories: [{ title: 'No name' }], company_names: [{ display_name: 'No id' }] }))
      .toEqual(EMPTY_PROFILE)
    expect((own as any).junk).toBeUndefined()
  })

  it("puts the entity's own fields over the firm-wide ones", () => {
    const p = mergeProfiles(firm, own)
    expect(p).toMatchObject({ firm_name: 'Example Capital', legal_name: 'Example Fund I, L.P.', fund_stage: 'harvesting' })
    // No signatories of its own: the firm's sign.
    expect(p.signatories).toEqual([{ name: 'Jane Doe', title: 'Managing Partner' }])
    expect(p.fixed_text).toEqual([{ heading: 'about us', text: "This entity's own paragraph." }])
  })

  it('becomes a writer layer, and finds a former name used alone', () => {
    const layer = profileAsLayer(mergeProfiles(firm, own), id => (id === 'c1' ? 'Acme' : undefined))!
    expect(layer).toContain('Legal name: Example Fund I, L.P.')
    expect(layer).toContain('Signatories, in order: Jane Doe, Managing Partner')
    expect(layer).toContain('Company "Acme": call it "Acme Robotics"; formerly "Apex"; status: Wound Down')
    expect(profileAsLayer(EMPTY_PROFILE)).toBeNull()
    expect(formerNamesUsed('Apex shipped its robot.', own)).toEqual([{ former: 'Apex', display: 'Acme Robotics' }])
    expect(formerNamesUsed('Acme Robotics (formerly Apex) shipped.', own)).toEqual([])
  })

  it("reads a proposed profile out of a model's answer, dropping companies it doesn't know", () => {
    const text = 'Here it is:\n{"legal_name":"Example Fund I, L.P.","company_names":[{"company_id":"c1","display_name":"Acme Robotics"},{"company_id":"zz","display_name":"Ghost"}]}'
    const p = parseSeededProfile(text, ['c1'])!
    expect(p.legal_name).toBe('Example Fund I, L.P.')
    expect(p.company_names.map(c => c.company_id)).toEqual(['c1'])
    expect(parseSeededProfile('no json here', [])).toBeNull()
  })
})

describe('external ids', () => {
  it('keeps a system and id pair, drops half ones, and the entity\'s list wins over the firm\'s', () => {
    const own = cleanProfile({ external_ids: [{ system: 'Administrator', id: 'fund-123' }, { system: 'x' }, 'junk'] })
    expect(own.external_ids).toEqual([{ system: 'Administrator', id: 'fund-123' }])
    const firm = cleanProfile({ external_ids: [{ system: 'Administrator', id: 'firm-1' }] })
    expect(mergeProfiles(firm, own).external_ids).toEqual([{ system: 'Administrator', id: 'fund-123' }])
    expect(mergeProfiles(firm, cleanProfile({})).external_ids).toEqual([{ system: 'Administrator', id: 'firm-1' }])
    expect(profileAsLayer(own)).toContain('Id in Administrator: fund-123')
  })
})
