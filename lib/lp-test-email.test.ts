import { describe, it, expect } from 'vitest'
import { testSubject, withTestBanner } from './lp-test-email'
import { signNoticePublish, verifyNoticePublish } from './agent/notice-publish-link'

describe('test sends', () => {
  it('prefixes the subject once', () => {
    expect(testSubject('Example Fund I: Q3 statement')).toBe('[Test] Example Fund I: Q3 statement')
    expect(testSubject('[Test] Example Fund I: Q3 statement')).toBe('[Test] Example Fund I: Q3 statement')
  })

  it('puts the banner right after <body>, naming who the real email goes to', () => {
    const html = '<html><body style="x"><p>Hello</p></body></html>'
    const out = withTestBanner(html, { to: 'lp@acme.example', cc: ['ops@acme.example'], viaContact: true })
    expect(out.indexOf('Test send.')).toBeGreaterThan(out.indexOf('<body'))
    expect(out.indexOf('Test send.')).toBeLessThan(out.indexOf('<p>Hello'))
    expect(out).toContain('lp@acme.example (Cc ops@acme.example)')
    expect(out).toContain('no portal account')
  })

  it('escapes addresses and says when nobody would receive it', () => {
    expect(withTestBanner('<body></body>', { to: '<x>@a.example', cc: [], viaContact: false })).toContain('&lt;x&gt;@a.example')
    expect(withTestBanner('<body></body>', null)).toContain('No LP would receive this email yet.')
  })
})

describe('the notice test token', () => {
  const prev = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = prev ?? 'test-key-for-notice-links'
  const base = { fundId: 'f1', userId: 'u1', vehicle: 'Example Fund I', callId: 'c1' }

  it('round-trips a test_email claim', () => {
    const token = signNoticePublish({ ...base, mode: 'test_email', noticeKind: 'distribution', lpEntityIds: null, email: { delivery: 'attachment' } })
    expect(verifyNoticePublish(token)).toMatchObject({ mode: 'test_email', noticeKind: 'distribution', email: { delivery: 'attachment' } })
  })

  it('refuses one with no kind or no delivery', () => {
    expect(verifyNoticePublish(signNoticePublish({ ...base, mode: 'test_email', noticeKind: 'other', lpEntityIds: null, email: { delivery: 'attachment' } } as any))).toBeNull()
    expect(verifyNoticePublish(signNoticePublish({ ...base, mode: 'test_email', noticeKind: 'capital_call', lpEntityIds: null, email: null } as any))).toBeNull()
  })
})
