// Which domain every PAGE belongs to — the server-component counterpart of ROUTE_DOMAINS.
//
// The API registry closed one hole and left its twin open. `gateApiRequest` resolves every /api
// request before the handler runs, so a route cannot serve data it hasn't earned. A server
// component makes no API request: it queries Postgres itself, often with the ADMIN client, and
// renders the result. The middleware never sees it. So "the page is only an affordance, the API is
// the boundary" is true right up until the page IS the thing serving the data — and then the only
// gate is the one the page remembers to call.
//
// It was remembered on 11 pages of 24. /emails/[id] rendered a whole message body (raw_payload
// included) to any member with the URL; /deals and /deals/[id] rendered founder pitches with the
// service-role client, in funds where the Deals product is off by default. Both were reachable
// while the sidebar correctly hid them — the exact "hidden means hidden" failure the access model
// was written to end.
//
// page-domains.test.ts is what makes this stick: every server component under app/(app) must be
// mapped here (and actually call the gate it claims) or listed in UNGATED_PAGES with a reason.
//
// Client pages are absent on purpose. They render no fund data on the server — everything they
// show arrives through an /api call the middleware already gated — so there is nothing here for
// them to declare. If one is later converted to a server component, it stops being a client page
// and the test starts asking.
//
// See plans/plan-access-control.md.

import type { Domain } from './domains'
import type { FeatureKey } from '@/lib/types/features'

export interface PageDomain {
  domain: Domain
  /** Overrides the domain's primary switch, exactly as in ROUTE_DOMAINS. */
  feature?: FeatureKey
  /**
   * The gate this page calls, when it isn't the standard `canViewPage(page, '<domain>')`.
   * Section guards resolve the same context for a whole subtree.
   */
  gate?: 'requireAccountingAccess' | 'requireVehicleAccess'
}

/** Keyed by path under app/(app), without the trailing /page.tsx. */
export const PAGE_DOMAINS: Record<string, PageDomain> = {
  // ── Portfolio ──────────────────────────────────────────────────────────────
  'dashboard': { domain: 'portfolio' },
  // The company page: the panels inside it (notes, interactions, investments) each ask for their
  // own domain, but the company and its metrics are portfolio.
  'companies/[id]': { domain: 'portfolio' },
  // Portfolio update search — the Company Updates corpus (reporting email), not the mailbox.
  'company-updates': { domain: 'portfolio' },
  // The mailbox is portfolio intake, not deal flow — see ROUTE_DOMAINS['api/emails'].
  'emails/[id]': { domain: 'portfolio' },

  // ── Relationships ──────────────────────────────────────────────────────────
  'interactions': { domain: 'relationships', feature: 'interactions' },

  // ── Deal flow ──────────────────────────────────────────────────────────────
  'deals': { domain: 'dealflow' },
  'deals/[id]': { domain: 'dealflow' },

  // ── Diligence ──────────────────────────────────────────────────────────────
  'diligence': { domain: 'diligence' },
  'diligence/[id]': { domain: 'diligence' },
  'diligence/[id]/qa': { domain: 'diligence' },
  'diligence/[id]/drafts/[draftId]': { domain: 'diligence' },
  'diligence/analytics': { domain: 'diligence' },
  'diligence/inbox': { domain: 'diligence' },
  // The memo agent's configuration IS diligence configuration: rubric, Q&A library, style anchors.
  'settings/memo-agent/defaults': { domain: 'diligence' },
  'settings/memo-agent/schemas': { domain: 'diligence' },
  'settings/memo-agent/schemas/[name]': { domain: 'diligence' },
  'settings/memo-agent/style-anchors': { domain: 'diligence' },
  'settings/memo-agent/style-anchors/[id]': { domain: 'diligence' },

  // ── LP reporting ───────────────────────────────────────────────────────────
  'lps/capital': { domain: 'lp_capital', feature: 'lp_tracking' },
  'lp-portal': { domain: 'lp_relations', feature: 'lp_portal' },
  'lp-activity': { domain: 'lp_relations', feature: 'lp_activity' },

  // ── Fund accounting ────────────────────────────────────────────────────────
  // The whole section shares one guard (app/(app)/funds/guard.ts), which resolves the caller and
  // redirects before any page body runs.
  //
  // It resolves through canViewPage like every other gate here. It used to compare roles instead
  // (admin|viewer, grant ignored), which meant a member granted accounting write was served by
  // every accounting API and redirected off every accounting page — pinned against now by
  // tests/route-gates-honour-grants.test.ts.
  'funds': { domain: 'accounting', gate: 'requireAccountingAccess' },
  // Three pages in one route, and the domain recorded here is what they share — `accounting`,
  // the minimum to open any of them:
  //   - a section slug in the `[id]` slot is the firm-wide landing (requireAccountingAccess),
  //   - an entity id is that entity's lead page (requireVehicleAccess),
  //   - and when that entity is a MANAGEMENT COMPANY the gate demands `management_company` too.
  // The registry maps one domain per page; the second half of a page that straddles two is gated
  // in the page's own path, which for every entity page is app/(app)/funds/guard.ts.
  'funds/[id]': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/bank': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/capital-accounts': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/construction': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/capital-accounts/[lpEntityId]': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/journal': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/ledger': { domain: 'accounting', gate: 'requireVehicleAccess' },
  // Gated in the page itself on the domain AND the tax_reporting feature: every route behind it
  // is feature-gated, so the page must not render when the feature is off.
  'funds/[id]/tax': { domain: 'accounting', feature: 'tax_reporting', gate: 'requireVehicleAccess' },
  'funds/[id]/migrate': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/opening-balances': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/periods': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/schedule-of-investments': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/statements': { domain: 'accounting', gate: 'requireVehicleAccess' },
  'funds/[id]/status': { domain: 'accounting', gate: 'requireVehicleAccess' },

  // ── Administration ─────────────────────────────────────────────────────────
  'usage': { domain: 'admin' },
  'updates': { domain: 'admin' },
}

/**
 * Server components that need no gate, each with the reason. A page qualifies only if it renders
 * NO fund data server-side: a redirect, or a document. "The nav hides it" is not a reason — that
 * was the bug.
 */
export const UNGATED_PAGES: Record<string, string> = {
  'accounting/[[...rest]]': 'Pure redirect to /funds for old deep links. Renders nothing.',
  'companies': 'Pure redirect to /dashboard. Renders nothing.',
  'funds/[id]/text': 'Pure redirect to the journal page’s plain-text tab. Renders nothing; the journal page gates.',
  'manco/[[...rest]]': 'Pure redirect into /funds — management companies are entities in that section now. Renders nothing.',
  'lps/live': 'Pure redirect to /lps — the live report became the LPs landing page.',
  'support': 'Static product documentation. No fund data, no queries, same for every reader.',
}
