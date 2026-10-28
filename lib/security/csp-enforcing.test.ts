import { describe, expect, it } from 'vitest'
import { buildEnforcingCsp } from './csp-enforcing.mjs'
import { buildReportOnlyCsp } from './csp'

/**
 * The enforcing CSP, sent by proxy.ts (and next.config.mjs on the paths it skips). Pins that production carries no 'unsafe-eval' and
 * that img-src names hosts rather than admitting every https: origin.
 */

const directive = (csp: string, name: string) =>
  csp.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `) || d === name) ?? ''

describe('the enforcing policy', () => {
  const prod = buildEnforcingCsp()

  it('has no unsafe-eval in production, and keeps it in development for React Refresh', () => {
    expect(directive(prod, 'script-src')).not.toContain("'unsafe-eval'")
    expect(directive(buildEnforcingCsp({ development: true }), 'script-src')).toContain("'unsafe-eval'")
  })

  it('does not admit every https: origin for images', () => {
    const img = directive(prod, 'img-src').split(/\s+/)
    expect(img).not.toContain('https:')
    for (const src of ["'self'", 'data:', 'blob:', 'https://*.supabase.co']) expect(img).toContain(src)
  })

  it('adds a self-hosted Supabase origin to img, connect and frame sources', () => {
    const csp = buildEnforcingCsp({ supabaseUrl: 'https://db.example.com/' })
    expect(directive(csp, 'img-src')).toContain('https://db.example.com')
    expect(directive(csp, 'connect-src')).toContain('https://db.example.com')
    expect(directive(csp, 'connect-src')).toContain('wss://db.example.com')
    expect(directive(csp, 'frame-src')).toContain('https://db.example.com')
  })

  it('does not repeat a hosted Supabase origin already covered by the wildcard', () => {
    const csp = buildEnforcingCsp({ supabaseUrl: 'https://abc.supabase.co' })
    expect(directive(csp, 'img-src')).not.toContain('abc.supabase.co')
  })

  it('carries the page nonce beside unsafe-inline when given one, and none otherwise', () => {
    expect(directive(buildEnforcingCsp({ nonce: 'abc123' }), 'script-src')).toContain("'unsafe-inline' 'nonce-abc123'")
    expect(prod).not.toContain('nonce-')
  })

  it('keeps the protections it already had', () => {
    expect(directive(prod, 'object-src')).toBe("object-src 'none'")
    expect(directive(prod, 'base-uri')).toBe("base-uri 'self'")
    expect(directive(prod, 'default-src')).toBe("default-src 'self'")
  })

  it('agrees with the report-only policy on image hosts', () => {
    const env = buildEnforcingCsp({ supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL })
    expect(directive(buildReportOnlyCsp('n'), 'img-src')).toBe(directive(env, 'img-src'))
  })
})
