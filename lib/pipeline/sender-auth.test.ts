import { describe, it, expect } from 'vitest'
import { postmarkSenderVerified, resendSenderVerified, trustedAuthservIds } from './sender-auth'
import { authenticationRejection, matchInboundDomain } from '@/lib/resend/inbound'

const h = (Name: string, Value: string) => ({ Name, Value })

describe('postmarkSenderVerified — a member treatment needs more than a From header', () => {
  const trusted = ['mx.postmark.example']

  it('accepts DMARC pass, or a DKIM or SPF pass aligned with From, from a trusted authserv-id', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.postmark.example; dmarc=pass header.from=fund.example')], trusted)).toBe(true)
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.postmark.example; dkim=pass header.d=fund.example')], trusted)).toBe(true)
    expect(postmarkSenderVerified('gp@mail.fund.example', [h('Authentication-Results', 'mx.postmark.example 1; spf=pass smtp.mailfrom=bounce@fund.example')], trusted)).toBe(true)
  })

  it('ignores Authentication-Results from any server not trusted, so a sender cannot write their own pass', () => {
    // The spoof: a forged From and a hand-written header claiming DMARC passed.
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'spoof.example; dmarc=pass header.from=fund.example')], trusted)).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.postmark.example; dmarc=pass')], [])).toBe(false)
    // A forged header doesn't hide Postmark's own SPF result, either way.
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Received-SPF', 'Softfail identity=mailfrom; envelope-from="x@attacker.example"'),
      h('Authentication-Results', 'spoof.example; dmarc=pass'),
    ], trusted)).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Authentication-Results', 'spoof.example; dmarc=fail'),
      h('Received-SPF', 'Pass identity=mailfrom; envelope-from="gp@fund.example"'),
    ], trusted)).toBe(true)
  })

  it('refuses a pass for some other domain, and no headers at all', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Authentication-Results', 'mx.postmark.example; dkim=pass header.d=attacker.example')], trusted)).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [], trusted)).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', undefined, trusted)).toBe(false)
  })

  it('reads only the first Received-SPF, and needs an aligned pass', () => {
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Pass (sender SPF authorized) identity=mailfrom; envelope-from="gp@fund.example"; receiver=x')], [])).toBe(true)
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Pass identity=mailfrom; envelope-from="x@attacker.example"')], [])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [h('Received-SPF', 'Softfail identity=mailfrom; envelope-from="gp@fund.example"')], [])).toBe(false)
    expect(postmarkSenderVerified('gp@fund.example', [
      h('Received-SPF', 'Softfail identity=mailfrom; envelope-from="gp@fund.example"'),
      h('Received-SPF', 'Pass identity=mailfrom; envelope-from="gp@fund.example"'),
    ], [])).toBe(false)
  })

  it('reads the trusted ids from a comma-separated setting', () => {
    expect(trustedAuthservIds(' MX.Postmark.example, other.example ,')).toEqual(['mx.postmark.example', 'other.example'])
    expect(trustedAuthservIds(undefined)).toEqual([])
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
