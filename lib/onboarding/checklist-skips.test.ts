import { describe, it, expect } from 'vitest'
import { applySkipChange, parseSkipChange } from './checklist-skips'
import { parseOnboardingRecord } from './wizard'

describe('parseSkipChange', () => {
  it('accepts skip and unskip lists of known steps', () => {
    expect(parseSkipChange({ skip: ['forecast', 'forecast'], unskip: ['senders'] })).toEqual({ skip: ['forecast'], unskip: ['senders'] })
    expect(parseSkipChange({ skip: ['lps'] })).toEqual({ skip: ['lps'], unskip: [] })
  })

  it('refuses unknown keys, empty changes and contradictions', () => {
    expect(parseSkipChange({ skip: ['not_a_step'] })).toHaveProperty('error')
    expect(parseSkipChange({ skip: 'forecast' })).toHaveProperty('error')
    expect(parseSkipChange({})).toHaveProperty('error')
    expect(parseSkipChange(null)).toHaveProperty('error')
    expect(parseSkipChange({ skip: ['forecast'], unskip: ['forecast'] })).toHaveProperty('error')
  })
})

describe('applySkipChange', () => {
  it('adds and removes', () => {
    expect(applySkipChange(['forecast', 'lps'], { skip: ['senders'], unskip: ['lps'] }).sort()).toEqual(['forecast', 'senders'])
  })
})

describe('onboarding record', () => {
  it('keeps checklist skips when the wizard re-reads and re-writes the record', () => {
    const rec = parseOnboardingRecord({ products: [], checklist_skipped: ['forecast', 'bogus'], completed_at: '2026-01-01' })
    expect(rec?.checklist_skipped).toEqual(['forecast'])
  })
})
