// The accounting section's navigation — the single source of truth for both the
// sidebar (labels only) and the /funds hub page (icons + descriptions).
// Add a route here and it appears in both; there is nowhere else to add it.

import {
  Landmark, Users, ScrollText, Gauge,
  Lock, Layers, FileText, Target, Table2, Upload, ClipboardList, Settings2, TrendingUp,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { VehicleKind } from '@/lib/vehicle-kinds'

/** The sections a vehicle of `kind` shows. Null kind (a legacy vehicle) shows a fund's. */
export function sectionsForKind(sections: AccountingSection[], kind: string | null | undefined): AccountingSection[] {
  return sections.filter(s => !s.hideFor || !kind || !s.hideFor.includes(kind as VehicleKind))
}

export interface AccountingSection {
  href: string
  label: string
  icon: LucideIcon
  desc: string
  /**
   * The access domain this page needs, where it isn't plain `accounting`. The section is one nav
   * group but not one content area: capital accounts are LP identities and commitments, which a
   * member who reconciles the bank isn't thereby entitled to. Omitted = accounting.
   */
  domain?: Domain
  /** A feature switch the page needs on top of its domain (tax reporting ships off). */
  feature?: FeatureKey
  /**
   * Vehicle kinds this page is hidden for — the ones it has no meaning on. An individual has no
   * capital accounts or portfolio to construct; a GP entity has no schedule of investments.
   * Hidden means hidden from the nav; the page itself still gates on access and renders what
   * the data supports, so a URL is not a hole.
   */
  hideFor?: VehicleKind[]
  /** Only for a fund of funds — DERIVED from the data (at least one holding is a fund),
   *  never a setting. Consumers filter on it; see lib/portfolio/fof.ts. */
  requiresFof?: boolean
}

export const ACCOUNTING_SECTIONS: AccountingSection[] = [
  {
    href: '/funds/status',
    label: 'Admin',
    icon: Gauge,
    desc: 'Current status and admin settings.',
  },
  {
    href: '/funds/bank',
    label: 'Bank transactions',
    icon: Landmark,
    desc: 'Import a transaction feed (XLSX, CSV, Ramp, QuickBooks), auto-draft entries, and create journal entries.',
  },
  {
    href: '/funds/capital-accounts',
    label: 'Capital accounts',
    icon: Users,
    desc: "Per-partner roll-forward and commitments, plus called and unfunded. Issue capital calls and publish LP capital statements.",
    // Named partners and their commitments — the same tier as the LPs section, reached from here.
    domain: 'lp_capital',
    hideFor: ['individual', 'manco'],
  },
  // /funds/lp-events redirects to capital accounts. Reported balances are maintained
  // alongside accounting evidence and do not need a separate navigation destination.
  {
    href: '/funds/journal',
    label: 'Journal',
    icon: ScrollText,
    desc: 'Plain-text double-entry journal entries. Create, view, unpost, and edit all journal entries.',
  },
  {
    href: '/funds/ledger',
    label: 'General ledger',
    icon: Table2,
    desc: 'One account at a time: the balance carried in, every posting with what it was booked against, and the running balance.',
  },
  // NOTE: /funds/text is deliberately NOT listed. Plain-text authoring is a TAB on the journal
  // page (?tab=text), not a destination of its own: it writes the same entries the journal
  // lists, and a second page for a second way of typing them was one more place to look.
  // NOTE: /funds/opening-balances is deliberately NOT listed. It only applies to
  // the "cutover" onboarding path, and is linked from the setup card there. On a
  // full-history vehicle, opening balances are derived from the reconstructed ledger —
  // entering them would double-count contributed capital.
  // NOTE: /funds/allocation-terms is deliberately NOT listed. It's configuration
  // you set once per vehicle (basis, commitments, who bears which category), not a
  // place you work — so it's linked from Admin, next to the health check that tells
  // you when it's wrong.
  {
    href: '/funds/periods',
    label: 'Close',
    icon: Lock,
    desc: "Close a period: allocate its income and expenses to each partner's capital account, snapshot the ledger, and lock the books. Reopen to reverse.",
  },
  // NOTE: /funds/fof-report is deliberately GONE. It re-derived, firm-wide and unscoped, what the
  // schedule of investments already shows per vehicle — see the fund section there, which now
  // carries commitment and unfunded for each underlying fund.
  // NOTE: /funds/migrate is deliberately NOT listed. Importing a QuickBooks general
  // ledger is a one-time event at the start of a vehicle's life, not a place you work —
  // so it's linked from Admin, alongside the rest of the onboarding.
  // NOTE: /funds/fof-quarter is deliberately GONE, like the fund-of-funds report before it. A
  // manager's quarterly statement is an update about ONE holding — the same shape as a company's
  // KPI update — so it is recorded on that holding, next to the NAV it reports and the mark it
  // implies. A quarter-wide sheet made it a separate ritual and a second place to look.
  {
    href: '/funds/schedule-of-investments',
    label: 'Schedule of investments',
    icon: Layers,
    desc: 'Each investment at cost and fair value, with its share of net assets.',
    hideFor: ['associate', 'manco'],
  },
  {
    href: '/funds/construction',
    label: 'Portfolio construction',
    icon: Target,
    desc: 'How much investable capital is left, how many more deals fit, and what exit the portfolio needs to return the fund.',
    // Any investing entity can forecast what its holdings have to return — an SPV's one deal, an
    // individual's angel book, a GP entity's fund stake. Only a management company, which holds
    // no portfolio at all, has nothing to construct.
    hideFor: ['manco'],
  },
  {
    href: '/funds/forecast',
    label: 'Forecast',
    icon: TrendingUp,
    desc: 'Monthly budgets and rolling forecasts beside the actuals, with P&L and cash by month, quarter or year.',
    feature: 'budgeting',
  },
  {
    href: '/funds/statements',
    label: 'Financial statements',
    icon: FileText,
    desc: 'Balance sheet, income statement, statement of cash flows, and statement of changes in partners capital.',
  },
  {
    href: '/funds/tax',
    label: 'Tax',
    icon: Landmark,
    desc: 'The year’s book-to-tax adjustments, adjusting entries, K-1 package, partner tax forms, and the tax package for the preparer.',
    feature: 'tax_reporting',
    hideFor: ['manco'],
  },
]

/**
 * The subpages a fund has that the nav does NOT list — reached from Admin or from a setup card,
 * but still a real `/funds/<id>/<slug>` page, and so still in need of a firm-wide landing that
 * says which vehicle you mean. Same shape as a section so the landing can name them the same way.
 */
export const UNLISTED_SECTIONS: AccountingSection[] = [
  { href: '/funds/migrate', label: 'QuickBooks import', icon: Upload, desc: 'Bring a vehicle\u2019s QuickBooks general ledger in as its opening history.' },
  { href: '/funds/opening-balances', label: 'Opening balances', icon: ClipboardList, desc: 'Book a vehicle\u2019s balances at its cutover date.' },
  { href: '/funds/allocation-terms', label: 'Allocation terms', icon: Settings2, desc: 'How a vehicle\u2019s income and expenses are shared between its partners.', domain: 'lp_capital' },
]

/** Does an entity of `kind` have the `/funds/<id>/<slug>` page? Unknown slugs are assumed real. */
export function hasSectionForKind(slug: string, kind: string | null | undefined): boolean {
  const s = sectionForSlug(slug)
  return !s || sectionsForKind([s], kind).length > 0
}

/** The section (listed or not) behind a `/funds/<slug>` URL segment, or null for an unknown slug. */
export function sectionForSlug(slug: string): AccountingSection | null {
  return [...ACCOUNTING_SECTIONS, ...UNLISTED_SECTIONS].find(s => s.href === `/funds/${slug}`) ?? null
}
