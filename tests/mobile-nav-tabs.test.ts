import { describe, it, expect } from 'vitest'

import {
  MOBILE_TAB_COUNT,
  mobileTabsFor,
  navItemMatches,
  moreSectionsFor,
  navSectionsFor,
  visibleChildrenFor,
  fundSegFromPath,
  type NavItem,
} from '@/components/app-sidebar'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { AccessLevel } from '@/lib/access/effective'

/**
 * The phone's tab bar is built from the SAME list and the same resolver as the sidebar
 * — which is the point, and the thing worth pinning. A bar assembled from its own
 * hardcoded list would drift out of step with the access model the first time a domain
 * changed, and start offering pages whose every request 403s.
 */

type Access = (domain: Domain, feature?: FeatureKey) => AccessLevel

/** Everything visible — a fund admin with every feature switched on. */
const allowAll: Access = () => 'write'
/** Nothing but the entries that carry no domain at all (Settings, Support). */
const denyAll: Access = () => 'none'
const allowOnly = (...domains: Domain[]): Access => d => (domains.includes(d) ? 'write' : 'none')

describe('mobileTabsFor', () => {
  it('fills the bar and leaves the fifth slot for More', () => {
    expect(mobileTabsFor(true, allowAll)).toHaveLength(MOBILE_TAB_COUNT)
  })

  it('leads with the destinations a phone is actually used for', () => {
    expect(mobileTabsFor(true, allowAll).map(t => t.href)).toEqual([
      '/dashboard',
      '/emails',
      '/lps',
      '/funds',
    ])
  })

  it('never offers a page the user cannot open', () => {
    // The bar is an affordance, not a boundary — but a tab onto a 403 is worse than no
    // tab. Same rule the sidebar states.
    const tabs = mobileTabsFor(false, allowOnly('portfolio'))
    for (const tab of tabs) {
      const gated = tab.domain ?? tab.featureKey
      if (!gated) continue
      expect(tab.adminOnly ?? false).toBe(false)
    }
    expect(tabs.map(t => t.href)).not.toContain('/lps')
    expect(tabs.map(t => t.href)).not.toContain('/funds')
  })

  it('tops the bar up rather than leaving gaps when features are off', () => {
    // A fund running Portfolio Reporting alone still gets a full bar, not two tabs and
    // three holes.
    const tabs = mobileTabsFor(false, allowOnly('portfolio'))
    expect(tabs).toHaveLength(MOBILE_TAB_COUNT)
    expect(new Set(tabs.map(t => t.href)).size).toBe(tabs.length)
  })

  it('still gives a member with no grants somewhere to go', () => {
    // Settings and Support carry no domain, so they survive; an empty bar would be a
    // dead end in a standalone window with no address bar.
    const tabs = mobileTabsFor(false, denyAll)
    expect(tabs.length).toBeGreaterThan(0)
    expect(tabs.map(t => t.href)).toContain('/settings')
  })

  it('hides admin-only entries from a member', () => {
    const hrefs = mobileTabsFor(false, allowAll).map(t => t.href)
    expect(hrefs).not.toContain('/usage')
    expect(hrefs).not.toContain('/pending-actions')
  })
})

describe('navItemMatches', () => {
  const item = (over: Partial<NavItem>): NavItem =>
    ({ href: '/dashboard', label: 'Portfolio', icon: (() => null) as never, ...over })

  it('lights a tab on its own page and anything under it', () => {
    expect(navItemMatches(item({ href: '/lps' }), '/lps')).toBe(true)
    expect(navItemMatches(item({ href: '/lps' }), '/lps/capital')).toBe(true)
  })

  it('lights a tab on a child that lives at an unrelated path', () => {
    // Portfolio's children are /investments, /notes, /letters. Prefix-matching the
    // parent alone would leave the bar showing nothing selected across most of the app.
    const portfolio = item({ href: '/dashboard', children: [{ href: '/investments', label: 'Investments' }] })
    expect(navItemMatches(portfolio, '/investments')).toBe(true)
    expect(navItemMatches(portfolio, '/investments/abc')).toBe(true)
  })

  it('does not light a tab on a path that merely starts with the same characters', () => {
    expect(navItemMatches(item({ href: '/lps' }), '/lps-preview')).toBe(false)
    expect(navItemMatches(item({ href: '/deals' }), '/dealflow')).toBe(false)
  })
})

/**
 * The "More" sheet is no longer the desktop sidebar in a drawer — it is its own
 * surface (components/mobile-more-sheet.tsx), assembled from the same NAV_ITEMS
 * through the same resolver. Splitting the phone's nav in two introduces exactly one
 * new way to break it: a destination that is in neither half. That is what these pin.
 */
describe('navSectionsFor', () => {
  it('splits the phone\'s nav into two halves that are disjoint and complete', () => {
    // The bar shows four, the sheet shows the rest. A section in NEITHER half is
    // unreachable on a handset — and in a standalone window there is no address bar to
    // fall back on. A section in BOTH is the old drawer's mistake: the first thing the
    // menu showed was the tab you had just chosen not to tap.
    const badges = { review: 3, pendingActions: 2 }
    const tabs = mobileTabsFor(true, allowAll).map(t => t.href)
    const more = moreSectionsFor(true, allowAll, tabs, badges).map(s => s.href)

    expect(more.filter(h => tabs.includes(h))).toEqual([])
    const reachable = new Set([...tabs, ...more])
    for (const href of navSectionsFor(true, allowAll, badges).map(s => s.href)) {
      expect(reachable.has(href)).toBe(true)
    }
  })

  it('leaves a member with no grants somewhere to go in the sheet too', () => {
    const tabs = mobileTabsFor(false, denyAll).map(t => t.href)
    const reachable = [...tabs, ...moreSectionsFor(false, denyAll, tabs).map(s => s.href)]
    expect(reachable).toContain('/settings')
    expect(reachable).toContain('/support')
  })

  it('drops the two entries that are noise when nothing is waiting', () => {
    const idle = navSectionsFor(true, allowAll).map(s => s.href)
    expect(idle).not.toContain('/review')
    expect(idle).not.toContain('/pending-actions')

    const busy = navSectionsFor(true, allowAll, { review: 1, pendingActions: 4 }).map(s => s.href)
    expect(busy).toContain('/review')
    expect(busy).toContain('/pending-actions')
  })

  it('applies the same access rules as the sidebar and the bar', () => {
    const hrefs = navSectionsFor(false, allowOnly('portfolio'), { review: 5 }).map(s => s.href)
    expect(hrefs).toContain('/dashboard')
    expect(hrefs).not.toContain('/lps')
    expect(hrefs).not.toContain('/funds')
    // adminOnly, so hidden from a member even with something waiting.
    expect(hrefs).not.toContain('/pending-actions')
    expect(hrefs).not.toContain('/usage')
  })
})

describe('visibleChildrenFor', () => {
  const section = (href: string) => {
    const found = navSectionsFor(true, allowAll, { review: 1, pendingActions: 1 }).find(s => s.href === href)
    if (!found) throw new Error(`no section ${href}`)
    return found
  }

  it('gives the current section its sub-pages — the thing the tab bar cannot do', () => {
    const labels = visibleChildrenFor(section('/dashboard'), true, allowAll).map(c => c.label)
    expect(labels).toContain('Investments')
    expect(labels).toContain('Notes')
  })

  it('hides an admin-only sub-page from a member', () => {
    const hrefs = visibleChildrenFor(section('/lps'), false, allowAll).map(c => c.href)
    expect(hrefs).toContain('/lps/capital')
    expect(hrefs).not.toContain('/lps/preview')
  })

  it('builds the Funds sub-pages firm-wide until the URL is inside a fund, then fund-first', () => {
    // Outside a fund: every child is the firm-wide landing for its section (/funds/journal lists
    // every entity and asks which one), and there is no Overview — there is no fund to overview.
    // It used to offer nothing here and fall back to the browser's last vehicle, which after a
    // visit to a management company was that manco.
    const firmWide = visibleChildrenFor(section('/funds'), true, allowAll, { fundSeg: null })
    expect(firmWide.length).toBeGreaterThan(0)
    expect(firmWide.map(c => c.label)).not.toContain('Overview')
    for (const child of firmWide) expect(child.href).toMatch(/^\/funds\/[a-z-]+$/)
    expect(firmWide.map(c => c.href)).toContain('/funds/journal')

    const children = visibleChildrenFor(section('/funds'), true, allowAll, { fundSeg: 'abc' })
    expect(children[0]).toMatchObject({ href: '/funds/abc', label: 'Overview', exact: true })
    // Every other child hangs off the same fund, not off /funds itself — a child at
    // /funds/journal would open the wrong vehicle's ledger.
    for (const child of children.slice(1)) expect(child.href.startsWith('/funds/abc/')).toBe(true)
  })

  it('applies a vehicle kind only inside that vehicle — the firm-wide list shows every section', () => {
    // An individual has no capital accounts page, so inside one the child is gone…
    const inside = visibleChildrenFor(section('/funds'), true, allowAll, { fundSeg: 'abc', kind: 'individual' }).map(c => c.label)
    expect(inside).not.toContain('Capital accounts')
    // …but a stale kind in context must not trim the firm-wide list, which spans every kind.
    const firmWide = visibleChildrenFor(section('/funds'), true, allowAll, { fundSeg: null, kind: 'individual' }).map(c => c.label)
    expect(firmWide).toContain('Capital accounts')
  })

  it('has no separate fund-holdings page — fund holdings are on the Investments list', () => {
    const with_ = visibleChildrenFor(section('/dashboard'), true, allowAll, { fofActive: true }).map(c => c.href)
    expect(with_).not.toContain('/fund-holdings')
    expect(with_).toContain('/investments')
  })
})

/**
 * Which fund the Funds subnav points at is read from the URL and nowhere else.
 *
 * The bug this pins: the segment used to fall back to whichever vehicle was last in context, and
 * every entity page pins its own entity there — so after opening a management company, the subnav
 * built its links for the manco and "Entities → Bank" opened the manco's bank page.
 */
describe('fundSegFromPath', () => {
  const id = '11111111-2222-3333-4444-555555555555'

  it('takes the fund from a fund URL', () => {
    expect(fundSegFromPath(`/funds/${id}`)).toBe(id)
    expect(fundSegFromPath(`/funds/${id}/bank`)).toBe(id)
  })

  it('finds no fund on a firm-wide page, the overview, or a management company', () => {
    expect(fundSegFromPath('/funds')).toBeNull()
    expect(fundSegFromPath('/funds/journal')).toBeNull()
    expect(fundSegFromPath('/funds/status')).toBeNull()
    // Every entity lives under /funds now; /manco is a redirect and names no fund.
    expect(fundSegFromPath(`/manco/${id}/journal`)).toBeNull()
    expect(fundSegFromPath('/dashboard')).toBeNull()
  })
})
