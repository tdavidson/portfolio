// The domain vocabulary: the content areas access rights hang on.
//
// ONE list, replacing three that meant the same thing — `FeatureKey` (what the nav shows),
// `AgentToolMeta.domain` (an MCP dispatch grouping), and the Analyst's `domain` body param. Every
// API route, MCP tool, Analyst context block, and nav item maps to exactly one Domain, and every
// surface resolves access through `effectiveAccess` (lib/access/effective.ts).
//
// See plans/plan-access-control.md.

import {
  DEFAULT_FEATURE_VISIBILITY,
  type FeatureKey,
  type FeatureVisibility,
  type FeatureVisibilityMap,
} from '@/lib/types/features'

export type Domain =
  | 'portfolio'
  | 'relationships'
  | 'dealflow'
  | 'diligence'
  | 'accounting'
  | 'management_company'
  | 'lp_capital'
  | 'gp_economics'
  | 'lp_relations'
  | 'compliance'
  | 'admin'

/**
 * ADDING A DOMAIN? It needs a row in `fund_domain_defaults` for every existing fund, and a line in
 * the trigger that seeds new ones (see 20260716000008_member_access_grants.sql). Without that,
 * members resolve to `none` in the new domain — a silent lockout, not an error, because a missing
 * default is indistinguishable from a deliberate deny.
 */
export const DOMAINS: Domain[] = [
  'portfolio',
  'relationships',
  'dealflow',
  'diligence',
  'accounting',
  'management_company',
  'lp_capital',
  'gp_economics',
  'lp_relations',
  'compliance',
  'admin',
]

export interface DomainMeta {
  /** Shown to the admin in the per-member access grid. */
  label: string
  /** One line: what a member with this grant can reach. */
  description: string
  /**
   * The fund-level switch for domain-wide checks that have no route of their own — an Analyst
   * context block, an MCP tool. Null means the domain has no single switch: it's either always on
   * (portfolio) or role-governed (admin), and its individual routes name their own feature key.
   */
  primaryFeature: FeatureKey | null
  /**
   * Every feature key whose routes live in this domain — informational, so the admin UI can show
   * which fund-level switches relate to which grant. Not used for gating; a route names its own.
   */
  features: FeatureKey[]
  /** Admins only, whatever the grants say. */
  adminOnly?: boolean
  /**
   * This domain is implied by another: holding that one confers at least the same level here.
   *
   * Only one exists, and it is an admission rather than a convenience. See `lp_capital`.
   */
  impliedBy?: Domain
}

/** Which domain owns a feature key — derived from DOMAIN_META, so the two can't drift. */
export function domainForFeature(key: FeatureKey): Domain | undefined {
  return FEATURE_TO_DOMAIN[key]
}

/** The fund-level switch governing a domain as a whole. Null = it has none (always on). */
export function domainFundLevel(
  domain: Domain,
  features: FeatureVisibilityMap | undefined,
): FeatureVisibility | null {
  const key = DOMAIN_META[domain].primaryFeature
  if (!key) return null
  return features?.[key] ?? DEFAULT_FEATURE_VISIBILITY[key]
}

/**
 * Can a MEMBER hold this domain at all, given the fund's switches?
 *
 * False means a grant here is INERT — `effectiveAccess` returns none for a member without ever
 * reading it. The settings grid asks this to avoid offering a control that does nothing.
 *
 * Pure, so the client can answer it from the feature map it already has rather than re-fetching
 * (which is why the grid used to need a page refresh before it told the truth). Shared with the
 * server so there is one rule, not two that drift.
 */
export function domainGrantableToMembers(
  domain: Domain,
  features: FeatureVisibilityMap | undefined,
): boolean {
  const level = domainFundLevel(domain, features)
  return level === null || level === 'everyone'
}

export const DOMAIN_META: Record<Domain, DomainMeta> = {
  portfolio: {
    label: 'Portfolio',
    description: 'Companies, metrics, dashboard, review queue, imports, investments, asks.',
    primaryFeature: null,
    features: ['investments', 'imports', 'asks'],
  },
  relationships: {
    label: 'Notes',
    description: 'Interactions and internal notes — candid commentary on founders and companies.',
    primaryFeature: null,
    features: ['interactions', 'notes'],
  },
  dealflow: {
    label: 'Deals',
    description: 'Inbound deals, the email inbox, referrers, screening.',
    primaryFeature: 'deals',
    features: ['deals'],
  },
  diligence: {
    label: 'Diligence',
    description: 'Diligence deals, memos, call transcripts, checklists, evidence.',
    primaryFeature: 'diligence',
    features: ['diligence'],
  },
  accounting: {
    label: 'Fund accounting',
    description:
      'Bank, journal, chart of accounts, periods, statements, schedule of investments, and the K-1 packages derived from them.',
    primaryFeature: 'accounting',
    /**
     * `tax_reporting` lives here rather than in a domain of its own for the same reason
     * `lp_capital` is `impliedBy: 'accounting'`: a K-1 is derived from the partner capital
     * accounts, and those accounts ARE the chart of accounts. Every figure a K-1 carries is
     * already legible to anyone holding this grant — from the trial balance, the ledger export,
     * or the statement of changes in partners' capital. A separate grant would suggest a boundary
     * that does not exist.
     *
     * The feature key still earns its place: it decides whether the fund does tax reporting AT
     * ALL, independently of whether it keeps books.
     */
    features: ['accounting', 'tax_reporting', 'budgeting'],
  },
  management_company: {
    label: 'Management company',
    description:
      "The firm's own operating books: cash, payroll and compensation, the quarterly management-fee cycle, and intercompany balances with the funds it manages.",
    primaryFeature: 'management_company',
    features: ['management_company'],
    /**
     * ITS OWN DOMAIN, AND DELIBERATELY NOT `impliedBy: 'accounting'`.
     *
     * The `lp_capital` note explains why an implication is sometimes the only honest answer: a
     * fund's chart of accounts has one capital account per partner, NAMED for them, so granting
     * the books has already granted partner capital, and pretending otherwise would be a lie told
     * to an admin who trusts the checkbox.
     *
     * A management company is the opposite case. It is a SEPARATE LEGAL ENTITY with a separate
     * ledger, and what that ledger carries — salaries, bonuses, partner draws — appears nowhere in
     * the fund's trial balance, chart, journal or capital accounts. The fund sees one number, the
     * management fee it pays. So the boundary here is real, and a grant can enforce it without
     * pretending.
     *
     * That is only true while it is ENFORCED per vehicle, not per route: the manco's books live in
     * the same `journal_entries`/`chart_of_accounts` tables as every fund's, so `/api/accounting/*`
     * would serve them to anyone holding `accounting`. `assertVehicleDomain`
     * (lib/accounting/vehicle-domain.ts) is what stops that — it resolves the vehicle's `kind` on
     * every accounting request and requires THIS grant when the vehicle is a management company.
     * tests/manco-vehicle-domain.test.ts pins it.
     */
  },
  lp_capital: {
    label: 'LP capital',
    description:
      'LP identities, commitments, capital accounts, snapshots, the live report. Anyone who can read the books has this too — the partner capital accounts ARE the ledger.',
    primaryFeature: 'lps',
    features: ['lps', 'lp_tracking'],
    /**
     * READING THE BOOKS IS READING PARTNER CAPITAL. There is no honest way to separate them: a
     * fund's chart of accounts has one capital account per partner, NAMED for them
     * (`Partners' capital — <LP>`, lib/accounting/persist.ts), so the trial balance, the chart,
     * the journal and the ledger export all carry LP identities and balances by construction.
     *
     * We tried gating those payloads field by field. It doesn't hold: omit the statement of
     * changes in partners' capital and the same figures ship as trial-balance rows a few lines
     * later. Pretending to protect it would be a lie told to an admin who trusts the checkbox.
     *
     * So this is stated instead of hidden: grant accounting, and you have granted LP capital.
     * `lp_capital` still means something on its own — it gates the /lps section for members who
     * DON'T have the books (the common case: portfolio staff). And `gp_economics` remains a real
     * carve-out, because carry is NOT structurally part of the ledger the way partners are.
     */
    impliedBy: 'accounting',
  },
  gp_economics: {
    label: 'GP economics',
    description: 'Carry terms, carry accrued and paid per partner, per-deal carry, GP ownership.',
    primaryFeature: 'gp_economics',
    features: ['gp_economics'],
  },
  lp_relations: {
    label: 'LP Docs',
    description: 'LP letters, shared documents, invites, authorized users, the LP activity log.',
    primaryFeature: null,
    features: ['lp_letters', 'lp_portal', 'lp_activity'],
  },
  compliance: {
    label: 'Compliance',
    description: 'Filings, deadlines, workflows.',
    primaryFeature: 'compliance',
    features: ['compliance'],
  },
  admin: {
    label: 'Administration',
    description: 'API keys, AI providers, members, integrations, fund settings.',
    primaryFeature: null,
    features: [],
    adminOnly: true,
  },
}

const FEATURE_TO_DOMAIN: Partial<Record<FeatureKey, Domain>> = Object.fromEntries(
  DOMAINS.flatMap(d => DOMAIN_META[d].features.map(f => [f, d])),
)
