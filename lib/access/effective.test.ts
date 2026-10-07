import { describe, it, expect } from 'vitest'

/**
 * The access policy, pinned.
 *
 * `effectiveAccess` is the only thing standing between a fund member and every byte of fund data,
 * across four surfaces (UI, Analyst, MCP, API keys). The ORDER of its checks is the policy, and
 * every reordering is a security change that would otherwise look like a refactor. These tests are
 * the specification — read them before touching the resolver.
 *
 * See plans/plan-access-control.md.
 */

import { effectiveAccess, hasAccess, readableDomains, normalizeRole, type AccessContext } from './effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY } as FeatureVisibilityMap,
  grants: {},
  defaults: {},
  ...over,
})

const withFeature = (key: keyof FeatureVisibilityMap, level: string, over: Partial<AccessContext> = {}) =>
  ctx({ ...over, features: { ...DEFAULT_FEATURE_VISIBILITY, [key]: level } as FeatureVisibilityMap })

describe('effectiveAccess — the fund-level switch is a ceiling nobody clears', () => {
  it('denies a hidden domain to a member who has been granted write', () => {
    const c = withFeature('accounting', 'hidden', { grants: { accounting: 'write' } })
    expect(effectiveAccess(c, 'accounting')).toBe('none')
  })

  it('denies a hidden domain to an ADMIN — hidden means hidden, not just un-navved', () => {
    // The whole point of the change: an admin who hides an area has hidden it from themselves too,
    // and can still un-hide it, because the switch lives in Settings (the admin domain).
    const c = withFeature('accounting', 'hidden', { role: 'admin' })
    expect(effectiveAccess(c, 'accounting')).toBe('none')
  })

  it('treats a stored `hidden` exactly as `off` — it is legacy, not a third state', () => {
    // Settings no longer offers Hidden: once hidden stopped meaning "un-nav but still serve", the
    // two collapsed into one thing. Stored rows must keep denying.
    const c = (level: string) =>
      ctx({ features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: level } as FeatureVisibilityMap, grants: { accounting: 'write' } })
    expect(effectiveAccess(c('hidden'), 'accounting')).toBe(effectiveAccess(c('off'), 'accounting'))
    expect(effectiveAccess(c('hidden'), 'accounting')).toBe('none')
  })

  it('denies an off domain to everyone', () => {
    expect(effectiveAccess(withFeature('diligence', 'off', { role: 'admin' }), 'diligence')).toBe('none')
    expect(effectiveAccess(withFeature('diligence', 'off', { role: 'viewer' }), 'diligence')).toBe('none')
    expect(effectiveAccess(withFeature('diligence', 'off', { grants: { diligence: 'write' } }), 'diligence')).toBe('none')
  })
})

describe('effectiveAccess — admins', () => {
  it('gets write on everything switched on, with no grant rows at all', () => {
    const c = withFeature('accounting', 'admin', { role: 'admin' })
    expect(effectiveAccess(c, 'accounting')).toBe('write')
    expect(effectiveAccess(c, 'admin')).toBe('write')
  })

  it('is not narrowed by a grant row — grants govern members', () => {
    const c = withFeature('accounting', 'everyone', { role: 'admin', grants: { accounting: 'none' } })
    expect(effectiveAccess(c, 'accounting')).toBe('write')
  })
})

describe('effectiveAccess — members and grants', () => {
  it('gets nothing in an admin-level area even when granted write', () => {
    // Grants only narrow. To give one member gp_economics the admin must first open the fund-level
    // switch; the grant then decides who among the members actually has it.
    const c = withFeature('gp_economics', 'admin', { grants: { gp_economics: 'write' } })
    expect(effectiveAccess(c, 'gp_economics')).toBe('none')
  })

  it('gets their grant once the area is open to members', () => {
    const c = withFeature('gp_economics', 'everyone', { grants: { gp_economics: 'read' } })
    expect(effectiveAccess(c, 'gp_economics')).toBe('read')
  })

  it('falls back to the fund default when they have no explicit grant', () => {
    const c = withFeature('accounting', 'everyone', { defaults: { accounting: 'read' } })
    expect(effectiveAccess(c, 'accounting')).toBe('read')
  })

  it('prefers an explicit grant over the default, in both directions', () => {
    const open = { features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone' } as FeatureVisibilityMap }
    expect(effectiveAccess(ctx({ ...open, defaults: { accounting: 'write' }, grants: { accounting: 'none' } }), 'accounting')).toBe('none')
    expect(effectiveAccess(ctx({ ...open, defaults: { accounting: 'none' }, grants: { accounting: 'write' } }), 'accounting')).toBe('write')
  })

  it('gets nothing with neither grant nor default — deny is the floor', () => {
    expect(effectiveAccess(withFeature('accounting', 'everyone'), 'accounting')).toBe('none')
  })

  it('never reaches the admin domain, however it is granted', () => {
    expect(effectiveAccess(ctx({ grants: { admin: 'write' } }), 'admin')).toBe('none')
    expect(effectiveAccess(ctx({ defaults: { admin: 'write' } }), 'admin')).toBe('none')
    expect(effectiveAccess(ctx({ role: 'viewer', grants: { admin: 'write' } }), 'admin')).toBe('none')
  })
})

describe('effectiveAccess — accounting implies lp_capital', () => {
  // Not a convenience: a fund's chart has one capital account per partner, NAMED for them, so the
  // trial balance carries LP identities by construction. Gating it field-by-field doesn't hold —
  // omit the statement of changes in partners' capital and the same numbers ship as trial-balance
  // rows. Saying it out loud beats a checkbox that lies.
  it('gives a member with the books LP capital too, with no lp_capital grant', () => {
    // lps is off by default now, which would hard-deny lp_capital (see the 'switched off' test
    // below); open the lp_capital ceiling explicitly so this exercises the accounting IMPLICATION.
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
      grants: { accounting: 'read' },
    })
    expect(effectiveAccess(c, 'lp_capital')).toBe('read')
  })

  it('carries the LEVEL across, not just the fact — writing the books moves partner capital', () => {
    // A distribution debits cash and credits each partner's capital account. Someone who can post
    // one has write access to LP capital whether or not anyone ticked that box.
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
      grants: { accounting: 'write' },
    })
    expect(effectiveAccess(c, 'lp_capital')).toBe('write')
  })

  it('takes the HIGHER of the two, so an explicit lp_capital grant still stands alone', () => {
    const open = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap
    // Books read + LP write → write.
    expect(effectiveAccess(ctx({ features: open, grants: { accounting: 'read', lp_capital: 'write' } }), 'lp_capital')).toBe('write')
    // No books at all → the LP grant is the whole answer. This is what lp_capital still protects:
    // portfolio staff who never get the ledger.
    expect(effectiveAccess(ctx({ features: open, grants: { lp_capital: 'read' } }), 'lp_capital')).toBe('read')
    expect(effectiveAccess(ctx({ features: open, grants: { portfolio: 'write' } }), 'lp_capital')).toBe('none')
  })

  it('does NOT let the implication revive an lp_capital area the fund switched off', () => {
    // A hard deny on the domain itself wins over anything implied.
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'hidden' } as FeatureVisibilityMap,
      grants: { accounting: 'write' },
    })
    expect(effectiveAccess(c, 'lp_capital')).toBe('none')
  })

  it('does not imply anything in the other direction — LP capital is not the books', () => {
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
      grants: { lp_capital: 'write' },
    })
    expect(effectiveAccess(c, 'accounting')).toBe('none')
  })

  it('does not leak into gp_economics — carry is NOT structurally part of the ledger', () => {
    // The whole point of keeping gp_economics separate: unlike partners, carry can be withheld
    // from someone who reads the books.
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' } as FeatureVisibilityMap,
      grants: { accounting: 'write' },
    })
    expect(effectiveAccess(c, 'gp_economics')).toBe('none')
  })
})

describe('effectiveAccess — the viewer (read-only demo)', () => {
  it('reads admin-level areas, which a plain member cannot — this is what the demo runs on', () => {
    // Mirrors the old assertReadAccess (admin|viewer pass, member does not): the demo fund shows
    // off admin-only pages to a viewer.
    const c = withFeature('accounting', 'admin', { role: 'viewer' })
    expect(effectiveAccess(c, 'accounting')).toBe('read')
    expect(effectiveAccess(withFeature('accounting', 'admin'), 'accounting')).toBe('none')
  })

  it('is never widened past read by a grant', () => {
    const c = withFeature('accounting', 'everyone', { role: 'viewer', grants: { accounting: 'write' } })
    expect(effectiveAccess(c, 'accounting')).toBe('read')
  })
})

describe('effectiveAccess — per-route feature override', () => {
  it('uses the route\'s own key for a domain that spans several switches', () => {
    // `relationships` covers interactions AND notes, and a fund can switch them independently, so
    // a route passes its own key rather than relying on a domain-wide one.
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, interactions: 'off', notes: 'everyone' } as FeatureVisibilityMap,
      grants: { relationships: 'write' },
    })
    expect(effectiveAccess(c, 'relationships', 'interactions')).toBe('none')
    expect(effectiveAccess(c, 'relationships', 'notes')).toBe('write')
  })

  it('treats a domain with no switch as always on, leaving the grant to decide', () => {
    expect(effectiveAccess(ctx({ grants: { portfolio: 'read' } }), 'portfolio')).toBe('read')
    expect(effectiveAccess(ctx(), 'portfolio')).toBe('none')
  })
})

describe('hasAccess / readableDomains / normalizeRole', () => {
  it('treats write as clearing a read requirement, but not the reverse', () => {
    const c = withFeature('accounting', 'everyone', { grants: { accounting: 'read' } })
    expect(hasAccess(c, 'accounting', 'read')).toBe(true)
    expect(hasAccess(c, 'accounting', 'write')).toBe(false)
  })

  it('lists only what the user can actually read — including what accounting implies', () => {
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', deals: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
      grants: { accounting: 'read', dealflow: 'none', portfolio: 'write' },
    })
    // lp_capital rides along on accounting once its ceiling is open (lps/lp_tracking) — see the
    // implication tests above, and the next test for why that's the honest answer.
    expect(readableDomains(c).sort()).toEqual(['accounting', 'lp_capital', 'portfolio'])
  })

  it('lets the implication override an admins-only LPs switch, deliberately', () => {
    // A CONSEQUENCE THE ADMIN SHOULD KNOW: set LPs to "Admins only", then grant a member the
    // books, and they can open /lps. That looks like the switch being ignored — but they already
    // see every partner's name and balance in the trial balance, so denying the LPs page would
    // protect nothing and only teach them the switch is unreliable. Contrast the test above:
    // hidden/off DO stop it, because those are hard denies rather than "admins only".
    const c = ctx({
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'admin' } as FeatureVisibilityMap,
      grants: { accounting: 'read' },
    })
    expect(effectiveAccess(c, 'lp_capital')).toBe('read')
  })

  it('treats an unrecognised role as the least power, not the most', () => {
    // fund_members.role is unconstrained text; a typo must not become an escalation.
    expect(normalizeRole('administrator')).toBe('member')
    expect(normalizeRole(null)).toBe('member')
    expect(normalizeRole('admin')).toBe('admin')
  })
})
