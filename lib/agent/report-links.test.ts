import { beforeAll, describe, expect, it } from 'vitest'
import { REPORT_LINK_TTL_SECONDS, reportLinkUrl, signReportLink, verifyReportLink } from './report-links'

beforeAll(() => { process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links' })

const claims = { fundId: 'fund-1', userId: 'user-me', kind: 'lp_report_card' as const, args: { investor: 'inv-1' } }

describe('report links', () => {
  it('round-trips the claims until it expires, and not after', () => {
    const now = Date.UTC(2026, 9, 9, 12)
    const { token, expiresAt } = signReportLink(claims, now)
    expect(verifyReportLink(token, now)).toMatchObject(claims)
    expect(expiresAt).toBe(new Date(now + REPORT_LINK_TTL_SECONDS * 1000).toISOString())
    expect(verifyReportLink(token, now + REPORT_LINK_TTL_SECONDS * 1000)).toBeNull()
  })

  it('refuses a token whose claims were edited — another investor, another member', () => {
    const { token } = signReportLink(claims)
    const [, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, args: { investor: 'inv-2' }, exp: 9e9 })).toString('base64url')
    expect(verifyReportLink(`${forged}.${sig}`)).toBeNull()
    expect(verifyReportLink(`${token}x`)).toBeNull()
    expect(verifyReportLink('garbage')).toBeNull()
  })

  it('is void under another deployment\'s key', () => {
    const { token } = signReportLink(claims)
    const saved = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'someone-else'
    try { expect(verifyReportLink(token)).toBeNull() } finally { process.env.ENCRYPTION_KEY = saved }
  })

  it('builds the URL on the origin the caller reached', () => {
    expect(reportLinkUrl('https://fund.test/', 'abc.def')).toBe('https://fund.test/api/agent/reports/abc.def')
  })
})
