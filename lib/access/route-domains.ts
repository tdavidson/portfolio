// Which domain every API route belongs to, and what it takes to call it.
//
// This registry is the mechanism that makes access control hold. Before it, 137 of 263 routes
// checked only "are you in this fund" and never looked at role — not by decision, but because
// nothing made them. A declarative map plus the coverage test in route-domains.test.ts means a new
// route cannot ship without an answer: it is either mapped to a domain, or explicitly listed as
// ungated WITH A REASON. Discipline didn't hold this; the test does.
//
// See plans/plan-access-control.md.

import type { Domain } from './domains'
import type { AccessLevel } from './effective'
import type { FeatureKey } from '@/lib/types/features'

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * What a route can require. `none` is deliberately absent — a route requiring no access is an
 * ungated route, and those live in UNGATED_ROUTES with a reason.
 *
 * `any` = any member of the fund, no domain grant needed. The escape hatch, for routes that serve
 * a user their OWN data (their theme, their conversations) or that gate internally per domain (the
 * Analyst). Every use carries a comment saying which. It is not a synonym for "unimportant".
 */
export type RouteLevel = Exclude<AccessLevel, 'none'> | 'any'

export interface RouteAccess {
  domain: Domain
  /** Overrides the domain's primary switch — for domains spanning several feature keys. */
  feature?: FeatureKey
  /**
   * What the route needs. Omitted = derived from the method: GET/HEAD read, everything else write.
   * Set it where the method lies (a POST that only queries) or where reads and writes differ.
   */
  level?: RouteLevel | Partial<Record<Method, RouteLevel>>
}

/** Reads are reads; anything else changes something. Overridable per route above. */
export function requiredLevel(entry: RouteAccess, method: string): RouteLevel {
  const m = method.toUpperCase() as Method
  if (entry.level && typeof entry.level === 'object') {
    return entry.level[m] ?? defaultForMethod(m)
  }
  return entry.level ?? defaultForMethod(m)
}

function defaultForMethod(m: Method): RouteLevel {
  return m === 'GET' || m === 'HEAD' ? 'read' : 'write'
}

export const ROUTE_DOMAINS: Record<string, RouteAccess> = {
  // ── Fund accounting ────────────────────────────────────────────────────────
  'api/accounting/allocation-terms': { domain: 'accounting' },
  'api/accounting/assistant': { domain: 'accounting' },
  'api/accounting/bank': { domain: 'accounting' },
  'api/accounting/bank/auto-match': { domain: 'accounting' },
  'api/accounting/bank/categorize': { domain: 'accounting' },
  'api/accounting/bank/duplicates': { domain: 'accounting' },
  'api/accounting/bank/import': { domain: 'accounting' },
  'api/accounting/bank/match': { domain: 'accounting' },
  'api/accounting/bank/reconcile': { domain: 'accounting' },
  'api/accounting/bootstrap': { domain: 'accounting' },
  'api/accounting/chart': { domain: 'accounting' },
  'api/accounting/cutover': { domain: 'accounting' },
  'api/accounting/turn-on': { domain: 'accounting' },
  'api/accounting/investment-bank-match': { domain: 'accounting' },
  // GET reads the plan, PUT writes it — `requiredLevel` derives read/write from the method.
  'api/accounting/construction': { domain: 'accounting' },
  // Budget & forecast (plans/plan-budget-forecast.md). Each route file is its own key. The service
  // re-checks accounting + budgeting at the operation's level and the management_company grant for
  // a manco vehicle, so MCP and the Analyst get the same answer without this boundary.
  'api/accounting/forecast': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/[id]': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/[id]/publish': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/series': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/export': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/variance': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/forecast/fee-links': { domain: 'accounting', feature: 'budgeting' },
  'api/accounting/fund-economics': { domain: 'accounting' },
  // QuickBooks migration. `mapping/discover` is its own route file and therefore needs its
  // own entry — route-domains.test.ts matches on the route path, not on a prefix.
  'api/accounting/quickbooks/parse': { domain: 'accounting' },
  'api/accounting/quickbooks/mapping': { domain: 'accounting' },
  'api/accounting/quickbooks/mapping/discover': { domain: 'accounting' },
  'api/accounting/quickbooks/import': { domain: 'accounting' },
  'api/accounting/quickbooks/tie-out': { domain: 'accounting' },
  'api/accounting/fund-timeseries': { domain: 'accounting' },
  'api/accounting/investments': { domain: 'accounting' },
  'api/accounting/journal': { domain: 'accounting' },
  'api/accounting/journal/bulk-post': { domain: 'accounting' },
  'api/accounting/journal/bulk-void': { domain: 'accounting' },
  // The journal as a file (CSV, Excel, or QuickBooks' Journal layout) — a read of the same rows.
  'api/accounting/journal/export': { domain: 'accounting' },
  'api/accounting/chart/export': { domain: 'accounting' },
  'api/accounting/attribute-lp-capital': { domain: 'accounting' },
  // The standard entries (fee, expense, gain, distribution, carry) from their inputs —
  // the agent's allocation tool, reachable from the journal's New entry menu. POST → write.
  'api/accounting/allocation': { domain: 'accounting' },
  // The account register: the same posted ledger the statements read, one account at a time.
  'api/accounting/ledger': { domain: 'accounting' },
  'api/accounting/ledger-text': { domain: 'accounting' },
  'api/accounting/opening-balances': { domain: 'accounting' },
  'api/accounting/periods': { domain: 'accounting' },

  'api/accounting/statements': { domain: 'accounting' },
  // The Excel workpaper export ships the exact same computed package as the statements
  // route, so it carries the same domain (accounting implies lp_capital via DOMAIN_META).
  'api/accounting/statements/export': { domain: 'accounting' },
  'api/accounting/statements/pdf': { domain: 'accounting' },
  // Realized gains by lot — the Schedule D input; fund-level, no per-partner figure in it.
  'api/accounting/realized-gains': { domain: 'accounting' },
  // Vendors (the payee dimension) and cash paid per vendor — the 1099 worksheet.
  'api/accounting/vendors': { domain: 'accounting' },
  'api/accounting/vendor-payments': { domain: 'accounting' },
  // Every entity's books at a glance: closed through, trial balance, drafts, unmatched bank rows.
  // Management companies appear only for a caller holding that grant — checked in the handler.
  'api/accounting/firm': { domain: 'accounting' },
  // The year's preparer bundle. `accounting` opens it; the K-1 workbook inside is added only
  // after refuseWithoutCarryAccess passes in the handler, since a K-1 package contains the carry.
  'api/accounting/tax-package': { domain: 'accounting' },
  'api/accounting/status': { domain: 'accounting' },
  'api/accounting/vehicles': { domain: 'accounting' },
  'api/accounting/vehicle-index': { domain: 'accounting' },
  'api/accounting/vehicle-settings': { domain: 'accounting' },
  'api/accounting/vehicle-gp-links': { domain: 'accounting' },
  'api/vehicles': { domain: 'accounting' },

  // ── Management company ─────────────────────────────────────────────────────
  // The firm's own operating entity, on its own books. A separate domain from `accounting`
  // because a manco ledger carries firm payroll and partner compensation, and — unlike a K-1,
  // which is derived from the capital accounts — none of it is legible from the fund's books.
  // See DOMAIN_META.management_company.
  //
  // These four routes are the section's own. The shared ledger routes above (journal, bank,
  // statements, chart, periods) can ALSO serve a management company, and there the grant is
  // decided by the vehicle rather than the route: `resolveGroupOr400` refuses a manco to a caller
  // who holds only `accounting`. That is the one place in this registry where the mapping below is
  // a floor rather than the whole answer — see lib/accounting/vehicle-domain.ts.
  'api/manco/vehicles': { domain: 'management_company' },
  'api/manco/overview': { domain: 'management_company' },
  'api/manco/setup': { domain: 'management_company' },
  'api/manco/intercompany': { domain: 'management_company' },

  // ── GP economics — the carve-out. These used to sit behind the single `accounting` key,
  //    so anyone who could reconcile the bank could read the partners' carry.
  'api/accounting/deal-carry': { domain: 'gp_economics' },
  'api/accounting/gp-economics': { domain: 'gp_economics' },
  'api/accounting/waterfall-terms': { domain: 'gp_economics' },

  // ── LP capital: identities, commitments, capital accounts ──────────────────
  'api/accounting/capital-accounts': { domain: 'lp_capital' },
  'api/accounting/settlements': { domain: 'lp_capital' },
  'api/accounting/capital-calls': { domain: 'lp_capital' },
  // The outbound mirror of capital-calls, and the same per-partner capital data.
  'api/accounting/distributions': { domain: 'lp_capital' },
  'api/accounting/commitments': { domain: 'lp_capital' },
  'api/accounting/closings': { domain: 'lp_capital' },
  // Book-to-tax adjustments. `accounting` rather than `lp_capital`: the payload is fund-level
  // difference amounts and the entries they produce, not per-partner figures — the per-partner
  // split arrives with the K-1 allocation. Gated on `tax_reporting` so a fund keeping books but
  // not issuing K-1s never sees it.
  'api/accounting/tax-adjustments': { domain: 'accounting', feature: 'tax_reporting' },
  // Tax forms, unlike the adjustments above, are PER PARTNER — the payload is partner names,
  // legal names, countries and TIN last-fours. That is lp_capital data, and gating it as
  // `accounting` would let someone reconcile the bank read the partner register.
  'api/accounting/tax-forms': { domain: 'lp_capital', feature: 'tax_reporting' },
  // Per-partner K-1 lines and capital accounts — lp_capital for the same reason as tax-forms.
  // AND gp_economics, checked in-handler (lib/tax/access.ts): one of the partners is the GP, whose
  // K-1 is the carry by another name, and box 20AH is the carry recipient's recharacterised gain.
  // The same figure capital-accounts withholds from an lp_capital-only caller. The registry maps
  // one domain; the payload straddles two; the handler gates the second. Applies to k1-packages,
  // its export and pdf, and state-worklist, which reports per-partner allocated income.
  'api/accounting/k1-packages': { domain: 'lp_capital', feature: 'tax_reporting' },
  // Read-level: exporting reports what the package already holds, it does not generate.
  'api/accounting/k1-packages/export': { domain: 'lp_capital', feature: 'tax_reporting', level: 'read' },
  // One partner's figures as a PDF — the same per-partner data, read-level.
  'api/accounting/k1-packages/pdf': { domain: 'lp_capital', feature: 'tax_reporting', level: 'read' },
  // Furnishing, and the consent that makes electronic furnishing valid. Per partner.
  'api/accounting/k1-deliveries': { domain: 'lp_capital', feature: 'tax_reporting' },
  // Which states have partners, and how much was allocated to each. Per-partner residence and
  // income, so lp_capital.
  'api/accounting/state-worklist': { domain: 'lp_capital', feature: 'tax_reporting', level: 'read' },
  // The tax book's lock. `accounting` rather than `lp_capital`: closing a year is a books
  // operation and its payload is state and blockers, not per-partner figures.
  'api/accounting/tax-year': { domain: 'accounting', feature: 'tax_reporting' },
  // Which underlying funds still owe us a K-1. Portfolio-level holdings, not partner data.
  'api/accounting/received-k1s': { domain: 'accounting', feature: 'tax_reporting' },
  'api/accounting/entities': { domain: 'lp_capital' },
  'api/accounting/lp-events': { domain: 'lp_capital' },
  'api/accounting/lp-events/import': { domain: 'lp_capital' },
  'api/accounting/lp-statement': { domain: 'lp_capital' },
  'api/accounting/lp-statement/pdf': { domain: 'lp_capital' },
  'api/accounting/lps': { domain: 'lp_capital' },
  // Returns each partner's ledger capital account WITH their name, to diff against the
  // administrator's figures. The `reconcile` tool is gated the same way.
  'api/accounting/reconciliation': { domain: 'lp_capital' },
  'api/accounting/positions': { domain: 'lp_capital', feature: 'lp_tracking' },
  'api/accounting/positions/import': { domain: 'lp_capital', feature: 'lp_tracking' },
  'api/lps/entities': { domain: 'lp_capital' },
  'api/lps/entities/profile': { domain: 'lp_capital' },
  'api/lps/export/excel': { domain: 'lp_capital' },
  'api/lps/export/pdf': { domain: 'lp_capital' },
  'api/lps/import': { domain: 'lp_capital' },
  'api/lps/investments': { domain: 'lp_capital' },
  'api/lps/investor-groups': { domain: 'lp_capital' },
  'api/lps/investors': { domain: 'lp_capital' },
  'api/lps/live-cards': { domain: 'lp_capital' },
  'api/lps/live-report': { domain: 'lp_capital' },
  'api/lps/live-settings': { domain: 'lp_capital' },
  'api/lps/snapshots': { domain: 'lp_capital' },
  'api/lps/snapshots/from-live': { domain: 'lp_capital' },
  'api/lps/vehicles': { domain: 'lp_capital' },

  // ── LP relations: what goes OUT to LPs, and the record of them reading it ──
  //    Sharing is the sensitive verb here, so the share routes sit here rather than with the
  //    capital data they happen to share.
  'api/accounting/lp-statement/publish': { domain: 'lp_relations', feature: 'lp_portal' },
  // Call and distribution notices go OUT to partners, same as a published statement.
  'api/accounting/notices/publish': { domain: 'lp_relations', feature: 'lp_portal' },
  // A receipt for a funded call line goes out the same way a notice does.
  'api/accounting/notices/receipt': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/live-report/share': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/snapshots/[id]/share': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/authorized-users': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/documents': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/documents/upload-url': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/invites': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/invites/bulk': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/invites/resend': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding/request': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding/sort': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding/sort/confirm': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding/facts': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/onboarding/history': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/messages': { domain: 'lp_relations', feature: 'lp_portal' },
  // The delivery log: which LP was emailed which notice, statement, letter or document.
  'api/lps/deliveries': { domain: 'lp_relations', feature: 'lp_portal' },
  // A plain message to chosen LPs, with nothing attached: the same send path as a document.
  'api/lps/announce': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/send': { domain: 'lp_relations', feature: 'lp_portal' },
  // "View as LP" renders a NAMED investor's own capital position — commitment, paid-in,
  // distributions, NAV — and the statement PDF renders the whole thing. That is lp_capital data
  // wearing the portal's chrome, so it takes the lp_capital grant (still behind the lp_portal
  // switch). Gating it as lp_relations let anyone who merely sends LP letters read the register.
  'api/lps/preview': { domain: 'lp_capital', feature: 'lp_portal' },
  'api/lps/preview/document/[id]': { domain: 'lp_relations', feature: 'lp_portal' },
  'api/lps/preview/snapshot/[id]/pdf': { domain: 'lp_capital', feature: 'lp_portal' },
  'api/lp-activity': { domain: 'lp_relations', feature: 'lp_activity' },
  'api/lp-letters': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/[id]': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/[id]/export': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/[id]/generate': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/[id]/generate/[companyId]': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/[id]/share': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/example': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/preview': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/templates': { domain: 'lp_relations', feature: 'lp_letters' },
  'api/lp-letters/templates/[id]': { domain: 'lp_relations', feature: 'lp_letters' },

  // ── Portfolio ─────────────────────────────────────────────────────────────
  'api/companies': { domain: 'portfolio' },
  'api/companies/[id]': { domain: 'portfolio' },
  'api/companies/[id]/default-metrics': { domain: 'portfolio' },
  'api/companies/[id]/default-metrics/[defaultId]': { domain: 'portfolio' },
  'api/companies/[id]/documents': { domain: 'portfolio' },
  'api/companies/[id]/documents/[docId]': { domain: 'portfolio' },
  'api/companies/[id]/investments': { domain: 'portfolio', feature: 'investments' },
  'api/companies/[id]/investments/[txnId]': { domain: 'portfolio', feature: 'investments' },
  'api/companies/[id]/metrics': { domain: 'portfolio' },
  'api/companies/[id]/metrics/[metricId]/values': { domain: 'portfolio' },
  // Configured where the holding lives (plans/spec-ledger-one-writer.md §6): the price feed any
  // quoted holding marks from, including booking the quoted mark — which derives and posts like
  // any recorded mark. Per-entity parts are scoped in the handler (lib/portfolio/holding-route.ts).
  'api/companies/[id]/price-feed': { domain: 'portfolio', feature: 'investments' },
  'api/companies/[id]/wallets': { domain: 'portfolio', feature: 'investments' },
  'api/companies/[id]/summary': { domain: 'portfolio' },
  // Company Updates: the durable, searchable projection of portfolio-reporting email. Reads are the
  // company timeline, one update, one artifact's text/original file, portfolio search, and coverage
  // stats — all portfolio. Starting a backfill is a fund-wide reprocessing cost, so it is `admin`.
  'api/companies/[id]/updates': { domain: 'portfolio' },
  'api/company-updates/[id]': { domain: 'portfolio' },
  'api/company-updates/[id]/artifacts/[artifactId]': { domain: 'portfolio' },
  'api/company-updates/search': { domain: 'portfolio' },
  'api/company-updates/status': { domain: 'portfolio' },
  'api/company-updates/backfill': { domain: 'admin', level: { GET: 'read', POST: 'write' } },
  'api/dashboard/table-data': { domain: 'portfolio' },
  // The caller's own entity selection for the dashboard: read level for every method, because
  // saving how YOU view the portfolio changes nothing anyone else sees.
  'api/dashboard/entities': { domain: 'portfolio', level: 'read' },
  'api/default-metrics': { domain: 'portfolio' },
  'api/default-metrics/[id]': { domain: 'portfolio' },
  'api/default-metrics/apply': { domain: 'portfolio' },
  'api/import': { domain: 'portfolio', feature: 'imports' },
  'api/import/documents': { domain: 'portfolio', feature: 'imports' },
  'api/import/investments': { domain: 'portfolio', feature: 'imports' },
  'api/metric-values/[id]': { domain: 'portfolio' },
  'api/metrics/[id]': { domain: 'portfolio' },
  'api/portfolio/fund-cash-flows': { domain: 'portfolio' },
  'api/portfolio/fund-cash-flows/import': { domain: 'portfolio', feature: 'imports' },
  'api/portfolio/fund-group-config': { domain: 'portfolio' },
  // Fund-of-funds holdings and their register. Portfolio, not accounting: an underlying fund
  // is a holding, and confirming a register row posts through the same investments path.
  'api/portfolio/sheet': { domain: 'portfolio' },
  'api/entities': { domain: 'portfolio', level: 'any' },
  // An entity's governing documents: anyone who can see the entity, whatever their domain grants —
  // the handlers check the entity (lib/entity-documents/http.ts). Level 'any' only keeps non-members
  // and switched-off funds out at the gate.
  'api/entities/[id]/documents': { domain: 'portfolio', level: 'any' },
  'api/entities/[id]/documents/upload-url': { domain: 'portfolio', level: 'any' },
  'api/entities/[id]/documents/[docId]': { domain: 'portfolio', level: 'any' },
  'api/entities/[id]/documents/[docId]/download': { domain: 'portfolio', level: 'any' },
  'api/portfolio/fund-holdings': { domain: 'portfolio', feature: 'investments' },
  'api/portfolio/fund-holdings/[id]': { domain: 'portfolio', feature: 'investments' },
  'api/portfolio/fund-holdings/[id]/events': { domain: 'portfolio', feature: 'investments' },
  'api/portfolio/fund-holdings/[id]/nav': { domain: 'portfolio', feature: 'investments' },
  'api/portfolio/investments': { domain: 'portfolio', feature: 'investments' },
  'api/requests': { domain: 'portfolio', feature: 'asks' },
  'api/requests/responses': { domain: 'portfolio', feature: 'asks' },
  'api/requests/send': { domain: 'portfolio', feature: 'asks' },
  'api/review': { domain: 'portfolio' },
  'api/review/[id]/resolve': { domain: 'portfolio' },

  // The inbound mailbox. Portfolio, not deal flow: an inbound email is intake substrate — it is
  // where a portfolio update arrives, where the metric extraction that fills the review queue
  // happens, and only sometimes a deal. Filing the whole mailbox under `dealflow` meant a fund
  // running Portfolio Reporting alone (deals is off by default) got a review queue it could not
  // act on: the email modal 403'd on its first fetch and there was no Inbound page to reprocess
  // from. PRODUCT_META already draws the line this way — Portfolio Reporting owns "inbound
  // updates", Investment Workflow owns "inbound DEAL intake".
  //
  // Promoting an email INTO a deal or a diligence data room is the deal-flow act, and stays gated
  // on the destination: see accept-to-diligence below, and the in-handler check on reroute.
  'api/emails': { domain: 'portfolio' },
  'api/emails/[id]': { domain: 'portfolio' },
  'api/emails/[id]/attachment/[index]': { domain: 'portfolio' },
  'api/emails/[id]/attachments': { domain: 'portfolio' },
  'api/emails/[id]/reprocess': { domain: 'portfolio' },
  'api/emails/[id]/reviews': { domain: 'portfolio' },
  'api/emails/save-to-drive': { domain: 'portfolio' },
  // Rerouting to 'reporting' / 'interactions' / 'audit' is portfolio work; rerouting to 'deals'
  // creates a deal, so the handler requires `dealflow` for that target specifically. One domain
  // per entry is the minimum to CALL the route — the payload that straddles domains is gated
  // inside it.
  'api/emails/[id]/reroute': { domain: 'portfolio' },

  // ── Relationships: candid internal commentary ──────────────────────────────
  'api/companies/[id]/interactions': { domain: 'relationships', feature: 'interactions' },
  'api/companies/[id]/notes': { domain: 'relationships', feature: 'notes' },
  'api/companies/[id]/notes/[noteId]': { domain: 'relationships', feature: 'notes' },
  'api/dashboard/notes': { domain: 'relationships', feature: 'notes' },
  'api/dashboard/notes/[noteId]': { domain: 'relationships', feature: 'notes' },
  'api/interactions': { domain: 'relationships', feature: 'interactions' },
  'api/notes': { domain: 'relationships', feature: 'notes' },
  'api/notes/members': { domain: 'relationships', feature: 'notes' },
  'api/notes/entities': { domain: 'relationships', feature: 'notes', level: 'read' },
  // Marking a note read is the reader's own state, not a note edit.
  'api/notes/mark-read': { domain: 'relationships', feature: 'notes', level: 'read' },

  // ── Deal flow ─────────────────────────────────────────────────────────────
  'api/deals': { domain: 'dealflow' },
  'api/deals/[id]': { domain: 'dealflow' },
  'api/deals/[id]/regenerate': { domain: 'dealflow' },
  'api/deals/[id]/research': { domain: 'dealflow' },
  'api/deals/manual': { domain: 'dealflow' },
  'api/deals/preview': { domain: 'dealflow' },
  'api/known-referrers': { domain: 'dealflow' },
  'api/known-referrers/[id]': { domain: 'dealflow' },

  // ── Diligence ─────────────────────────────────────────────────────────────
  // These two promote INTO diligence, so they're gated on the destination — the more sensitive of
  // the two domains they touch.
  'api/deals/[id]/promote-to-diligence': { domain: 'diligence' },
  'api/emails/[id]/accept-to-diligence': { domain: 'diligence' },
  'api/diligence': { domain: 'diligence' },
  'api/diligence/[id]': { domain: 'diligence' },
  'api/diligence/[id]/affinity': { domain: 'diligence' },
  'api/diligence/[id]/agent/checklist-assessment': { domain: 'diligence' },
  'api/diligence/[id]/agent/draft': { domain: 'diligence' },
  'api/diligence/[id]/agent/ingest': { domain: 'diligence' },
  'api/diligence/[id]/agent/qa/add-question': { domain: 'diligence' },
  'api/diligence/[id]/agent/qa/entry': { domain: 'diligence' },
  'api/diligence/[id]/agent/qa/finish': { domain: 'diligence' },
  'api/diligence/[id]/agent/qa/next-batch': { domain: 'diligence' },
  'api/diligence/[id]/agent/qa/respond': { domain: 'diligence' },
  'api/diligence/[id]/agent/render': { domain: 'diligence' },
  'api/diligence/[id]/agent/research': { domain: 'diligence' },
  'api/diligence/[id]/agent/score': { domain: 'diligence' },
  'api/diligence/[id]/agent/status': { domain: 'diligence' },
  'api/diligence/[id]/agent/transcribe': { domain: 'diligence' },
  'api/diligence/[id]/attention': { domain: 'diligence' },
  'api/diligence/[id]/attention/[itemId]': { domain: 'diligence' },
  'api/diligence/[id]/checklist': { domain: 'diligence' },
  'api/diligence/[id]/documents': { domain: 'diligence' },
  'api/diligence/[id]/documents/[docId]': { domain: 'diligence' },
  'api/diligence/[id]/documents/drive-files': { domain: 'diligence' },
  'api/diligence/[id]/documents/from-affinity': { domain: 'diligence' },
  'api/diligence/[id]/documents/from-drive': { domain: 'diligence' },
  'api/diligence/[id]/documents/upload-url': { domain: 'diligence' },
  'api/diligence/[id]/drafts': { domain: 'diligence' },
  'api/diligence/[id]/drafts/[draftId]': { domain: 'diligence' },
  'api/diligence/[id]/drafts/[draftId]/finalize': { domain: 'diligence' },
  'api/diligence/[id]/email-intake': { domain: 'diligence' },
  'api/diligence/[id]/memo-config': { domain: 'diligence' },
  'api/diligence/[id]/notes': { domain: 'diligence' },
  'api/diligence/[id]/notes/[noteId]': { domain: 'diligence' },
  // The Q&A chat reads evidence and answers; it doesn't change the deal.
  'api/diligence/[id]/qa-chat': { domain: 'diligence', level: 'read' },
  'api/diligence/[id]/usage': { domain: 'diligence' },
  'api/diligence/analytics': { domain: 'diligence' },
  'api/diligence/checklist-template': { domain: 'diligence' },
  'api/diligence/inbox': { domain: 'diligence' },
  'api/diligence/memo-presets': { domain: 'diligence' },
  'api/diligence/memo-presets/[presetId]': { domain: 'diligence' },
  'api/diligence/prompts': { domain: 'diligence' },
  // The memo agent's firm-wide configuration: house style, schemas, defaults.
  'api/firm/memo-agent-defaults': { domain: 'diligence' },
  'api/firm/schemas': { domain: 'diligence' },
  'api/firm/schemas/[name]': { domain: 'diligence' },
  'api/firm/schemas/[name]/history': { domain: 'diligence' },
  'api/firm/schemas/[name]/rollback': { domain: 'diligence' },
  'api/firm/style-anchors': { domain: 'diligence' },
  'api/firm/style-anchors/[id]': { domain: 'diligence' },
  'api/firm/style-anchors/upload-url': { domain: 'diligence' },

  // ── Compliance ────────────────────────────────────────────────────────────
  'api/compliance': { domain: 'compliance' },
  'api/compliance/links': { domain: 'compliance' },
  'api/compliance/profile': { domain: 'compliance' },
  'api/compliance/settings': { domain: 'compliance' },

  // ── Administration ────────────────────────────────────────────────────────
  'api/settings/deal-research': { domain: 'admin' },
  'api/settings/deal-submission-token': { domain: 'admin' },
  'api/settings/drive': { domain: 'admin' },
  'api/settings/drive/folders': { domain: 'admin' },
  'api/auth/google': { domain: 'admin' },
  'api/auth/google/callback': { domain: 'admin' },
  'api/settings/senders': { domain: 'admin' },
  'api/settings/senders/[id]': { domain: 'admin' },
  // The control panel for who can see what: reading it maps the fund's data.
  'api/settings/access': { domain: 'admin' },
  'api/settings/whitelist': { domain: 'admin' },
  'api/settings/whitelist/[id]': { domain: 'admin' },
  'api/onboarding/inbound-email': { domain: 'admin' },
  'api/onboarding/postmark': { domain: 'admin' },
  'api/onboarding/senders': { domain: 'admin' },
  'api/usage': { domain: 'admin' },
  'api/test-claude-key': { domain: 'admin' },
  'api/test-openai-key': { domain: 'admin' },
  'api/transcription/test': { domain: 'admin' },
  // Reading fund settings feeds the app shell for every member. Writing is *mostly* administration
  // — but `displayName` is deliberately member-writable ("any user can do this"), and the route
  // already refuses every admin-only field to a non-admin via its `hasAdminFields` check. Gating
  // the whole PATCH as admin took away a member's own name.
  'api/settings': { domain: 'admin', level: { GET: 'any', PATCH: 'any' } },
  // Any member sees the team roster; changing it is administration.
  'api/settings/members': { domain: 'admin', level: { GET: 'any' } },
  'api/settings/members/[id]': { domain: 'admin' },

  // ── A member's own data — membership is the whole test ─────────────────────
  // The Analyst gates each domain block internally against this same resolver, so gating the route
  // on any one domain would wrongly deny a member who holds a different one.
  'api/analyst': { domain: 'portfolio', level: 'any' },
  // A user's own conversations, scoped by user_id in the route.
  'api/analyst/conversations': { domain: 'portfolio', level: 'any' },
  'api/analyst/conversations/[id]': { domain: 'portfolio', level: 'any' },
  // Personal preferences, not fund data.
  'api/settings/theme': { domain: 'portfolio', level: 'any' },
  'api/settings/notifications': { domain: 'portfolio', level: 'any' },
  'api/settings/reminders': { domain: 'admin' },
  'api/settings/dashboard-entities': { domain: 'admin' },
  'api/settings/reminders/test': { domain: 'admin' },
  'api/auth/activity': { domain: 'portfolio', level: 'any' },
  // Affinity issues ONE KEY PER USER, scoped to that user's own permissions, so each member
  // connects their own. It lives under /settings but it is not administration.
  'api/settings/affinity': { domain: 'portfolio', level: 'any' },
  // A member's OWN agent credentials: GET lists only their keys, POST mints one for them. The
  // route refuses the read-only demo itself, and every call the key later makes is re-checked
  // against its owner's live grants — so the key can never exceed them. Gating this as admin
  // contradicted the whole point: a member granted write in a domain must be able to drive it
  // from an agent, which means being able to create the credential.
  'api/accounting/keys': { domain: 'portfolio', level: 'any' },
  // Same reasoning: this is the member authorizing an MCP client to act AS THEM. `grantableScope`
  // already caps what the token may carry, and the demo is refused in the handler.
  'api/oauth/consent': { domain: 'portfolio', level: 'any' },
}

/**
 * Entries whose route file may legitimately be ABSENT from a clone — local-only surfaces kept out
 * of git (see .gitignore). Mapped as normal on a machine that has them; missing everywhere else,
 * and the coverage test must not report that as a stale entry.
 *
 * Keep this tiny. A route that is merely unused should be deleted, not listed here.
 */
export const OPTIONAL_ROUTES = new Set<string>([
  // The demo fixtures are this install's marketing content, not product — they live outside git.
  'api/demo/seed',
])

/**
 * Routes with no domain gate, each with the reason it needs none. A route belongs here only if it
 * authenticates by some other means or serves no fund data — "it seemed fine" is not a reason.
 */
export const UNGATED_ROUTES: Record<string, string> = {
  // Stable native/external boundary. Each authenticated route accepts OAuth only and resolves
  // the token owner's live fund membership and grants in-handler; metadata is public discovery.
  'api/v1/meta': 'Public instance discovery; contains no fund-specific data.',
  'api/v1/me': 'OAuth-only v1 endpoint with live principal access checks in-handler.',
  'api/v1/chat': 'OAuth-only; shared Analyst orchestration enforces the token owner\'s live access.',
  'api/v1/chat/stream': 'OAuth-only; same preparation and orchestration as /api/v1/chat, streamed.',
  'api/v1/conversations': 'OAuth-only; queries are scoped to the token user and fund in-handler.',
  'api/v1/conversations/[id]': 'OAuth-only; reads and deletes are scoped to token user and fund.',
  'api/v1/pending-actions': 'OAuth-only; rows are fund-scoped and filtered by live domain access.',
  'api/v1/pending-actions/[id]/approve': 'OAuth-only; requires token write scope and live domain write access.',
  'api/v1/pending-actions/[id]/reject': 'OAuth-only; requires token write scope and live domain write access.',

  // Pre-authentication, or the act of authenticating.
  'api/auth/branding': 'Pre-auth: login page branding.',
  'api/auth/logout': 'Ends a session.',
  'api/auth/signup': 'Pre-auth by definition.',
  'api/setup': 'First-run bootstrap, before any fund exists.',
  'api/onboarding/check-domain': 'Pre-fund: is this email domain claimed.',
  'api/onboarding/fund': 'Creates the fund and its first admin.',
  'api/onboarding/join': 'Requests membership; the caller has none yet.',

  // Their own credential, not a session. These resolve an API key or OAuth token and enforce
  // access per tool — see lib/accounting/api-keys.ts.
  // Per-row domain gating in the handler: a fund's queue spans domains, so the route can't name
  // one. The list filters each row by hasAccess(read); approve/reject resolve the row's domain and
  // require write. See lib/pending-actions and the plan-analyst-live-tools design.
  'api/pending-actions': 'Queue spans domains; each row filtered by hasAccess(read) in-handler.',
  'api/pending-actions/[id]/approve': 'Domain resolved from the row; write enforced in-handler.',
  'api/pending-actions/[id]/reject': 'Domain resolved from the row; write enforced in-handler.',

  'api/mcp': 'MCP: authenticates by API key/OAuth token; gated per tool by domain.',
  'api/accounting/mcp': 'MCP (legacy path): as api/mcp.',
  'api/agent': 'Agent REST: as api/mcp.',

  // OAuth protocol surface for the MCP server.
  'api/oauth/metadata/authorization-server': 'RFC 8414 metadata; public by spec.',
  'api/oauth/metadata/protected-resource': 'RFC 9728 metadata; public by spec.',
  'api/oauth/register': 'RFC 7591 dynamic client registration.',
  'api/oauth/revoke': 'Bearer-token revocation.',
  'api/oauth/token': 'Token exchange; the credential is the auth.',

  // Service-triggered: shared CRON_SECRET, fail-closed if unset.
  'api/cron/affinity-sync': 'Cron: CRON_SECRET.',
  'api/cron/deal-research': 'Cron: CRON_SECRET.',
  'api/cron/deals-digest': 'Cron: CRON_SECRET.',
  'api/cron/memo-agent-worker': 'Cron: CRON_SECRET.',
  'api/cron/company-updates-ocr': 'Cron: CRON_SECRET.',
  'api/cron/entity-documents-ocr': 'Cron: CRON_SECRET.',
  'api/cron/company-updates-backfill': 'Cron: CRON_SECRET.',
  'api/cron/ops-reminders': 'Cron: CRON_SECRET.',

  // Inbound from third parties, authenticated by a token in the path or a provider signature.
  'api/webhooks/transcription/[token]': 'Inbound webhook: per-job single-use callback token in the path (SEC-010).',
  'api/csp-report': 'Browser-sent CSP violation reports; no credential exists to require. Rate-limited per platform IP, body capped, fields allowlisted before logging.',
  'api/inbound-email': 'Inbound email webhook.',
  'api/inbound-email/mailgun': 'Inbound email webhook (Mailgun).',
  'api/public/submit/[token]': 'Public deal-submission form; path token.',

  // A separate identity model: LP portal accounts, scoped per investor entity by resolveLpAccess.
  // Deliberately NOT merged into fund-member domains — see plans/plan-access-control.md.
  'api/portal/access-history': 'LP portal: resolveLpAccess.',
  'api/portal/activate': 'LP portal: invite activation.',
  'api/portal/analyst': 'LP portal: resolveLpAccess.',
  'api/portal/authorized-users': 'LP portal: resolveLpAccess.',
  'api/portal/contact': 'LP portal: resolveLpAccess.',
  'api/portal/documents': 'LP portal: resolveLpAccess.',
  'api/portal/documents/[id]': 'LP portal: resolveLpAccess.',
  'api/portal/letters': 'LP portal: resolveLpAccess.',
  'api/portal/letters/[id]': 'LP portal: resolveLpAccess.',
  'api/portal/letters/[id]/pdf': 'LP portal: resolveLpAccess.',
  'api/portal/me': 'LP portal: resolveLpAccess.',
  'api/portal/messages': 'LP portal: resolveLpAccess.',
  'api/portal/notices': 'LP portal: resolveLpAccess.',
  'api/portal/notices/ack': 'LP portal: resolveLpAccess.',
  'api/portal/onboarding': 'LP portal: resolveLpAccess.',
  'api/portal/onboarding/upload-url': 'LP portal: resolveLpAccess.',
  'api/portal/onboarding/consent': 'LP portal: resolveLpAccess.',
  'api/portal/overview': 'LP portal: resolveLpAccess.',
  'api/portal/snapshots': 'LP portal: resolveLpAccess.',
  'api/portal/snapshots/[id]': 'LP portal: resolveLpAccess.',
  'api/portal/snapshots/[id]/pdf': 'LP portal: resolveLpAccess.',
  'api/portal/statement/pdf': 'LP portal: resolveLpAccess.',

  // No fund data: these list what models a configured provider offers, for the model picker.
  'api/claude-models': 'Model list; no fund data.',
  'api/openai-models': 'Model list; no fund data.',
  'api/og': 'Renders an OG card from its own query params; reads nothing.',
  'api/pwa-icon':
    "Home-screen icon PNG. Must answer a browser that has no session — a manifest's icons are " +
    'fetched without credentials. Reads only the fund name and accent, which the sign-in page shows.',

  // The demo fund's own bootstrap; it provisions the read-only demo, which holds no real data.
  // Sign-in itself is no longer a route: it moved to the `startDemo` server action, which mints
  // the session server-side instead of handing credentials to the browser.
  'api/demo/seed': 'Demo fund provisioning.',
}
