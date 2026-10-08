import { describe, it, expect } from 'vitest'
import { fromHeader, parseRecipients, scopedRecipients } from './settings'

describe('parseRecipients', () => {
  it('splits and trims a comma/semicolon list', () => {
    expect(parseRecipients('a@x.com, b@y.com; Ops <ops@z.com>')).toEqual({ value: ['a@x.com', 'b@y.com', 'Ops <ops@z.com>'] })
  })
  it('treats empty as "fall back to admins"', () => {
    expect(parseRecipients('  ')).toEqual({ value: [] })
    expect(parseRecipients(undefined)).toEqual({ value: [] })
  })
  it('reports the first invalid entry', () => {
    expect(parseRecipients('a@x.com, nope')).toEqual({ invalid: 'nope' })
  })
  it('caps the list', () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@x.com`).join(',')
    expect(parseRecipients(many)).toEqual({ invalid: 'more than 20 recipients' })
  })
})

describe('fromHeader', () => {
  it('uses the system from-name, else the fund name, around the system address', () => {
    expect(fromHeader({ name: 'Acme Ops', address: 'ops@acme.vc' }, 'Acme Fund I')).toBe('Acme Ops <ops@acme.vc>')
    expect(fromHeader({ name: null, address: 'ops@acme.vc' }, 'Acme Fund I')).toBe('Acme Fund I <ops@acme.vc>')
  })
  it('is the bare address when there is no name at all', () => {
    expect(fromHeader({ name: '', address: 'ops@acme.vc' }, null)).toBe('ops@acme.vc')
  })
  it('is undefined without a system address, so the provider default applies', () => {
    expect(fromHeader({ name: 'Acme Ops', address: null }, 'Acme Fund I')).toBeUndefined()
    expect(fromHeader({ name: null, address: '  ' }, 'Acme Fund I')).toBeUndefined()
  })
})


describe('scopedRecipients — reminder recipients who are not cleared for every entity', () => {
  const members = [
    { email: 'Ann@fund.com', unscoped: true },
    { email: 'bob@fund.com', unscoped: false },
  ]
  it('names members limited to some entities, case-insensitively; outsiders and unscoped members pass', () => {
    expect(scopedRecipients(['ann@fund.com', 'BOB@fund.com', 'admin@fundadmin.co'], members)).toEqual(['BOB@fund.com'])
  })
  it('an empty list (all admins) flags no one', () => {
    expect(scopedRecipients([], members)).toEqual([])
  })
})
