import { describe, expect, it, vi } from 'vitest'
import { authenticationRejection, fetchInboundEmail, matchInboundDomain } from './inbound'
import { normalizeResendEmail, toPostmarkPayload } from '@/lib/pipeline/normalizePayload'

describe('matchInboundDomain', () => {
  const funds = [
    { fund_id: 'a', resend_inbound_domain: 'inbound.laconia.example' },
    { fund_id: 'b', resend_inbound_domain: 'Inbound.3SE.example ' },
  ]

  it('matches a recipient on a fund domain, ignoring case and display names', () => {
    const m = matchInboundDomain(['Receipts <Receipts@INBOUND.3se.example>'], funds)
    expect(m?.settings.fund_id).toBe('b')
    expect(m?.recipient).toBe('receipts@inbound.3se.example')
  })

  it('looks past recipients on other domains (a Cc to a person, then the fund address)', () => {
    const m = matchInboundDomain(['gp@laconia.example', 'updates@inbound.laconia.example'], funds)
    expect(m?.settings.fund_id).toBe('a')
  })

  it('does not match a parent domain or a lookalike', () => {
    expect(matchInboundDomain(['x@laconia.example', 'x@evilinbound.laconia.example'], funds)).toBeNull()
  })
})

describe('authenticationRejection', () => {
  it('refuses a DMARC fail', () => {
    expect(authenticationRejection({ spf: 'fail', dkim: 'fail', dmarc: 'fail' })).toMatch(/DMARC failed/)
  })

  it('accepts pass, gray, missing results, and mail from before the field existed', () => {
    expect(authenticationRejection({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })).toBeNull()
    expect(authenticationRejection({ spf: 'gray', dkim: 'unknown', dmarc: 'gray' })).toBeNull()
    expect(authenticationRejection({})).toBeNull()
    expect(authenticationRejection(null)).toBeNull()
  })
})

describe('fetchInboundEmail', () => {
  const email = {
    object: 'email', id: 'em_1', to: ['r@inbound.x.example'], from: 'Ada <ada@co.example>', created_at: '2026-10-16T00:00:00Z',
    subject: 'Q3 update', bcc: null, cc: null, reply_to: null, received_for: [], html: '<p>Hi</p>', text: 'Hi',
    headers: { Date: 'Wed, 15 Oct 2026 10:00:00 +0000' }, message_id: '<m1@co.example>',
    attachments: [{ id: 'at_1', filename: 'q3.pdf', size: 3, content_type: 'application/pdf', content_id: null, content_disposition: 'attachment' }],
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  }

  it('reads the email, pages through attachments and downloads each one', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ data: { object: 'list', has_more: true, data: [{ id: 'at_1', filename: 'q3.pdf', content_type: 'application/pdf', download_url: 'https://dl/1' }] }, error: null })
      .mockResolvedValueOnce({ data: { object: 'list', has_more: false, data: [{ id: 'at_2', content_type: 'text/csv', download_url: 'https://dl/2' }] }, error: null })
    const receiving = { get: vi.fn().mockResolvedValue({ data: email, error: null }), attachments: { list } }
    const fetchImpl = vi.fn(async (url: string) => new Response(url === 'https://dl/1' ? 'pdf' : 'a,b'))

    const out = await fetchInboundEmail(receiving as any, 'em_1', fetchImpl as any)

    expect(list).toHaveBeenNthCalledWith(2, { emailId: 'em_1', limit: 100, after: 'at_1' })
    expect(out.email.authentication).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
    expect(out.attachments.map(a => [a.filename, a.contentType, a.content.toString()])).toEqual([
      ['q3.pdf', 'application/pdf', 'pdf'],
      ['attachment', 'text/csv', 'a,b'],
    ])
  })

  it('throws when Resend returns an error, so the webhook is retried', async () => {
    const receiving = { get: vi.fn().mockResolvedValue({ data: null, error: { message: 'rate limited' } }), attachments: { list: vi.fn() } }
    await expect(fetchInboundEmail(receiving as any, 'em_1')).rejects.toThrow('rate limited')
  })

  it('throws when an attachment download fails', async () => {
    const receiving = {
      get: vi.fn().mockResolvedValue({ data: email, error: null }),
      attachments: { list: vi.fn().mockResolvedValue({ data: { object: 'list', has_more: false, data: [{ id: 'at_1', content_type: 'application/pdf', download_url: 'https://dl/1' }] }, error: null }) },
    }
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 403 }))
    await expect(fetchInboundEmail(receiving as any, 'em_1', fetchImpl as any)).rejects.toThrow('403')
  })

  it('normalizes into the payload the pipeline reads', async () => {
    const receiving = { get: vi.fn().mockResolvedValue({ data: { ...email, attachments: [] }, error: null }), attachments: { list: vi.fn() } }
    const { email: fetched } = await fetchInboundEmail(receiving as any, 'em_1')
    const payload = toPostmarkPayload(normalizeResendEmail(fetched, 'r@inbound.x.example', [
      { filename: 'q3.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') },
    ]))
    expect(payload).toMatchObject({
      From: 'ada@co.example',
      FromFull: { Email: 'ada@co.example', Name: 'Ada' },
      To: 'r@inbound.x.example',
      OriginalRecipient: 'r@inbound.x.example',
      Date: 'Wed, 15 Oct 2026 10:00:00 +0000',
      Subject: 'Q3 update',
      TextBody: 'Hi',
      HtmlBody: '<p>Hi</p>',
      MessageID: '<m1@co.example>',
      Attachments: [{ Name: 'q3.pdf', ContentType: 'application/pdf', Content: Buffer.from('pdf').toString('base64'), ContentLength: 3 }],
    })
  })
})
