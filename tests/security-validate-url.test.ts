import { describe, it, expect } from 'vitest'
import { validateBaseUrl, validateBaseUrlResolved } from '@/lib/validate-url'

/** SSRF filter for the fund's OpenRouter base URL — the one custom AI endpoint Settings accepts. */

describe('validateBaseUrl — literal hosts', () => {
  it.each([
    'https://openrouter.ai/api/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700:4700::1111]/v1',
  ])('allows %s', url => {
    expect(validateBaseUrl(url).ok).toBe(true)
  })

  it.each([
    // Loopback: there is no self-hosted provider any more, so nothing local is a valid endpoint.
    'http://localhost:11434',
    'http://LOCALHOST/',
    'http://api.localhost/',
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://127.0.0.2',
    'http://0.0.0.0',
    'http://100.64.0.1',
    'http://2130706434/', // 127.0.0.2 as an integer — URL normalizes it
    'http://0xa9fea9fe/', // 169.254.169.254 in hex
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:2]/',
    'http://[::]/',
    'http://[ff02::1]/',
    'file:///etc/passwd',
    'gopher://example.com',
    'not a url',
  ])('blocks %s', url => {
    expect(validateBaseUrl(url).ok).toBe(false)
  })
})

describe('validateBaseUrlResolved — DNS', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const addrs = map[host]
    if (!addrs) throw new Error('ENOTFOUND')
    return addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    const lookup = resolver({ 'internal.example': ['10.0.0.5'], 'meta.example': ['169.254.169.254'], 'v6.example': ['fd00::1'], 'lo.example': ['::1'] })
    for (const host of ['internal.example', 'meta.example', 'v6.example', 'lo.example']) {
      expect((await validateBaseUrlResolved(`https://${host}/v1`, lookup)).ok, host).toBe(false)
    }
  })

  it('refuses when ANY of several records is private', async () => {
    const lookup = resolver({ 'mixed.example': ['93.184.216.34', '192.168.0.10'] })
    expect((await validateBaseUrlResolved('https://mixed.example/v1', lookup)).ok).toBe(false)
  })

  it('refuses an unresolvable host', async () => {
    expect((await validateBaseUrlResolved('https://nope.example/v1', resolver({}))).ok).toBe(false)
  })

  it('allows a host resolving only to public addresses, and skips DNS for IP literals', async () => {
    const lookup = resolver({ 'openrouter.ai': ['104.18.2.115', '2606:4700::6812:273'] })
    expect(await validateBaseUrlResolved('https://openrouter.ai/api/v1', lookup)).toEqual({ ok: true, url: 'https://openrouter.ai/api/v1' })
    const never = async () => { throw new Error('should not resolve') }
    expect((await validateBaseUrlResolved('http://localhost:11434', never)).ok).toBe(false)
    expect((await validateBaseUrlResolved('https://8.8.8.8/v1', never)).ok).toBe(true)
  })
})

describe('the ranges added after the 1 Nov review', () => {
  it('refuses 198.18/15 and 192.0.0/24', async () => {
    const { blockedAddressReason } = await import('@/lib/validate-url')
    expect(blockedAddressReason('198.18.0.1')).toMatch(/not allowed/)
    expect(blockedAddressReason('198.19.255.1')).toMatch(/not allowed/)
    expect(blockedAddressReason('192.0.0.8')).toMatch(/not allowed/)
    expect(blockedAddressReason('198.20.0.1')).toBeNull()
    expect(blockedAddressReason('192.0.2.1')).toBeNull()
  })

  it('judges a NAT64 address by the IPv4 address inside it', async () => {
    const { blockedAddressReason } = await import('@/lib/validate-url')
    expect(blockedAddressReason('64:ff9b::7f00:1')).toMatch(/Loopback/)
    expect(blockedAddressReason('64:ff9b::a9fe:a9fe')).toMatch(/Link-local/)
    expect(blockedAddressReason('64:ff9b:1::a00:1')).toMatch(/Private/)
    expect(blockedAddressReason('64:ff9b::808:808')).toBeNull()
  })
})
