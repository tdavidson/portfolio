import { describe, expect, it } from 'vitest'
import { pendingActionsBadgeFor } from '@/lib/cache/layout'
import { hasAccess, accessContextFrom } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { Domain } from '@/lib/access/domains'

/**
 * The badge used to count every pending row in the fund. Two things were wrong with that, and the
 * smaller one is the one that sounds worse: it was admin-only, so a member with grants opened a
 * queue they were never told had anything in it. The other is that an admin's count included rows
 * in domains a fund-level switch had turned OFF for everyone, so the badge promised a queue that
 * the page then refused to show.
 *
 * Both come from the same mistake — counting rows without asking who is looking.
 */

const counts = { portfolio: 3, accounting: 5, gp_economics: 2 }

function context(over: {
  role?: string
  grants?: Partial<Record<Domain, 'read' | 'write'>>
  features?: Partial<FeatureVisibilityMap>
}) {
  return accessContextFrom({
    fundId: 'fund-1',
    userId: 'user-1',
    vehicles: { all: true, ids: [] },
    role: over.role ?? 'member',
    features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone', ...(over.features ?? {}) } as FeatureVisibilityMap,
    grants: Object.entries(over.grants ?? {}).map(([domain, level]) => ({ domain, level })),
    defaults: [],
  })
}

const badge = (ctx: ReturnType<typeof context>) =>
  pendingActionsBadgeFor(counts, domain => hasAccess(ctx, domain, 'read'))

describe('the pending-actions badge counts what the viewer can open', () => {
  it('counts only the domains a member holds', () => {
    expect(badge(context({ grants: { portfolio: 'read' } }))).toBe(3)
    expect(badge(context({ grants: { portfolio: 'read', gp_economics: 'read' } }))).toBe(5)
  })

  it('is zero for a member who can read none of the queued domains', () => {
    expect(badge(context({ grants: {} }))).toBe(0)
  })

  it('counts everything switched on for an admin', () => {
    expect(badge(context({ role: 'admin' }))).toBe(10)
  })

  it('does NOT count a domain the fund has switched off, even for an admin', () => {
    // `off` denies everyone, admins included. Counting those rows advertised a queue that the
    // page would then render as empty.
    expect(badge(context({ role: 'admin', features: { accounting: 'off' } }))).toBe(5)
  })

  it('gives accounting holders the lp_capital implication without double counting', () => {
    // accounting implies lp_capital (DOMAIN_META), and lp_capital has no rows here — the point is
    // that the reduce visits each domain once.
    expect(badge(context({ grants: { accounting: 'read' } }))).toBe(5)
  })

  it('ignores a count for a domain name that is not a real domain', () => {
    expect(pendingActionsBadgeFor({ not_a_domain: 99 }, () => true)).toBe(0)
  })
})
