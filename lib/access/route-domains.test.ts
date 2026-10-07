import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The coverage test — the reason this access model will still be true in a year.
 *
 * 137 of 263 API routes shipped with no role check at all. Not one of them decided to skip it;
 * nothing asked. So the rule is enforced here rather than left to reviewers: every route under
 * app/api is either mapped to a domain in ROUTE_DOMAINS, or listed in UNGATED_ROUTES with a
 * reason. A new route that does neither fails CI, and the failure message says what to do.
 *
 * If this test is in your way: the answer is to add your route to one of the two maps, not to
 * add an exception here.
 *
 * See plans/plan-access-control.md.
 */

import { ROUTE_DOMAINS, UNGATED_ROUTES, OPTIONAL_ROUTES, requiredLevel, type Method } from './route-domains'
import { DOMAINS } from './domains'
import { hasAccess, type AccessContext } from './effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const accessCtx = (over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY } as FeatureVisibilityMap,
  grants: {},
  defaults: {},
  ...over,
})

const API_DIR = path.join(process.cwd(), 'app', 'api')

/** Every route.ts under app/api, as the registry keys them: 'api/foo/[id]'. */
function findRoutes(dir: string, base = 'api'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...findRoutes(full, `${base}/${entry}`))
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      out.push(base)
    }
  }
  return out.sort()
}

const routes = findRoutes(API_DIR)

describe('route access registry', () => {
  it('finds the API routes at all (guards against a silently passing test)', () => {
    expect(routes.length).toBeGreaterThan(200)
    expect(routes).toContain('api/analyst')
  })

  it('maps every API route to a domain or an explicit ungated reason', () => {
    const unmapped = routes.filter(r => !(r in ROUTE_DOMAINS) && !(r in UNGATED_ROUTES))

    expect(
      unmapped,
      unmapped.length === 0
        ? ''
        : `\n\nThese API routes have no access decision:\n${unmapped.map(r => `  - ${r}`).join('\n')}\n\n` +
          `Add each to lib/access/route-domains.ts:\n` +
          `  ROUTE_DOMAINS['<route>'] = { domain: '<domain>' }   // gated by a per-user grant\n` +
          `  UNGATED_ROUTES['<route>'] = 'why this needs no grant'\n\n` +
          `Domains: ${DOMAINS.join(', ')}\n`,
    ).toEqual([])
  })

  it('has no entries for routes that no longer exist', () => {
    const known = new Set(routes)
    const stale = [...Object.keys(ROUTE_DOMAINS), ...Object.keys(UNGATED_ROUTES)]
      // OPTIONAL_ROUTES are kept out of git on purpose, so they're absent from a clone and from
      // CI. Their entries are not stale — the file just isn't here.
      .filter(r => !known.has(r) && !OPTIONAL_ROUTES.has(r))
    expect(stale, `Registry entries for deleted routes: ${stale.join(', ')}`).toEqual([])
  })

  it('never lists a route as both gated and ungated', () => {
    const both = Object.keys(ROUTE_DOMAINS).filter(r => r in UNGATED_ROUTES)
    expect(both).toEqual([])
  })

  it('uses only real domains', () => {
    const bad = Object.entries(ROUTE_DOMAINS).filter(([, e]) => !DOMAINS.includes(e.domain))
    expect(bad.map(([r]) => r)).toEqual([])
  })

  it('gives every ungated route a non-trivial reason', () => {
    const weak = Object.entries(UNGATED_ROUTES).filter(([, reason]) => reason.trim().length < 10)
    expect(weak.map(([r]) => r)).toEqual([])
  })

  it('keeps the sensitive domains free of the "any member" escape hatch', () => {
    // `level: 'any'` skips the domain check. It's legitimate for a user's own data, but it must
    // never appear on the domains this whole exercise exists to protect.
    const sensitive = ['gp_economics', 'lp_capital', 'accounting', 'diligence', 'compliance']
    const leaks = Object.entries(ROUTE_DOMAINS).filter(([, e]) => {
      if (!sensitive.includes(e.domain)) return false
      const levels = typeof e.level === 'object' ? Object.values(e.level) : [e.level]
      return levels.includes('any')
    })
    expect(leaks.map(([r]) => r)).toEqual([])
  })

  it('keeps fund-wide Google connection routes administrator-only', () => {
    expect(ROUTE_DOMAINS['api/auth/google']).toEqual({ domain: 'admin' })
    expect(ROUTE_DOMAINS['api/auth/google/callback']).toEqual({ domain: 'admin' })
  })
})

/**
 * The review queue is Portfolio Reporting, and it must work in a fund that never bought the
 * Investment Workflow product.
 *
 * It didn't. Every `api/emails/**` route was filed under `dealflow`, so a fund with `deals: off`
 * — the shipped default — got a Review page whose email cards opened a modal that 403'd on its
 * first fetch, and no Inbound page to reprocess from. The nav told the truth; the queue behind it
 * was dead. PRODUCT_META has said all along that Portfolio Reporting owns "inbound updates" and
 * Investment Workflow owns "inbound DEAL intake" — the registry just disagreed.
 *
 * The line: the email itself is intake substrate (portfolio). Promoting one into a deal or a
 * diligence data room is the deal-flow act, and stays gated on the destination.
 */
describe('inbound email routes survive the Deals product being off', () => {
  const dealsOff = accessCtx({
    role: 'admin',
    features: { ...DEFAULT_FEATURE_VISIBILITY, deals: 'off' } as FeatureVisibilityMap,
  })

  // Everything the Review queue's EmailReviewModal calls, plus the Inbound page that is the only
  // place to reprocess an email that already left the queue.
  const REVIEW_QUEUE_ROUTES: [string, Method][] = [
    ['api/emails', 'GET'],
    ['api/emails/[id]', 'GET'],
    ['api/emails/[id]', 'PATCH'],
    ['api/emails/[id]/reviews', 'GET'],
    ['api/emails/[id]/reviews', 'POST'],
    ['api/emails/[id]/reprocess', 'POST'],
    ['api/emails/[id]/attachments', 'POST'],
    ['api/emails/[id]/attachment/[index]', 'GET'],
    ['api/emails/save-to-drive', 'POST'],
    ['api/emails/[id]/reroute', 'POST'],
    ['api/review', 'GET'],
    ['api/review/[id]/resolve', 'POST'],
  ]

  it.each(REVIEW_QUEUE_ROUTES)('%s %s is callable with deals off', (route, method) => {
    const entry = ROUTE_DOMAINS[route]
    expect(entry, `${route} is not in ROUTE_DOMAINS`).toBeDefined()
    const need = requiredLevel(entry, method)
    // 'any' skips the domain check entirely — already callable.
    if (need === 'any') return
    expect(
      hasAccess(dealsOff, entry.domain, need, entry.feature),
      `${method} /${route} is gated on '${entry.domain}', which is denied when the Deals product is off`,
    ).toBe(true)
  })

  it('promoting an email INTO a deal or diligence still needs that product', () => {
    expect(ROUTE_DOMAINS['api/emails/[id]/accept-to-diligence'].domain).toBe('diligence')
    expect(hasAccess(dealsOff, 'dealflow', 'read')).toBe(false)
  })
})

describe('requiredLevel', () => {
  it('derives read from GET and write from everything else', () => {
    const entry = { domain: 'portfolio' } as const
    expect(requiredLevel(entry, 'GET')).toBe('read')
    expect(requiredLevel(entry, 'HEAD')).toBe('read')
    expect(requiredLevel(entry, 'POST')).toBe('write')
    expect(requiredLevel(entry, 'PATCH')).toBe('write')
    expect(requiredLevel(entry, 'DELETE')).toBe('write')
  })

  it('honours a flat override for a method that lies — a POST that only queries', () => {
    const entry = { domain: 'diligence', level: 'read' } as const
    expect(requiredLevel(entry, 'POST')).toBe('read')
  })

  it('honours a per-method override and falls back for unlisted methods', () => {
    const entry = { domain: 'admin', level: { GET: 'any' } } as const
    expect(requiredLevel(entry, 'GET')).toBe('any')
    expect(requiredLevel(entry, 'POST')).toBe('write')
  })

  it('is case-insensitive about the method', () => {
    expect(requiredLevel({ domain: 'portfolio' }, 'get')).toBe('read')
  })
})
