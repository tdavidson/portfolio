import { describe, it, expect } from 'vitest'
import { contactChanges } from './records'

describe('contactChanges', () => {
  it('lists the notice and contact fields that changed, ignoring case and blank space', () => {
    expect(contactChanges(
      { notice_email: 'ops@lp.example', contact_email: 'jane@lp.example', contact_phone: '555-0100' },
      { notice_email: 'OPS@lp.example ', contact_email: 'new@other.example', contact_phone: '555-0100' },
    )).toEqual([{ field: 'contact_email', from: 'jane@lp.example', to: 'new@other.example' }])
  })
  it('counts a cleared or newly set field, and skips fields the update did not touch', () => {
    expect(contactChanges({ contact_phone: '555-0100', notice_email: 'a@lp.example' }, { contact_phone: '' })).toEqual([
      { field: 'contact_phone', from: '555-0100', to: null },
    ])
    expect(contactChanges({}, { notice_email: 'a@lp.example' })).toEqual([{ field: 'notice_email', from: null, to: 'a@lp.example' }])
  })
})
