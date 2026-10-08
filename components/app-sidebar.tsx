'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, ClipboardCheck, ListChecks, Mail, Upload, Send, Settings, LifeBuoy, PanelLeftClose, PanelLeftOpen, Monitor, Sun, Moon, BarChart3, TrendingUp, Lock, Users, Handshake, ArrowDownCircle, FileText, Crown, ShieldCheck, Lightbulb, Microscope, BookOpen, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useSidebar } from '@/components/sidebar-context'
import { ACCOUNTING_SECTIONS, sectionsForKind } from '@/lib/accounting/nav'
import { useVehicle, FUND_SUBPAGE_SLUGS } from '@/components/accounting-vehicle'
import type { FeatureKey, FeatureVisibilityMap } from '@/lib/types/features'
import { domainForFeature, type Domain } from '@/lib/access/domains'
import { useAccess } from '@/components/access-context'
import type { AccessLevel } from '@/lib/access/effective'

const THEME_CYCLE = ['system', 'light', 'dark'] as const
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' }

interface NavChild {
  href: string
  label: string
  adminOnly?: boolean
  featureKey?: FeatureKey
  /** Only where the featureKey can't imply it (or there is no featureKey). */
  domain?: Domain
  /** Notes moved from a top-level item into Portfolio, and its unread count moved with it. */
  badgeKey?: 'notes'
  /** Highlight only on the exact path, never on descendants. The Funds "Overview" child
   *  (/funds/<id>) is a prefix of every sibling, so a prefix match would light it everywhere. */
  exact?: boolean
  /** Only for a fund of funds. DERIVED from the data (at least one holding is a fund), not
   *  from a feature key — so it is filtered separately from canSee(). */
  requiresFof?: boolean
}
interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  badgeKey?: 'review' | 'settings' | 'notes' | 'pendingActions'
  adminOnly?: boolean
  featureKey?: FeatureKey
  /** Only where the featureKey can't imply it (or there is no featureKey). */
  domain?: Domain
  beta?: boolean
  children?: NavChild[]
}

/**
 * Can this user reach this nav entry? Answered by the SAME resolver the middleware applies to the
 * API behind it, given the entry's OWN feature key.
 *
 * That last part is the whole trick. This used to consult a precomputed level per domain — but
 * that map had to pick one feature key per domain, and several span more than one. A fund with
 * `lps: admin` + `lp_tracking: everyone` hid Capital accounts from a member who could open the
 * page and whose API calls returned 200, because the map answered for `lps` and the entry meant
 * `lp_tracking`.
 *
 * The nav is an affordance, not a boundary — but it must not LIE. A link to a page whose every
 * request 403s is worse than no link, and a link to data the user shouldn't have is worse still.
 */
export function canSee(
  entry: { adminOnly?: boolean; featureKey?: FeatureKey; domain?: Domain },
  isAdmin: boolean,
  access: (domain: Domain, feature?: FeatureKey) => AccessLevel,
): boolean {
  if (entry.adminOnly && !isAdmin) return false

  const domain = entry.domain ?? (entry.featureKey ? domainForFeature(entry.featureKey) : undefined)
  // No domain and no feature: an always-available entry (Settings, Support).
  if (!domain) return true

  const level = access(domain, entry.featureKey)
  return level === 'read' || level === 'write'
}

const NAV_ITEMS: NavItem[] = [
  { href: '/review', label: 'Review', icon: ClipboardCheck, badgeKey: 'review', domain: 'portfolio' },
  // Admin-only, and — like Review — only shown when there's something waiting (badgeKey hides it
  // at zero). The list still filters rows by per-domain access; members reach theirs via the API/URL.
  { href: '/pending-actions', label: 'Pending Actions', icon: ListChecks, domain: 'portfolio', adminOnly: true, badgeKey: 'pendingActions' },
  // Portfolio, not dealflow — the mailbox is where portfolio updates arrive and where the review
  // queue's emails live, so gating it on the Deals product hid the only page that can reprocess an
  // email from every fund running Portfolio Reporting alone. Deal-specific actions inside it gate
  // themselves. See ROUTE_DOMAINS['api/emails'].
  // The landing page. No domain and no feature key: it is the app's front door, and a member with
  // no grants still has to be able to reach it. What it OFFERS is filtered per-grant inside the
  // page (lib/start/quick-actions.ts).
  { href: '/start', label: 'Start', icon: Sparkles },
  { href: '/emails', label: 'Inbound', icon: Mail, domain: 'portfolio' },
  { href: '/deals', label: 'Deals', icon: Lightbulb, featureKey: 'deals' },
  {
    href: '/diligence', label: 'Diligence', icon: Microscope, featureKey: 'diligence',
    children: [
      { href: '/diligence/inbox',     label: 'Inbox' },
      { href: '/diligence/analytics', label: 'Analytics', adminOnly: true },
    ],
  },
  {
    href: '/dashboard', label: 'Portfolio', icon: Building2, domain: 'portfolio',
    children: [
      { href: '/import',       label: 'Import',       featureKey: 'imports' },
      { href: '/investments',  label: 'Investments',  featureKey: 'investments' },
      // One fund's or SPV's holdings — companies, funds, digital assets. A portfolio view, so it
      // lives here rather than with the entities' books.
      { href: '/portfolio',    label: 'Holdings by entity', featureKey: 'investments' },
      { href: '/fund-holdings', label: 'Underlying funds', featureKey: 'investments', requiresFof: true },
      { href: '/requests',     label: 'Asks',         featureKey: 'asks' },
      { href: '/interactions', label: 'Interactions', featureKey: 'interactions' },
      // What companies reported, searchable: the Company Updates corpus. Plain portfolio — it has
      // no feature switch of its own because it IS the reporting product's evidence layer.
      { href: '/company-updates', label: 'Updates', domain: 'portfolio' },
      // Letters are generated from PORTFOLIO data (the companies) and can be produced without
      // any LP tracking, so they live under Portfolio, not LPs.
      { href: '/letters',      label: 'Letters',      featureKey: 'lp_letters' },
      // Notes are about companies, so they belong under the portfolio rather than as a
      // top-level peer of it.
      { href: '/notes',        label: 'Notes',        featureKey: 'notes', badgeKey: 'notes' },
      { href: '/compliance',   label: 'Compliance',   featureKey: 'compliance' },
    ],
  },
  {
    href: '/lps', label: 'LPs', icon: Crown, featureKey: 'lps',
    children: [
      { href: '/lps/capital',   label: 'Capital accounts', featureKey: 'lp_tracking' },
      { href: '/lp-portal',     label: 'Documents',        featureKey: 'lp_portal' },
      // See the portal exactly as an LP does ("viewing as …"). Admin-only, and only where a
      // portal exists to preview.
      { href: '/lps/preview',   label: 'Preview portal',   featureKey: 'lp_portal', adminOnly: true },
      { href: '/lp-activity',   label: 'Activity',         featureKey: 'lp_activity' },
    ],
  },
  {
    // "Entities", not "Funds", because it is every entity the firm keeps books for — funds,
    // SPVs, GP entities, individuals AND the management company. The manco had a section of its
    // own while its pages were a parallel copy of these ones; they are the same pages now, so it
    // is one more kind of row. What it is NOT is one more grant: `requireVehicleAccess` still
    // refuses a management company to a caller holding only `accounting`, because the boundary
    // was always the entity's kind rather than the URL prefix.
    //
    // No `adminOnly` — the featureKey already gates it (defaults to 'off', and a fund
    // that turns it on to 'admin' still only shows it to admins). Hard-coding adminOnly
    // on top of that also hid it from the read-only demo viewer, who should see the books.
    href: '/funds', label: 'Entities', icon: BookOpen, featureKey: 'accounting',
    children: ACCOUNTING_SECTIONS.map(({ href, label, domain, requiresFof, feature }) => ({ href, label, domain, requiresFof, featureKey: feature })),
  },
  { href: '/usage', label: 'Usage', icon: Users, adminOnly: true, domain: 'admin' },
  { href: '/settings', label: 'Settings', icon: Settings, badgeKey: 'settings' },
  { href: '/support', label: 'Support', icon: LifeBuoy },
]

/**
 * What a phone's tab bar offers, in preference order.
 *
 * A phone does not get this sidebar. It gets four destinations across the bottom of
 * the screen plus a "More" button that opens the sidebar in a drawer — because a
 * sidebar is a poor fit for the shape of the device and worse for the shape of an
 * installed app. It is twenty-odd rows deep, which on a phone is a full screen and a
 * half; it sits behind a control in the TOP-LEFT corner, the hardest place on a
 * handset to reach; and every navigation costs two taps. In a standalone PWA there is
 * also no browser chrome to fall back on, so a menu you cannot reach is a dead end
 * rather than an inconvenience.
 *
 * Four is the count both platforms' own tab bars settle on once a "More" affordance
 * takes the fifth slot, and it is about as many labels as fit legibly across a narrow
 * screen.
 *
 * The list is a PREFERENCE, not a fixed bar: entries the user cannot see are dropped
 * (same canSee as the sidebar — the tab bar must not offer a page whose every request
 * 403s), and the bar is then topped up from the rest of NAV_ITEMS so a fund running an
 * unusual mix of features still gets a full bar rather than two tabs and a gap.
 */
const MOBILE_TAB_HREFS = ['/dashboard', '/emails', '/lps', '/funds', '/deals', '/diligence', '/review'] as const

/** Slots before "More" takes the last one. */
export const MOBILE_TAB_COUNT = 4

export function mobileTabsFor(
  isAdmin: boolean,
  access: (domain: Domain, feature?: FeatureKey) => AccessLevel,
): NavItem[] {
  const byHref = new Map(NAV_ITEMS.map(item => [item.href, item]))
  const preferred = MOBILE_TAB_HREFS.map(href => byHref.get(href)).filter((i): i is NavItem => !!i)
  const rest = NAV_ITEMS.filter(item => !preferred.includes(item))
  return [...preferred, ...rest].filter(item => canSee(item, isAdmin, access)).slice(0, MOBILE_TAB_COUNT)
}

/**
 * Is `pathname` inside this nav item's section?
 *
 * Children are checked as well as the item itself, because half the sections keep
 * theirs at unrelated paths — Portfolio's children are /investments, /notes, /letters
 * — so a prefix match on the parent alone would leave the bar showing nothing selected
 * across most of the app. This is deliberately looser than the sidebar's exact match:
 * a tab bar is answering "which part of the app am I in", not "which row am I on".
 */
export function navItemMatches(item: NavItem, pathname: string): boolean {
  const under = (href: string) => pathname === href || pathname.startsWith(href + '/')
  return under(item.href) || (item.children ?? []).some(child => under(child.href))
}

/**
 * Every top-level section this user can see, in nav order.
 *
 * Shared by the desktop aside and the phone's "More" sheet so the two cannot answer
 * the access question differently — the sheet is no longer the sidebar rendered in a
 * drawer, so without this it would be a second list to keep in step.
 *
 * The badge counts are here because two entries are conditional on having something
 * waiting: Review and Pending Actions are noise at zero, and Pending Actions in
 * particular is an empty page most days.
 */
export function navSectionsFor(
  isAdmin: boolean,
  access: (domain: Domain, feature?: FeatureKey) => AccessLevel,
  badges: { review?: number; pendingActions?: number } = {},
): NavItem[] {
  return NAV_ITEMS.filter(item => {
    if (!canSee(item, isAdmin, access)) return false
    if (item.badgeKey === 'review' && (badges.review ?? 0) === 0) return false
    if (item.badgeKey === 'pendingActions' && (badges.pendingActions ?? 0) === 0) return false
    return true
  })
}

/**
 * What the phone's "More" sheet lists: every section the user can see that the tab bar
 * is not already showing.
 *
 * The split lives here rather than in the sheet so the two halves of the phone's nav
 * are computed from one list in one place — a destination that is in neither half is
 * unreachable on a handset, and in a standalone window there is no address bar to fall
 * back on. tests/mobile-nav-tabs.test.ts pins the two halves as disjoint and complete.
 */
export function moreSectionsFor(
  isAdmin: boolean,
  access: (domain: Domain, feature?: FeatureKey) => AccessLevel,
  tabHrefs: string[],
  badges: { review?: number; pendingActions?: number } = {},
): NavItem[] {
  const inBar = new Set(tabHrefs)
  return navSectionsFor(isAdmin, access, badges).filter(item => !inBar.has(item.href))
}

/**
 * The Funds section's children. Two shapes, decided by the URL alone:
 *
 *   - Inside a fund (/funds/<id>/…): fund-first — every child points at /funds/<id>/<page>, with
 *     an "Overview" entry for the fund's lead page, and the pages the vehicle's kind has no use
 *     for left out.
 *   - Anywhere else: firm-wide — every child points at /funds/<page>, the landing that lists
 *     every entity and asks which one you mean.
 *
 * It used to fall back to the vehicle the browser last had in context, which made the subnav a
 * guess: after a visit to a management company the context WAS the manco, so "Funds → Bank" led
 * to the manco's bank page. The URL is the only thing the user can see, so it is the only input.
 */
export function fundsChildrenFor(fundSeg: string | null, fofActive: boolean, kind: string | null = null): NavChild[] {
  const sections = sectionsForKind(ACCOUNTING_SECTIONS, fundSeg ? kind : null).filter(s => !s.requiresFof || fofActive)
  const children: NavChild[] = sections.map(s => ({
    href: fundSeg ? `/funds/${fundSeg}/${s.href.slice('/funds/'.length)}` : s.href,
    label: s.label,
    domain: s.domain,
    featureKey: s.feature,
  }))
  return fundSeg ? [{ href: `/funds/${fundSeg}`, label: 'Overview', exact: true }, ...children] : children
}

/**
 * The children of one section this user can see — the admin gate, the per-feature
 * visibility, and the fund-of-funds pages that only exist once the fund holds a fund.
 */
export function visibleChildrenFor(
  item: NavItem,
  isAdmin: boolean,
  access: (domain: Domain, feature?: FeatureKey) => AccessLevel,
  opts: { fofActive?: boolean; fundSeg?: string | null; kind?: string | null } = {},
): NavChild[] {
  const children = item.href === '/funds'
    ? fundsChildrenFor(opts.fundSeg ?? null, !!opts.fofActive, opts.kind ?? null)
    : item.children
  return (children ?? [])
    .filter(c => canSee(c, isAdmin, access))
    .filter(c => !c.requiresFof || !!opts.fofActive)
}

/**
 * Which fund the Funds subnav points at: the one in the URL when we are under a fund, else
 * none — and none means the firm-wide pages, not a guess from the vehicle context. See
 * fundsChildrenFor for why the context is deliberately not consulted here.
 */
export function fundSegFromPath(pathname: string): string | null {
  const fundMatch = pathname.match(/^\/funds\/([^/]+)/)
  return fundMatch && !FUND_SUBPAGE_SLUGS.has(fundMatch[1]) ? fundMatch[1] : null
}

export function useFundSeg(): string | null {
  return fundSegFromPath(usePathname())
}

export type { NavItem, NavChild }

interface AppSidebarProps {
  reviewBadge: number
  settingsBadge?: number
  notesBadge?: number
  pendingActionsBadge?: number
  isAdmin?: boolean
  updateAvailable?: boolean
  featureVisibility?: FeatureVisibilityMap
  /** Derived, not a setting: true when the fund holds at least one fund. */
  fofActive?: boolean
  /**
   * Rendered inside the phone's drawer rather than as the desktop aside.
   *
   * It forces `collapsed` off. Collapsing is a DESKTOP preference — it trades labels
   * for horizontal room in a 224px column — but it was read straight from context
   * here, and `showChildren` is gated on it. So a user who had collapsed the sidebar
   * at their desk opened the app on a phone, where there is no aside and nothing to
   * collapse, and found every sub-page missing from the menu: no Investments, no
   * Capital accounts, no ledger. The drawer is 288px of a screen with nothing beside
   * it, so there is nothing for collapsing to buy here.
   */
  mobile?: boolean
  onNavigate?: () => void
}

export function AppSidebar({ reviewBadge, settingsBadge, notesBadge, pendingActionsBadge, isAdmin, updateAvailable, featureVisibility, fofActive, mobile, onNavigate }: AppSidebarProps) {
  const pathname = usePathname()
  const access = useAccess()
  const { collapsed: collapsedPref, toggle } = useSidebar()
  const collapsed = collapsedPref && !mobile
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // The Funds subnav is fund-first inside a fund and firm-wide elsewhere — see useFundSeg /
  // fundsChildrenFor above. Inside a fund it shows the pages that vehicle's KIND has a use for
  // (lib/accounting/nav.ts hideFor); the kind comes from the context the fund pages pin to
  // their URL, and fundsChildrenFor ignores it whenever there is no fund in the URL.
  const fundSeg = useFundSeg()
  const { kind: vehicleKind } = useVehicle()

  const currentTheme = (THEME_CYCLE.includes(theme as typeof THEME_CYCLE[number]) ? theme : 'system') as typeof THEME_CYCLE[number]
  const ThemeIcon = mounted ? THEME_ICONS[currentTheme] : Monitor
  const themeLabel = mounted ? THEME_LABELS[currentTheme] : 'System'

  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(currentTheme)
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  return (
    <div className="flex flex-col flex-1">
      <nav className={`flex-1 p-2 space-y-0.5 ${collapsed ? 'md:px-1' : ''}`}>
        {navSectionsFor(!!isAdmin, access, { review: reviewBadge, pendingActions: pendingActionsBadge }).map((item) => {
          const { href, label, icon: Icon, badgeKey, adminOnly, featureKey, beta } = item
          // The parent row is highlighted ONLY when it is the exact current page — never
          // merely because a child is open. Otherwise the highlight was inconsistent: Funds
          // (/funds) and Diligence (/diligence) nest their children under their own path, so a
          // prefix match lit the parent AND the child (two "you are here" pills at once),
          // while Portfolio — whose children live at unrelated paths like /investments — never
          // lit the parent. Exact-match makes every section behave the same: one pill, on the
          // page you're actually on, with section context coming from the expanded children.
          const isActive = pathname === href
          const badgeCount = badgeKey === 'review' ? reviewBadge
            : badgeKey === 'pendingActions' ? (pendingActionsBadge ?? 0)
            : badgeKey === 'settings' ? (settingsBadge ?? 0)
            : badgeKey === 'notes' ? (notesBadge ?? 0)
            : 0
          const showLock = adminOnly || (featureKey && featureVisibility?.[featureKey] === 'admin')

          // Children visibility — the shared resolver drops what the user can't access
          // (admin gate, per-feature visibility) and the fund-of-funds pages that only
          // exist once the fund holds a fund. Shown only when the parent or any visible
          // child route is active.
          const visibleChildren = visibleChildrenFor(item, !!isAdmin, access, { fofActive, fundSeg, kind: vehicleKind })
          const childActive = visibleChildren.some(c => pathname === c.href || pathname.startsWith(c.href + '/'))
          // Also keep the section open on any page UNDER its own path (e.g. /funds/allocation-terms,
          // a Funds page that isn't a listed child) — it's still this section, just not in the nav.
          const underSection = pathname.startsWith(href + '/')
          const showChildren = !collapsed && visibleChildren.length > 0 && (isActive || childActive || underSection)

          return (
            <div key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                title={collapsed ? label : undefined}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${ collapsed ? 'md:justify-center md:px-0' : '' } ${ isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent' }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className={`${collapsed ? 'md:hidden' : ''}`}>{label}</span>
                {badgeCount > 0 && (
                  collapsed ? (
                    <span className="hidden md:block absolute top-1 right-1 h-2 w-2 rounded-full bg-warning" />
                  ) : (
                    <span className="rounded-full bg-warning text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px] text-center">
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )
                )}
                {beta && !showLock && (
                  collapsed ? (
                    <span className="hidden md:block absolute top-1 right-1 h-2 w-2 rounded-full bg-info" />
                  ) : (
                    <span className="text-[9px] font-medium text-info bg-info/10 rounded px-1 py-0.5 leading-none uppercase tracking-wider self-center">beta</span>
                  )
                )}
                {showLock && !beta && !collapsed && (
                  <Lock className="h-3 w-3 text-warning shrink-0 md:block hidden" />
                )}
                {showLock && !beta && collapsed && (
                  <span className="hidden md:block absolute top-1 right-1">
                    <Lock className="h-2.5 w-2.5 text-warning" />
                  </span>
                )}
                {beta && showLock && !collapsed && (
                  <>
                    <span className="text-[9px] font-medium text-info bg-info/10 rounded px-1 py-0.5 leading-none uppercase tracking-wider self-center hidden md:inline">beta</span>
                    <Lock className="h-3 w-3 text-warning shrink-0 md:block hidden" />
                  </>
                )}
                {beta && showLock && collapsed && (
                  <span className="hidden md:block absolute top-1 right-1">
                    <Lock className="h-2.5 w-2.5 text-info" />
                  </span>
                )}
              </Link>

              {showChildren && (
                <div className="ml-5 border-l border-border pl-2 mt-0.5 space-y-0.5">
                  {visibleChildren.map(child => {
                    const childIsActive = child.exact
                      ? pathname === child.href
                      : pathname === child.href || pathname.startsWith(child.href + '/')
                    const childShowLock = child.adminOnly || (child.featureKey && featureVisibility?.[child.featureKey] === 'admin')
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        onClick={onNavigate}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${ childIsActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent' }`}
                      >
                        <span>{child.label}</span>
                        {childShowLock && <Lock className="h-3 w-3 text-warning shrink-0" />}
                        {child.badgeKey === 'notes' && (notesBadge ?? 0) > 0 && (
                          <span className="ml-auto text-[10px] font-medium rounded-full bg-muted-foreground/15 px-1.5 py-0.5 tabular-nums">
                            {notesBadge}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Update available, admin only */}
        {isAdmin && updateAvailable && (() => {
          const isActive = pathname === '/updates' || pathname.startsWith('/updates/')
          return (
            <Link
              href="/updates"
              onClick={onNavigate}
              title={collapsed ? 'Updates' : undefined}
              className={`relative flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${ collapsed ? 'md:justify-center md:px-0' : '' } ${ isActive ? 'bg-accent text-foreground font-medium' : 'text-warning dark:text-warning hover:text-foreground hover:bg-accent' }`}
            >
              <ArrowDownCircle className="h-5 w-5 shrink-0" />
              <span className={`${collapsed ? 'md:hidden' : ''}`}>Updates</span>
              {collapsed ? (
                <span className="hidden md:block absolute top-1 right-1 h-2 w-2 rounded-full bg-warning" />
              ) : (
                <span className="h-2 w-2 rounded-full bg-warning shrink-0" />
              )}
            </Link>
          )
        })()}

        {/* Theme toggle */}
        <button
          onClick={cycleTheme}
          title={collapsed ? themeLabel : undefined}
          className={`flex w-full items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent ${ collapsed ? 'md:justify-center md:px-0' : '' }`}
        >
          <ThemeIcon className="h-5 w-5 shrink-0" />
          <span className={`flex-1 text-left ${collapsed ? 'md:hidden' : ''}`}>
            {themeLabel}
          </span>
        </button>

        {/* Hide Sidebar toggle, only shown on desktop */}
        <button
          onClick={toggle}
          title={collapsed ? 'Show Sidebar' : 'Hide Sidebar'}
          className={`hidden md:flex w-full items-center gap-3 px-3 py-2 rounded-md text-xs transition-colors text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent ${ collapsed ? 'md:justify-center md:px-0' : '' }`}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5 shrink-0" />
          ) : (
            <PanelLeftClose className="h-5 w-5 shrink-0" />
          )}
          <span className={`flex-1 text-left ${collapsed ? 'md:hidden' : ''}`}>
            {collapsed ? 'Show Sidebar' : 'Hide Sidebar'}
          </span>
        </button>
      </nav>
    </div>
  )
}

