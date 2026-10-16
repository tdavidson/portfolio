import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { config } from '@/proxy'
import { ROUTE_DOMAINS } from '@/lib/access/route-domains'

/**
 * A path the proxy matcher skips never reaches gateApiRequest or the AAL2/MFA check. The matcher
 * once excluded `.*\.(png|svg|…)$` site-wide, so `/api/emails/<id>/attachment/0.png` — a dynamic
 * segment the caller chooses — walked past the gate, and `/api/inbound-emailfoo` did too.
 *
 * Compiled with Next's OWN matcher compiler (the one the build uses), not a hand-rolled regex, so
 * the test cannot drift from what actually runs.
 */
const require_ = createRequire(import.meta.url)
const { getMiddlewareMatchers } = require_('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => { regexp: string }[]
}

const matchers = getMiddlewareMatchers(config.matcher, {}).map(m => new RegExp(m.regexp))
const runsProxy = (path: string) => matchers.some(re => re.test(path))

function concretize(key: string, value: string): string {
  return '/' + key.split('/').map(seg => (seg.startsWith('[') ? value : seg)).join('/')
}

describe('proxy matcher never lets an /api path skip the gate', () => {
  const keys = Object.keys(ROUTE_DOMAINS)

  it('has routes to check', () => {
    expect(keys.length).toBeGreaterThan(50)
  })

  for (const ext of ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp']) {
    it(`every mapped route still runs the proxy when its dynamic segments end in .${ext}`, () => {
      const skipped = keys
        .map(k => concretize(k, `0.${ext}`))
        .filter(p => !runsProxy(p))
      expect(skipped).toEqual([])
    })
  }

  it('every mapped route runs the proxy with plain values, too', () => {
    const skipped = keys.map(k => concretize(k, '00000000-0000-0000-0000-000000000000')).filter(p => !runsProxy(p))
    expect(skipped).toEqual([])
  })

  it('the attachment download the finding was about', () => {
    expect(runsProxy('/api/emails/abc/attachment/0.png')).toBe(true)
    expect(runsProxy('/api/emails/abc/attachment/0.svg')).toBe(true)
  })

  it('the inbound-email exclusion is anchored to a segment boundary', () => {
    expect(runsProxy('/api/inbound-emailfoo')).toBe(true)
    expect(runsProxy('/api/inbound-email.png')).toBe(true)
    expect(runsProxy('/api/inbound-email')).toBe(false)
    expect(runsProxy('/api/inbound-email/')).toBe(false)
    expect(runsProxy('/api/inbound-email/resend')).toBe(false)
  })

  it('still skips static assets and Next internals', () => {
    for (const p of ['/logo.png', '/icons/a.svg', '/img/x.webp', '/favicon.ico', '/_next/static/chunks/a.js', '/_next/image']) {
      expect(runsProxy(p), p).toBe(false)
    }
    for (const p of ['/dashboard', '/api', '/api/x', '/auth']) {
      expect(runsProxy(p), p).toBe(true)
    }
  })
})
