import { describe, it, expect } from 'vitest'
import { postmarkSenderVerified, resendSenderVerified } from './sender-auth'
import { authenticationRejection, matchInboundDomain } from '@/lib/resend/inbound'

const h = (Name: string, Value: string) => ({ Name, Value })

describe('postmarkSenderVerified — a member treatment needs more than a From header', () => {
  it('accepts DMARC pass, or a DKIM or SPF pass aligned with the From domain, in the topmost results', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.example; dmarc=pass header.from=fund.example')])).toBe(true)
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.example; dkim=pass header.d=fund.example')])).toBe(true)
    expect(postmarkSenderVerified('gp@mail.fund.example', [h('Authentication-Results', 'mx.example; spf=pass smtp.mailfrom=bounce@fund.example')])).toBe(true)
  })

  it('refuses a pass for some other domain, a lower header the sender wrote, and no headers at all', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.example; dkim=pass header.d=attacker.example')])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Authentication-Results', 'mx.example; dkim=none; spf=softfail smtp.mailfrom=attacker.example'),
      h('Authentication-Results', 'forged; dmarc=pass'),
    ])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', undefined)).toBe(false)
  })

  it('falls back to an aligned Received-SPF pass', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Pass (sender SPF authorized) identity=mailfrom; envelope-from="gp@fund.example"; receiver=x')])).toBe(true)
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Pass identity=mailfrom; envelope-from="x@attacker.example"')])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Softfail identity=mailfrom; envelope-from="gp@fund.example"')])).toBe(false)
  })
})

describe('Resend', () => {
  it('a member treatment needs DMARC pass', () => {
    expect(resendSenderVerified({ dmarc: 'pass', spf: 'pass', dkim: 'pass' })).toBe(true)
    expect(resendSenderVerified({ dmarc: 'gray', spf: 'pass', dkim: 'pass' })).toBe(false)
    expect(resendSenderVerified(null)).toBe(false)
  })

  it('refuses mail that passed neither SPF nor DKIM, as well as a DMARC fail', () => {
    expect(authenticationRejection({ dmarc: 'gray', spf: 'gray', dkim: 'unknown' })).toMatch(/neither SPF nor DKIM/)
    expect(authenticationRejection({ dmarc: 'fail', spf: 'pass', dkim: 'fail' })).toMatch(/DMARC failed/)
    expect(authenticationRejection({ dmarc: 'gray', spf: 'pass', dkim: 'gray' })).toBeNull()
  })

  it('delivers to neither fund when two claim one inbound domain', () => {
    const settings = [{ fund_id: 'a', resend_inbound_domain: 'in.fund.example' }, { fund_id: 'b', resend_inbound_domain: 'IN.fund.example ' }]
    expect(matchInboundDomain(['x@in.fund.example'], settings)).toBeNull()
    expect(matchInboundDomain(['x@in.fund.example'], settings.slice(0, 1))?.settings.fund_id).toBe('a')
  })
})
