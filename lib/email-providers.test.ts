// sendOutboundEmail's contract is "throws on failure". Callers (the ops-reminders cron above
// all) record a send as done when it returns, so a provider error that comes back as a value
// instead of a throw marks an unsent email as sent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const resendSend = vi.fn()
vi.mock('resend', () => ({
  Resend: class { emails = { send: resendSend } },
}))

const postmarkSend = vi.fn()
vi.mock('postmark', () => ({
  ServerClient: class { sendEmail = postmarkSend },
}))

// Gmail: stub credential plumbing; lib/google/gmail's real sendEmail runs against a stubbed fetch.
vi.mock('@/lib/crypto', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/google/credentials', () => ({ getGoogleCredentials: async () => ({ clientId: 'c', clientSecret: 's' }) }))
vi.mock('@/lib/google/drive', () => ({ getAccessToken: async () => 'token' }))

import { sendOutboundEmail } from './email'

const params = { to: 'gp@example.com', from: 'Fund <ops@example.com>', subject: 'Hi', html: '<p>Hi</p>' }

describe('sendOutboundEmail throws when the provider reports a failure', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ENCRYPTION_KEY = 'kek'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resendSend.mockReset(); postmarkSend.mockReset()
  })

  it('resend: returns the id on success', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null })
    await expect(sendOutboundEmail({ provider: 'resend', apiKey: 'k' }, params)).resolves.toEqual({ id: 're_1' })
  })

  it('resend: an { error } result (the SDK does not throw) becomes a throw', async () => {
    resendSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'The from address is not verified' } })
    await expect(sendOutboundEmail({ provider: 'resend', apiKey: 'k' }, params)).rejects.toThrow('The from address is not verified')
  })

  it('postmark: a rejected request throws', async () => {
    postmarkSend.mockRejectedValue(new Error('Postmark 422'))
    await expect(sendOutboundEmail({ provider: 'postmark', serverToken: 't' }, params)).rejects.toThrow('Postmark 422')
  })

  it('postmark: a non-zero ErrorCode in a resolved response throws', async () => {
    postmarkSend.mockResolvedValue({ ErrorCode: 406, Message: 'Inactive recipient', MessageID: '' })
    await expect(sendOutboundEmail({ provider: 'postmark', serverToken: 't' }, params)).rejects.toThrow('Inactive recipient')
  })

  it('postmark: returns the MessageID on success', async () => {
    postmarkSend.mockResolvedValue({ ErrorCode: 0, Message: 'OK', MessageID: 'pm_1' })
    await expect(sendOutboundEmail({ provider: 'postmark', serverToken: 't' }, params)).resolves.toEqual({ id: 'pm_1' })
  })


  it('gmail: a non-2xx response throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 401 })))
    const admin = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { google_refresh_token_encrypted: 'r', encryption_key_encrypted: 'e' } }) }) }) }),
    } as unknown as SupabaseClient
    await expect(sendOutboundEmail({ provider: 'gmail', admin, fundId: 'f' }, params)).rejects.toThrow(/Failed to send email/)
  })
})
