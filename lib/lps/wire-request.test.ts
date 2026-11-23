import { describe, it, expect } from 'vitest'
import { wireRequestBody } from './wire-request'

describe('wireRequestBody', () => {
  const r = { to: 'ops@lp.example', cc: [], entities: [{ id: 'a', name: 'Acme Capital LP', why: 'no bank details on file' }] }
  it('always carries the callback and no-email-changes warning', () => {
    for (const via of ['portal', 'contact'] as const) {
      const { text } = wireRequestBody('Example Fund I', { ...r, via }, 'Custom opening.')
      expect(text).toContain('Custom opening.')
      expect(text).toMatch(/calling a number we already hold/)
      expect(text).toMatch(/never ask you to change bank details by email/)
    }
  })
  it('points portal users to the portal and others to a signed letter', () => {
    expect(wireRequestBody('Example Fund I', { ...r, via: 'portal' }, null).text).toMatch(/investor portal/)
    expect(wireRequestBody('Example Fund I', { ...r, via: 'contact' }, null).text).toMatch(/signed letter/)
    expect(wireRequestBody('Example Fund I', { ...r, via: 'contact' }, null).facts).toEqual([{ label: 'Acme Capital LP', value: 'no bank details on file' }])
  })
})
