import { createHmac } from 'crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { encrypt } from '@/lib/crypto'

/**
 * POST /api/inbound-email/resend, Resend's `email.received` webhook.
 *
 * Pinned here:
 * - nothing is fetched or stored unless the Svix signature checks out with the fund's secret;
 * - a sender who is neither a member nor authorized is dropped before the app calls Resend;
 * - a DMARC fail (a spoofed From) is dropped even though the From address is authorized;
 * - when Resend can't be read back the route answers 503 and stores nothing, so Resend retries;
 * - a good email reaches the pipeline with its body, recipient and attachment bytes.
 */

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(async () => undefined),
  checkFundMember: vi.fn(async () => null as { user_id: string } | null),
  isAuthorizedSender: vi.fn(async () => true),
  rateLimit: vi.fn(async () => null),
}))

vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: mocks.runPipeline }))
vi.mock('@/lib/pipeline/checkFundMember', () => ({ checkFundMember: mocks.checkFundMember }))
vi.mock('@/lib/pipeline/isAuthorizedSender', () => ({ isAuthorizedSender: mocks.isAuthorizedSender }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: async () => ({ safe: true }) }))
vi.mock('@/lib/rate-limit', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  rateLimit: mocks.rateLimit,
}))

type Row = Record<string, any>
let fundRows: Row[]
let inserts: Row[]
let uploads: string[]

function chain(table: string): any {
  let op: 'select' | 'insert' | 'update' = 'select'
  const q: any = {
    select: () => q,
    eq: () => q,
    not: () => q,
    insert: (v: Row) => { op = 'insert'; inserts.push({ table, ...v }); return q },
    update: () => { op = 'update'; return q },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: op === 'insert' ? { id: 'inb_1' } : null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: table === 'fund_settings' ? fundRows : null, error: null }),
  }
  return q
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: chain,
    storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null } } }) },
  }),
}))

import { POST } from '@/app/api/inbound-email/resend/route'

const previousKek = process.env.ENCRYPTION_KEY
const kek = '44'.repeat(32)
const dek = '55'.repeat(32)
const SECRET_BYTES = Buffer.from('a-test-signing-secret-32-bytes!!')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

const event = {
  type: 'email.received',
  created_at: '2026-10-16T00:00:00Z',
  data: {
    email_id: 'em_1', created_at: '2026-10-16T00:00:00Z', from: 'Ada <ada@co.example>',
    to: ['receipts@inbound.laconia.example'], bcc: [], cc: [], received_for: [], message_id: '<m1@co.example>',
    subject: 'Receipt', attachments: [{ id: 'at_1', filename: 'r.pdf', content_type: 'application/pdf' }],
  },
}

const receivedEmail = {
  object: 'email', id: 'em_1', to: ['receipts@inbound.laconia.example'], from: 'Ada <ada@co.example>',
  created_at: '2026-10-16T00:00:00Z', subject: 'Receipt', bcc: null, cc: null, reply_to: null, received_for: [],
  html: '<p>Attached</p>', text: 'Attached', headers: { date: 'Thu, 16 Oct 2026 00:00:00 +0000' }, message_id: '<m1@co.example>',
  attachments: [{ id: 'at_1', filename: 'r.pdf', size: 3, content_type: 'application/pdf', content_id: null, content_disposition: 'attachment' }],
  authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
}

function sign(body: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000).toString()) {
  const sig = createHmac('sha256', SECRET_BYTES).update(`${id}.${ts}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }
}

function request(body: string, headers: Record<string, string>) {
  return new NextRequest('https://app.example/api/inbound-email/resend', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

let resendApi: (url: string) => Response

beforeEach(() => {
  process.env.ENCRYPTION_KEY = kek
  fundRows = [{
    fund_id: 'fund_1',
    resend_inbound_domain: 'inbound.laconia.example',
    resend_webhook_secret_encrypted: encrypt(SECRET, dek),
    resend_api_key_encrypted: encrypt('re_test', dek),
    encryption_key_encrypted: encrypt(dek, kek),
  }]
  inserts = []
  uploads = []
  mocks.runPipeline.mockClear()
  mocks.checkFundMember.mockResolvedValue(null)
  mocks.isAuthorizedSender.mockResolvedValue(true)
  resendApi = url => {
    if (url.endsWith('/emails/receiving/em_1')) return Response.json(receivedEmail)
    if (url.includes('/emails/receiving/em_1/attachments')) {
      return Response.json({ object: 'list', has_more: false, data: [{ id: 'at_1', filename: 'r.pdf', size: 3, content_type: 'application/pdf', content_disposition: 'attachment', download_url: 'https://cdn.resend.example/at_1', expires_at: '' }] })
    }
    if (url === 'https://cdn.resend.example/at_1') return new Response('pdf')
    return new Response('not found', { status: 404 })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => resendApi(String(input instanceof Request ? input.url : input))))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(() => {
  process.env.ENCRYPTION_KEY = previousKek
  vi.unstubAllGlobals()
})

describe('POST /api/inbound-email/resend', () => {
  it('runs a signed email through the pipeline with its body and attachment', async () => {
    const body = JSON.stringify(event)
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(inserts).toEqual([expect.objectContaining({ table: 'inbound_emails', fund_id: 'fund_1', from_address: 'ada@co.example', subject: 'Receipt', attachments_count: 1 })])
    expect(uploads).toEqual(['inb_1/0_r.pdf'])
    expect(mocks.runPipeline).toHaveBeenCalledTimes(1)
    const payload = (mocks.runPipeline.mock.calls[0] as unknown[])[3] as Row
    expect(payload).toMatchObject({
      From: 'ada@co.example',
      To: 'receipts@inbound.laconia.example',
      TextBody: 'Attached',
      Attachments: [{ Name: 'r.pdf', Content: Buffer.from('pdf').toString('base64') }],
    })
  })

  it('stores nothing when the signature is wrong', async () => {
    const body = JSON.stringify(event)
    const res = await POST(request(body, sign(body.replace('Receipt', 'Tampered'))))

    expect(res.status).toBe(200)
    expect(fetch).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('drops an unauthorized sender before calling Resend', async () => {
    mocks.isAuthorizedSender.mockResolvedValue(false)
    const body = JSON.stringify(event)
    await POST(request(body, sign(body)))

    expect(fetch).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('drops mail whose From fails DMARC, even from an authorized address', async () => {
    const signed = resendApi
    resendApi = url => url.endsWith('/emails/receiving/em_1')
      ? Response.json({ ...receivedEmail, authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } })
      : signed(url)
    const body = JSON.stringify(event)
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(inserts).toEqual([])
    expect(mocks.runPipeline).not.toHaveBeenCalled()
  })

  it('answers 503 and stores nothing when Resend cannot be read, so Resend retries', async () => {
    resendApi = () => Response.json({ name: 'internal_server_error', message: 'boom', statusCode: 500 }, { status: 500 })
    const body = JSON.stringify(event)
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(503)
    expect(inserts).toEqual([])
  })

  it('ignores mail for a domain no fund receives on', async () => {
    const other = { ...event, data: { ...event.data, to: ['x@elsewhere.example'] } }
    const body = JSON.stringify(other)
    const res = await POST(request(body, sign(body)))

    expect(res.status).toBe(200)
    expect(fetch).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })
})
