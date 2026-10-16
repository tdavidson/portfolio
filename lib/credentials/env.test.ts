import { describe, it, expect } from 'vitest'
import { credentialSources, envCredential, hasAnyAIKeyFrom, hasCredential, ENV_CREDENTIALS } from './env'

describe('credentials from the environment', () => {
  it('reads a variable, trimmed, and treats blank as unset', () => {
    expect(envCredential('anthropic', { ANTHROPIC_API_KEY: '  sk-ant-x \n' })).toBe('sk-ant-x')
    expect(envCredential('anthropic', { ANTHROPIC_API_KEY: '   ' })).toBeNull()
    expect(envCredential('anthropic', {})).toBeNull()
  })

  it('counts a key saved in Settings or one in the environment', () => {
    expect(hasCredential({ claude_api_key_encrypted: 'enc' }, 'anthropic', {})).toBe(true)
    expect(hasCredential({}, 'anthropic', { ANTHROPIC_API_KEY: 'k' })).toBe(true)
    expect(hasCredential(null, 'postmark_server', {})).toBe(false)
    expect(hasAnyAIKeyFrom(null, { OPENROUTER_API_KEY: 'k' })).toBe(true)
    expect(hasAnyAIKeyFrom({}, {})).toBe(false)
  })

  it('says where each credential comes from, Settings first, and never its value', () => {
    const sources = credentialSources({ resend_api_key_encrypted: 'enc' }, { RESEND_API_KEY: 're_VALUE1', POSTMARK_SERVER_TOKEN: 'pm_VALUE2' })
    const by = Object.fromEntries(sources.map(s => [s.name, s.source]))
    expect(by.resend).toBe('settings')
    expect(by.postmark_server).toBe('environment')
    expect(by.anthropic).toBeNull()
    expect(JSON.stringify(sources)).not.toMatch(/VALUE/)
    expect(sources).toHaveLength(Object.keys(ENV_CREDENTIALS).length)
  })

  it('documents every variable in .env.example', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync('.env.example', 'utf8')
    for (const spec of Object.values(ENV_CREDENTIALS)) {
      for (const v of spec.vars) expect(example, v).toMatch(new RegExp(`^#?\\s*${v}=`, 'm'))
    }
  })
})
