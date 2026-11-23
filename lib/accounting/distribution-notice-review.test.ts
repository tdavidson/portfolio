import { describe, it, expect, beforeAll } from 'vitest'
import { distributionNoticeFingerprint, normalizeNoticeEmail } from './distribution-notice-review'
import { signNoticePublish, verifyNoticePublish } from '@/lib/agent/notice-publish-link'

beforeAll(() => { process.env.ENCRYPTION_KEY ??= 'a'.repeat(64) })

const lines = [
  { id: 'l1', lpEntityId: 'gp', amount: 40_000, noticeDocumentId: null, parts: [
    { lineId: 'l1', role: 'lp' as const, amount: 20_000, returnOfCapital: 15_000, preferred: 0, profit: 5_000 },
    { lineId: 'l2', role: 'carry' as const, amount: 20_000, returnOfCapital: null, preferred: null, profit: null },
  ] },
  { id: 'l3', lpEntityId: 'a', amount: 60_000, noticeDocumentId: null },
]
const base = { distributionId: 'd1', date: '2026-06-30', description: 'Exit proceeds', lines, email: null, recipients: [{ lpEntityId: 'a', to: 'ops@lp.example', cc: [] }] }

describe('distributionNoticeFingerprint', () => {
  it('is stable for the same notices, in any line order', () => {
    expect(distributionNoticeFingerprint(base)).toBe(distributionNoticeFingerprint({ ...base, lines: [...lines].reverse() }))
  })
  it('changes with a figure, a part, or the email', () => {
    const fp = distributionNoticeFingerprint(base)
    expect(distributionNoticeFingerprint({ ...base, lines: [{ ...lines[0], amount: 40_001 }, lines[1]] })).not.toBe(fp)
    expect(distributionNoticeFingerprint({ ...base, lines: [{ ...lines[0], parts: [lines[0].parts![0]] }, lines[1]] })).not.toBe(fp)
    expect(distributionNoticeFingerprint({ ...base, email: { delivery: 'attachment' } })).not.toBe(fp)
  })
  it('changes with a recipient only when emailing', () => {
    const changed = { ...base, recipients: [{ lpEntityId: 'a', to: 'new@lp.example', cc: [] }] }
    expect(distributionNoticeFingerprint(changed)).toBe(distributionNoticeFingerprint(base))
    const email = { delivery: 'attachment' as const }
    expect(distributionNoticeFingerprint({ ...changed, email })).not.toBe(distributionNoticeFingerprint({ ...base, email }))
  })
})

describe('normalizeNoticeEmail', () => {
  it('defaults delivery to attachment and trims text', () => {
    expect(normalizeNoticeEmail(null)).toBeNull()
    expect(normalizeNoticeEmail({})).toEqual({ delivery: 'attachment', subject: null, message: null })
    expect(normalizeNoticeEmail({ delivery: 'link', subject: '  Hi ' })).toEqual({ delivery: 'link', subject: 'Hi', message: null })
  })
})

describe('the distribution notice publish token', () => {
  const req = { mode: 'staged_distribution' as const, fundId: 'f', userId: 'u', vehicle: 'Example Fund I', callId: 'd1', lpEntityIds: null, previewToken: 'tok', email: { delivery: 'attachment' as const } }
  it('round-trips, and refuses a bad delivery', () => {
    expect(verifyNoticePublish(signNoticePublish(req))).toMatchObject({ mode: 'staged_distribution', callId: 'd1', email: { delivery: 'attachment' } })
    expect(verifyNoticePublish(signNoticePublish({ ...req, email: { delivery: 'fax' as any } }))).toBeNull()
    expect(verifyNoticePublish(signNoticePublish({ ...req, previewToken: '' }))).toBeNull()
  })
})
