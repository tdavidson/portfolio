import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The nav must answer the SAME question the API answers.
 *
 * It gets its own test because the two drifted once already, in both directions: the sidebar used
 * to consult only the fund-level switch (so it offered links whose APIs 403ed, and hid nothing
 * from anyone who knew the URL), and then briefly consulted a per-domain map that had collapsed
 * each domain to a single feature key (so it hid pages the user could open and whose API returned
 * 200).
 *
 * These pin the resolver behaviour the sidebar's `canSee` depends on — specifically for the nav
 * entries whose own featureKey differs from their domain's primaryFeature, which is exactly where
 * the collapse bit.
 */

import { effectiveAccess, type AccessContext } from './effective'
import { domainForFeature, domainFundLevel, domainGrantableToMembers } from './domains'
import { ROUTE_DOMAINS } from './route-domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const ctx = (features: Partial<FeatureVisibilityMap>, grants: Record<string, string> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY, ...features } as FeatureVisibilityMap,
  grants: grants as never,
  defaults: {},
})

describe('nav visibility — a domain spanning several feature switches', () => {
  it('resolves Capital accounts by lp_tracking, not by the lps switch its domain points at', () => {
    // The exact regression: `lps: admin` + `lp_tracking: everyone`. The page renders, the API
    // returns 200 — so the nav must show the link.
    const c = ctx({ lps: 'admin', lp_tracking: 'everyone' }, { lp_capital: 'read' })
    expect(effectiveAccess(c, 'lp_capital', 'lp_tracking')).toBe('read')
    // …while the LPs section itself, which the `lps` switch really does govern, stays hidden.
    expect(effectiveAccess(c, 'lp_capital')).toBe('none')
  })

  it('resolves interactions and notes independently inside `relationships`', () => {
    const c = ctx({ interactions: 'off', notes: 'everyone' }, { relationships: 'write' })
    expect(effectiveAccess(c, 'relationships', 'interactions')).toBe('none')
    expect(effectiveAccess(c, 'relationships', 'notes')).toBe('write')
  })

  it('resolves the LP-relations switches independently of each other', () => {
    const c = ctx({ lp_letters: 'everyone', lp_activity: 'admin', lp_portal: 'hidden' }, { lp_relations: 'read' })
    expect(effectiveAccess(c, 'lp_relations', 'lp_letters')).toBe('read')
    expect(effectiveAccess(c, 'lp_relations', 'lp_activity')).toBe('none')
    expect(effectiveAccess(c, 'lp_relations', 'lp_portal')).toBe('none')
  })

  it('maps every feature key to a domain — a nav entry can always find one', () => {
    // `canSee` derives the domain from the entry's featureKey when it has no explicit one. A key
    // that mapped to nothing would silently skip the grant check and show the item to everyone.
    for (const key of Object.keys(DEFAULT_FEATURE_VISIBILITY) as (keyof FeatureVisibilityMap)[]) {
      expect(domainForFeature(key), `feature "${key}" belongs to no domain`).toBeDefined()
    }
  })
})

/**
 * The settings grid asks "is a grant here worth offering?" and must agree with the resolver that
 * will later ignore it.
 *
 * This is the rule behind a real bug: setting Compliance to "Admins only" changed access instantly,
 * but the grid went on showing a Read/Write dropdown for every member — because it had asked the
 * server once, at mount, and never again. The answer is derivable from the feature map the page
 * already holds, so the grid now computes it live with these.
 */
describe('domainGrantableToMembers — what the access grid offers', () => {
  const features = (over: Partial<FeatureVisibilityMap>) =>
    ({ ...DEFAULT_FEATURE_VISIBILITY, ...over }) as FeatureVisibilityMap

  it('agrees with effectiveAccess: not grantable ⇒ a granted member still gets nothing', () => {
    // The two must never disagree — that gap IS the lying dropdown.
    for (const level of ['admin', 'hidden', 'off'] as const) {
      const f = features({ compliance: level })
      expect(domainGrantableToMembers('compliance', f)).toBe(false)
      expect(
        effectiveAccess(
          { fundId: 'f', userId: 'u', role: 'member', features: f, grants: { compliance: 'write' }, defaults: {}, vehicles: { all: true, ids: [] } },
          'compliance',
        ),
      ).toBe('none')
    }
  })

  it('is grantable when the fund opens it to members, and the grant then decides', () => {
    const f = features({ compliance: 'everyone' })
    expect(domainGrantableToMembers('compliance', f)).toBe(true)
    expect(
      effectiveAccess(
        { fundId: 'f', userId: 'u', role: 'member', features: f, grants: { compliance: 'read' }, defaults: {}, vehicles: { all: true, ids: [] } },
        'compliance',
      ),
    ).toBe('read')
  })

  it('treats a domain with no fund-level switch as always grantable', () => {
    expect(domainGrantableToMembers('portfolio', features({}))).toBe(true)
    expect(domainFundLevel('portfolio', features({}))).toBeNull()
  })

  it('reports the level so the grid can name WHY it is not on offer', () => {
    expect(domainFundLevel('compliance', features({ compliance: 'admin' }))).toBe('admin')
    expect(domainFundLevel('accounting', features({ accounting: 'off' }))).toBe('off')
  })
})

/**
 * A nav entry and the API behind it must be gated on the SAME domain, or the link lies in one
 * direction or the other.
 *
 * Inbound is the case that bit: the sidebar entry and every `api/emails/**` route agreed on
 * `dealflow`, which was self-consistent and wrong — the mailbox is where portfolio updates arrive,
 * so a fund running Portfolio Reporting alone lost both the page and the API that the review queue
 * needs. Moving one without the other would have been worse than either.
 */
describe('nav entries agree with the routes behind them', () => {
  const sidebar = readFileSync(path.join(process.cwd(), 'components', 'app-sidebar.tsx'), 'utf8')

  const navDomainFor = (href: string): string | undefined => {
    const entry = sidebar.match(new RegExp(`\\{[^{}]*href:\\s*'${href}'[^{}]*\\}`))
    return entry?.[0].match(/domain:\s*'([a-z_]+)'/)?.[1]
  }

  it('finds the entry it claims to check (guards against a vacuous pass)', () => {
    expect(navDomainFor('/emails')).toBeDefined()
  })

  it('gates the Inbound link on the same domain as the inbox API', () => {
    expect(navDomainFor('/emails')).toBe(ROUTE_DOMAINS['api/emails'].domain)
  })

  it('shows Inbound to a fund that never bought the Deals product', () => {
    const c = ctx({ deals: 'off' }, { portfolio: 'read' })
    expect(effectiveAccess(c, ROUTE_DOMAINS['api/emails'].domain)).toBe('read')
  })
})
