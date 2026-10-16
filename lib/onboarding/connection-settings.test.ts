import { describe, it, expect } from 'vitest'
import { parseConnectionUpdate } from './connection-settings'

const ok = async () => ({ ok: true as const })

describe('connection settings from chat', () => {
  it('maps fields to the columns the Settings page writes', async () => {
    const out = await parseConnectionUpdate({
      defaultAIProvider: 'openai', outboundEmailProvider: 'postmark', postmarkInboundAddress: ' abc@inbound.postmarkapp.com ',
      googleClientId: 'cid.apps.googleusercontent.com',
    }, ok)
    expect(out).toEqual({ updates: {
      default_ai_provider: 'openai', outbound_email_provider: 'postmark',
      postmark_inbound_address: 'abc@inbound.postmarkapp.com', google_client_id: 'cid.apps.googleusercontent.com',
    } })
  })

  it('clears a provider with an empty string, and restores a model default', async () => {
    expect(await parseConnectionUpdate({ inboundEmailProvider: '', claudeModel: '' }, ok))
      .toEqual({ updates: { inbound_email_provider: null, claude_model: 'claude-sonnet-4-6' } })
  })

  it('refuses secrets, naming where they go instead', async () => {
    const out = await parseConnectionUpdate({ claudeApiKey: 'sk-ant-123' }, ok)
    expect(out).toMatchObject({ error: expect.stringContaining('environment') })
    expect(JSON.stringify(out)).not.toContain('sk-ant-123')
  })

  it('checks providers, addresses and the OpenRouter URL as the route does', async () => {
    expect(await parseConnectionUpdate({ defaultAIProvider: 'gemini' }, ok)).toHaveProperty('error')
    expect(await parseConnectionUpdate({ outboundEmailProvider: 'sendgrid' }, ok)).toHaveProperty('error')
    expect(await parseConnectionUpdate({ systemEmailFromAddress: 'not-an-email' }, ok)).toHaveProperty('error')
    expect(await parseConnectionUpdate({ openrouterBaseUrl: 'http://10.0.0.1' }, async () => ({ ok: false as const, error: 'private address' })))
      .toEqual({ error: 'private address' })
    expect(await parseConnectionUpdate({}, ok)).toHaveProperty('error')
    expect(await parseConnectionUpdate({ colour: 'red' }, ok)).toHaveProperty('error')
  })
})
