// The getting-started checklist for a new fund: what is set up, what is next, and what is waiting
// on something else. Computed from the fund's own data on every render — nothing here is ticked by
// hand, so it cannot say "done" about something that is not.
//
// Two halves, deliberately split:
//   - `loadSetupFacts` runs a handful of cheap queries (head-only counts, `limit(1)` probes) scoped
//     to the caller's fund and, where it matters, to ONE entity. It never runs `vehicleStatus` —
//     that rebuilds the whole ledger, and a checklist on the landing page cannot cost that.
//   - `computeSetupProgress` is pure: facts in, ordered sections out. That is the part with the
//     policy in it (which steps exist for whom, what blocks what), and the part the tests pin.
//
// Access: the loader asks the same resolver as every other surface (`hasAccess`) and does not even
// QUERY a domain the caller cannot read, so a member never learns a count from an area they could
// not open. The steps are then filtered on the same flags, so a link is never offered to a page
// whose gate would refuse them.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { isProductActive, PRODUCT_META, orderedProducts } from '@/lib/access/products'
import type { FeatureVisibilityMap } from '@/lib/types/features'
import { effectiveAIMode, hasAnyAIKey, type AIMode } from '@/lib/ai/capabilities'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = 'done' | 'todo' | 'blocked' | 'not_applicable'

export type SectionKey = 'basics' | 'fund' | 'investors' | 'investments' | 'books' | 'planning' | 'integrations'

export type StepKey =
  | 'ai_key'
  | 'products'
  | 'entity'
  | 'fund_terms'
  | 'lps'
  | 'lp_portal'
  | 'investments'
  | 'investments_on_ledger'
  | 'open_books'
  | 'first_close'
  | 'forecast'
  | 'inbound_email'
  | 'senders'

/** One way of doing a step, when there is more than one (opening the books). */
export interface StepOption {
  label: string
  href: string
  /** One short line: when to choose this path. */
  hint: string
}

export interface SetupStep {
  key: StepKey
  title: string
  /** One sentence: why this matters. */
  why: string
  status: StepStatus
  /** The prerequisite's step key, when `status` is 'blocked'. */
  dependsOn?: StepKey
  /** Human wording of the prerequisite: "a fund entity". Shown as "Needs: …". */
  blockedBy?: string
  href: string
  cta: string
  /** What the data says right now, e.g. "12 partners, 3 without a commitment". */
  detail?: string
  options?: StepOption[]
  /** Shown only to admins (and only computed for them). */
  adminOnly?: boolean
}

export interface SetupSection {
  key: SectionKey
  title: string
  steps: SetupStep[]
}

export interface SetupProgress {
  sections: SetupSection[]
  /** Steps that count: everything except not_applicable. */
  total: number
  done: number
  complete: boolean
  /** The entity the per-entity steps describe, if any. */
  vehicle: { id: string; name: string; kind: string | null } | null
}

/** What the viewer may open. Steps are omitted, not greyed, when the flag is false. */
export interface SetupAbilities {
  isAdmin: boolean
  /** Portfolio Reporting: companies, the mailbox. */
  portfolio: boolean
  investments: boolean
  imports: boolean
  /** The books (also the Admin page, periods, forecast). */
  accounting: boolean
  /** LP capital (the /lps/capital page). */
  lpCapital: boolean
  /** LP portal invites (/lp-portal). */
  lpPortal: boolean
  /** Carry terms. Only consulted for the "fund terms" detail. */
  gpEconomics: boolean
}

export interface SetupVehicleFacts {
  id: string
  name: string
  kind: string | null
  vintageYear: number | null
  /** A vehicle_waterfall_terms row exists (carry chosen, even if "none"). Null = not asked. */
  hasWaterfallTerms: boolean | null
  /** A vehicle_accounting_settings row exists (allocation basis chosen). Null = not asked. */
  hasAccountingSettings: boolean | null
  partnerCount: number | null
  partnersWithCommitment: number | null
  investmentTxnCount: number | null
  /** Per-holding cost accounts on this entity's chart — the investments are on the ledger. */
  ledgerInvestmentAccounts: number | null
  chartAccounts: number | null
  postedEntries: number | null
  draftEntries: number | null
  closedPeriods: number | null
  forecastPlans: number | null
}

export interface SetupFacts {
  can: SetupAbilities
  /** Admin-only facts; null for everyone else. */
  settings: {
    hasAiKey: boolean
    /** How AI runs here (lib/ai/capabilities.ts): a saved key, the admin's choice of their own assistant, or not chosen. */
    aiMode: AIMode | null
    /** The fund has saved a product choice (feature_visibility is not empty). */
    productsChosen: boolean
    activeProducts: string[]
    inboundProvider: 'postmark' | 'resend' | null
    inboundConfigured: boolean
    senderCount: number
  } | null
  /** Entities this viewer can see, primary first. */
  vehicles: { id: string; name: string; kind: string | null }[]
  /** Facts for the selected entity, or null when there is none. */
  vehicle: SetupVehicleFacts | null
  /** Fund-wide, for when there is no entity yet or the viewer cannot see the books. */
  lpEntityCount: number | null
  companyCount: number | null
  lpPortalLinks: number | null
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

const SECTION_TITLES: Record<SectionKey, string> = {
  basics: 'Basics',
  fund: 'Your fund',
  investors: 'Investors',
  investments: 'Investments',
  books: 'Books',
  planning: 'Planning',
  integrations: 'Integrations',
}

const SECTION_ORDER: SectionKey[] = ['basics', 'fund', 'investors', 'investments', 'books', 'planning', 'integrations']

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** `/funds/<id>/<slug>` for the selected entity, or the firm-wide landing that asks which one. */
function entityHref(v: { id: string } | null, slug: string): string {
  return v ? `/funds/${encodeURIComponent(v.id)}/${slug}` : `/funds/${slug}`
}

interface Draft extends Omit<SetupStep, 'status' | 'blockedBy' | 'dependsOn'> {
  section: SectionKey
  done: boolean
  /** Not meaningful for this entity at all (a management company has no LPs). */
  notApplicable?: boolean
  needs?: { key: StepKey; label: string; done: boolean }
}

/**
 * Facts in, ordered sections out. Pure — no I/O, no clock — so the tests can pin every rule.
 *
 * A step is:
 *   - `not_applicable` when it does not apply to this entity's kind,
 *   - `done` when the data says so (even if its prerequisite is not — data wins over order),
 *   - `blocked` when its prerequisite is not done yet (the action is locked, the reason shown),
 *   - `todo` otherwise.
 * Steps the viewer has no access to are left out entirely rather than shown greyed.
 */
export function computeSetupProgress(facts: SetupFacts): SetupProgress {
  const { can, settings, vehicle: v } = facts
  const manco = isManagementCompany(v?.kind ?? null)
  const hasEntity = facts.vehicles.length > 0
  const drafts: Draft[] = []

  // Prerequisite facts, computed once so a step can depend on one the viewer cannot see.
  const lpsDone = v
    ? (v.partnerCount ?? 0) > 0 && (v.partnersWithCommitment ?? 0) > 0
    : (facts.lpEntityCount ?? 0) > 0
  const investmentsDone = v ? (v.investmentTxnCount ?? 0) > 0 : (facts.companyCount ?? 0) > 0
  const booksOpen = (v?.postedEntries ?? 0) > 0
  const inboundDone = !!settings?.inboundConfigured
  const needEntity = { key: 'entity' as const, label: 'a fund entity', done: hasEntity }

  // ── Basics ────────────────────────────────────────────────────────────────
  if (can.isAdmin && settings) {
    drafts.push({
      section: 'basics',
      key: 'ai_key',
      title: 'Choose how AI works here',
      why: 'Add a server key for the web app\'s AI buttons and inbound email parsing, or use your own assistant (Claude, ChatGPT) with no key.',
      done: settings.aiMode !== null,
      detail: settings.aiMode === 'server_key'
        ? 'A provider key is saved.'
        : settings.aiMode === 'assistant'
          ? 'No server key: your own assistant does the AI work over MCP.'
          : 'Not chosen yet.',
      href: '/settings',
      cta: 'Open Settings',
      adminOnly: true,
    })
    drafts.push({
      section: 'basics',
      key: 'products',
      title: 'Choose your products',
      why: 'Turn on only what your fund uses — portfolio reporting, LP reporting, fund operations — so the app stays focused.',
      done: settings.productsChosen,
      detail: settings.activeProducts.length > 0 ? `On: ${settings.activeProducts.join(', ')}` : undefined,
      href: '/settings',
      cta: 'Choose products',
      adminOnly: true,
    })
  }

  // ── Your fund ─────────────────────────────────────────────────────────────
  // Adding an entity is an admin action on the Financials landing, or on Investments for a fund
  // running portfolio reporting alone.
  if (can.isAdmin && (can.accounting || can.investments)) {
    drafts.push({
      section: 'fund',
      key: 'entity',
      title: 'Add your fund entity',
      why: 'Commitments, investments and books all belong to an entity, so this comes first.',
      done: hasEntity,
      detail: hasEntity ? plural(facts.vehicles.length, 'entity', 'entities') : undefined,
      href: can.accounting ? '/funds/status' : '/investments',
      cta: hasEntity ? 'Manage entities' : 'Add an entity',
      adminOnly: true,
    })
  }
  if (can.accounting && v) {
    const missing: string[] = []
    if (v.vintageYear == null) missing.push('vintage year')
    if (can.gpEconomics && v.hasWaterfallTerms === false) missing.push('carry / waterfall')
    if (v.hasAccountingSettings === false) missing.push('allocation basis')
    drafts.push({
      section: 'fund',
      key: 'fund_terms',
      title: 'Set the fund terms',
      why: 'Vintage, carry, allocation basis and closings decide how every dollar is split between partners.',
      done: missing.length === 0,
      notApplicable: manco,
      detail: missing.length > 0 ? `Not set yet: ${missing.join(', ')}` : `Vintage ${v.vintageYear}`,
      href: entityHref(v, 'status'),
      cta: 'Open the Admin page',
      needs: needEntity,
    })
  }

  // ── Investors ─────────────────────────────────────────────────────────────
  if (can.lpCapital) {
    let detail: string | undefined
    if (v && v.partnerCount != null) {
      const without = Math.max(0, v.partnerCount - (v.partnersWithCommitment ?? 0))
      detail = v.partnerCount === 0
        ? `No partners in ${v.name} yet.`
        : `${plural(v.partnerCount, 'partner')}${without > 0 ? `, ${without} without a commitment` : ''}`
    } else if (facts.lpEntityCount != null) {
      detail = facts.lpEntityCount === 0 ? 'No LPs yet.' : plural(facts.lpEntityCount, 'LP')
    }
    drafts.push({
      section: 'investors',
      key: 'lps',
      title: 'Add your LPs and their commitments',
      why: 'Capital calls, allocations and statements are all driven by who committed how much.',
      done: lpsDone,
      notApplicable: manco,
      detail,
      href: '/lps/capital',
      cta: 'Import LPs',
      needs: needEntity,
    })
  }
  if (can.lpPortal) {
    const links = facts.lpPortalLinks ?? 0
    drafts.push({
      section: 'investors',
      key: 'lp_portal',
      title: 'Invite LPs to the portal',
      why: 'LPs see their own statements and documents without you emailing PDFs.',
      done: links > 0,
      notApplicable: manco,
      detail: links > 0 ? plural(links, 'invite') + ' sent' : undefined,
      href: '/lp-portal',
      cta: 'Send invites',
      needs: { key: 'lps', label: 'LPs to invite', done: lpsDone },
    })
  }

  // ── Investments ───────────────────────────────────────────────────────────
  if (can.investments || can.imports) {
    let detail: string | undefined
    if (v && v.investmentTxnCount != null) {
      detail = v.investmentTxnCount === 0 ? `None recorded for ${v.name} yet.` : `${plural(v.investmentTxnCount, 'transaction')} in ${v.name}`
    } else if (facts.companyCount != null) {
      detail = facts.companyCount === 0 ? 'No companies yet.' : plural(facts.companyCount, 'company', 'companies')
    }
    drafts.push({
      section: 'investments',
      key: 'investments',
      title: 'Record your investments',
      why: 'Paste a list of rounds and amounts and the AI matches them to companies, or add them one at a time.',
      done: investmentsDone,
      notApplicable: manco,
      detail,
      href: can.imports ? '/import' : '/investments',
      cta: can.imports ? 'Paste investment data' : 'Add an investment',
      needs: needEntity,
    })
  }
  if (can.accounting && v) {
    const onLedger = (v.ledgerInvestmentAccounts ?? 0) > 0
    drafts.push({
      section: 'investments',
      key: 'investments_on_ledger',
      title: 'Put the investments on the ledger',
      why: 'The schedule of investments and NAV come from the books, so recorded investments need their journal entries.',
      done: onLedger,
      notApplicable: manco,
      detail: onLedger ? plural(v.ledgerInvestmentAccounts ?? 0, 'holding') + ' on the books' : undefined,
      href: entityHref(v, 'status'),
      cta: 'Put them on the ledger',
      needs: { key: 'investments', label: 'recorded investments', done: investmentsDone },
    })
  }

  // ── Books ─────────────────────────────────────────────────────────────────
  if (can.accounting && v) {
    const drafts_ = v.draftEntries ?? 0
    drafts.push({
      section: 'books',
      key: 'open_books',
      title: 'Open the books',
      why: 'Pick the path that matches where you are: a new fund, a cutover from another system, or full history.',
      done: booksOpen,
      detail: booksOpen
        ? `${plural(v.postedEntries ?? 0, 'posted entry', 'posted entries')}${drafts_ > 0 ? `, ${drafts_} in draft` : ''}`
        : drafts_ > 0 ? `${plural(drafts_, 'entry', 'entries')} in draft — post them to open the books` : undefined,
      href: entityHref(v, 'capital-accounts'),
      cta: 'Choose how to start',
      options: [
        { label: 'New fund', href: entityHref(v, 'capital-accounts'), hint: 'Record capital calls as they happen, or upload a call sheet.' },
        { label: 'Cutover', href: entityHref(v, 'opening-balances'), hint: 'Book balances as of a start date and carry on from there.' },
        { label: 'Full history', href: entityHref(v, 'migrate'), hint: 'Bring in a QuickBooks ledger, then bank statements.' },
      ],
      needs: needEntity,
    })
    drafts.push({
      section: 'books',
      key: 'first_close',
      title: 'Close your first period',
      why: 'A close allocates income to partners and locks the numbers your statements report.',
      done: (v.closedPeriods ?? 0) > 0,
      detail: (v.closedPeriods ?? 0) > 0 ? plural(v.closedPeriods ?? 0, 'period') + ' closed' : undefined,
      href: entityHref(v, 'periods'),
      cta: 'Close a period',
      needs: { key: 'open_books', label: 'open books', done: booksOpen },
    })

    // ── Planning ────────────────────────────────────────────────────────────
    drafts.push({
      section: 'planning',
      key: 'forecast',
      title: 'Build your first forecast',
      why: 'A budget or rolling forecast shows cash needs and fee income before they arrive.',
      done: (v.forecastPlans ?? 0) > 0,
      detail: (v.forecastPlans ?? 0) > 0 ? plural(v.forecastPlans ?? 0, 'plan') : undefined,
      href: entityHref(v, 'forecast'),
      cta: 'Start a forecast',
      needs: { key: 'open_books', label: 'open books', done: booksOpen },
    })
  }

  // ── Integrations ──────────────────────────────────────────────────────────
  // Inbound email is how portfolio companies' updates arrive, so it exists only where portfolio
  // reporting does.
  if (can.isAdmin && can.portfolio && settings) {
    drafts.push({
      section: 'integrations',
      key: 'inbound_email',
      title: 'Set up inbound email',
      why: 'Forward company updates to one address and the metrics are extracted for review.',
      done: inboundDone,
      detail: settings.inboundProvider
        ? `${settings.inboundProvider === 'postmark' ? 'Postmark' : 'Resend'}${inboundDone ? '' : ', not finished'}`
        : undefined,
      href: '/settings',
      cta: 'Connect email',
      adminOnly: true,
    })
    drafts.push({
      section: 'integrations',
      key: 'senders',
      title: 'Add authorized senders',
      why: 'Only mail from these addresses is processed, so nobody else can write into your portfolio.',
      done: settings.senderCount > 0,
      detail: settings.senderCount > 0 ? plural(settings.senderCount, 'sender') : undefined,
      href: '/settings',
      cta: 'Add senders',
      adminOnly: true,
      needs: { key: 'inbound_email', label: 'inbound email', done: inboundDone },
    })
  }

  // ── Status ────────────────────────────────────────────────────────────────
  const steps = drafts.map((d): SetupStep & { section: SectionKey } => {
    const { done, notApplicable, needs, ...rest } = d
    const status: StepStatus = notApplicable
      ? 'not_applicable'
      : done
        ? 'done'
        : needs && !needs.done
          ? 'blocked'
          : 'todo'
    return {
      ...rest,
      status,
      ...(status === 'blocked' && needs ? { dependsOn: needs.key, blockedBy: needs.label } : {}),
    }
  })

  const sections: SetupSection[] = SECTION_ORDER
    .map(key => ({
      key,
      title: SECTION_TITLES[key],
      steps: steps.filter(s => s.section === key).map(({ section: _section, ...s }) => s),
    }))
    .filter(s => s.steps.length > 0)

  const counted = steps.filter(s => s.status !== 'not_applicable')
  const done = counted.filter(s => s.status === 'done').length
  return {
    sections,
    total: counted.length,
    done,
    complete: counted.length > 0 && done === counted.length,
    vehicle: v ? { id: v.id, name: v.name, kind: v.kind } : null,
  }
}

/** Counts that discount steps the viewer chose to skip (client-side, per user). */
export function progressCounts(progress: Pick<SetupProgress, 'sections'>, skipped: ReadonlySet<string> = new Set()) {
  const counted = progress.sections.flatMap(s => s.steps).filter(s => s.status !== 'not_applicable' && !(s.status !== 'done' && skipped.has(s.key)))
  const done = counted.filter(s => s.status === 'done').length
  return { done, total: counted.length, complete: done === counted.length }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Which abilities this viewer has, from the one resolver. */
export function setupAbilities(access: AccessContext): SetupAbilities {
  return {
    isAdmin: access.role === 'admin',
    portfolio: hasAccess(access, 'portfolio', 'read'),
    investments: hasAccess(access, 'portfolio', 'read', 'investments'),
    imports: hasAccess(access, 'portfolio', 'read', 'imports'),
    accounting: hasAccess(access, 'accounting', 'read'),
    lpCapital: hasAccess(access, 'lp_capital', 'read', 'lp_tracking'),
    lpPortal: hasAccess(access, 'lp_relations', 'read', 'lp_portal'),
    gpEconomics: hasAccess(access, 'gp_economics', 'read'),
  }
}

/** The entity the checklist describes by default: the first fund, else the first non-manco, else the first. */
export function primaryVehicle<V extends { kind: string | null }>(vehicles: V[]): V | null {
  return (
    vehicles.find(v => v.kind === 'fund') ??
    vehicles.find(v => !isManagementCompany(v.kind)) ??
    vehicles[0] ??
    null
  )
}

type CountResult = { count: number | null }
const n = (r: CountResult) => r.count ?? 0

/**
 * Everything `computeSetupProgress` needs, in one parallel round of cheap queries.
 *
 * `vehicleId` picks the entity (from the page's ?entity=); an id the caller cannot see falls back
 * to the primary rather than erroring, so a stale link still renders a checklist.
 */
export async function loadSetupFacts(
  admin: SupabaseClient,
  fundId: string,
  access: AccessContext,
  opts: { vehicleId?: string | null } = {},
): Promise<SetupFacts> {
  const can = setupAbilities(access)
  const db = admin as any

  // Entities: only the ones this caller may see, and only when some step concerns entities.
  const wantsVehicles = can.accounting || can.lpCapital || can.investments || can.imports || can.isAdmin
  const vehicleRows: { id: string; name: string; kind: string | null; vintage_year: number | null }[] = wantsVehicles
    ? (((await db
        .from('fund_vehicles')
        .select('id, name, kind, vintage_year')
        .eq('fund_id', fundId)
        .eq('active', true)
        .order('created_at', { ascending: true })
        .limit(200)).data ?? []) as any[])
    : []
  const visible = vehicleRows.filter(r => canSeeVehicle(access, r.id))
  const primary = primaryVehicle(visible)
  const ordered = primary ? [primary, ...visible.filter(r => r !== primary)] : visible
  const selected = (opts.vehicleId && visible.find(r => r.id === opts.vehicleId)) || primary

  const settingsQ = can.isAdmin
    ? db.from('fund_settings')
        // select('*') so `ai_mode`, added by a migration that may not be applied yet, reads as
        // undefined rather than failing the whole select (and with it every admin fact).
        .select('*')
        .eq('fund_id', fundId)
        .maybeSingle()
    : Promise.resolve({ data: null })
  const sendersQ = can.isAdmin && can.portfolio
    ? db.from('authorized_senders').select('id', { count: 'exact', head: true }).eq('fund_id', fundId)
    : Promise.resolve({ count: null })
  const lpEntitiesQ = can.lpCapital
    ? db.from('lp_entities').select('id', { count: 'exact', head: true }).eq('fund_id', fundId)
    : Promise.resolve({ count: null })
  const companiesQ = can.investments || can.imports
    ? db.from('companies').select('id', { count: 'exact', head: true }).eq('fund_id', fundId)
    : Promise.resolve({ count: null })
  const portalQ = can.lpPortal
    ? db.from('lp_account_links').select('id', { count: 'exact', head: true }).eq('fund_id', fundId)
    : Promise.resolve({ count: null })

  const vehicleQ = selected ? loadVehicleFacts(db, fundId, selected, can) : Promise.resolve(null)

  const [settingsRes, sendersRes, lpEntitiesRes, companiesRes, portalRes, vehicle] = await Promise.all([
    settingsQ, sendersQ, lpEntitiesQ, companiesQ, portalQ, vehicleQ,
  ])

  let settings: SetupFacts['settings'] = null
  if (can.isAdmin) {
    const s = (settingsRes.data ?? {}) as Record<string, any>
    const stored = (s.feature_visibility ?? null) as Partial<FeatureVisibilityMap> | null
    const provider = s.inbound_email_provider === 'postmark' || s.inbound_email_provider === 'resend' ? s.inbound_email_provider : null
    settings = {
      hasAiKey: hasAnyAIKey(s),
      aiMode: effectiveAIMode(hasAnyAIKey(s), s.ai_mode),
      productsChosen: !!stored && Object.keys(stored).length > 0,
      activeProducts: orderedProducts().filter(p => isProductActive(p, access.features)).map(p => PRODUCT_META[p].label),
      inboundProvider: provider,
      inboundConfigured:
        (provider === 'postmark' && !!String(s.postmark_inbound_address ?? '').trim()) ||
        (provider === 'resend' && !!String(s.resend_inbound_domain ?? '').trim()),
      senderCount: n(sendersRes as CountResult),
    }
  }

  return {
    can,
    settings,
    vehicles: ordered.map(r => ({ id: r.id, name: r.name, kind: r.kind })),
    vehicle,
    lpEntityCount: (lpEntitiesRes as CountResult).count,
    companyCount: (companiesRes as CountResult).count,
    lpPortalLinks: (portalRes as CountResult).count,
  }
}

async function loadVehicleFacts(
  db: any,
  fundId: string,
  v: { id: string; name: string; kind: string | null; vintage_year: number | null },
  can: SetupAbilities,
): Promise<SetupVehicleFacts> {
  const none = Promise.resolve({ count: null, data: null })
  const head = { count: 'exact', head: true } as const
  const books = can.accounting
  const manco = isManagementCompany(v.kind)

  const [
    terms, settings, chart, posted, draftsRes, closed, plans, ledgerInv, txns,
    commitEvents, positions, lpInv,
  ] = await Promise.all([
    books && can.gpEconomics && !manco
      ? db.from('vehicle_waterfall_terms').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id)
      : none,
    books && !manco
      ? db.from('vehicle_accounting_settings').select('vehicle_id', head).eq('fund_id', fundId).eq('vehicle_id', v.id)
      : none,
    books ? db.from('chart_of_accounts').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id) : none,
    books ? db.from('journal_entries').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id).eq('book', 'actual').eq('status', 'posted') : none,
    books ? db.from('journal_entries').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id).eq('book', 'actual').eq('status', 'draft') : none,
    books ? db.from('fiscal_periods').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id).eq('status', 'closed') : none,
    books ? db.from('forecast_plans').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id).eq('status', 'active') : none,
    books && !manco
      ? db.from('chart_of_accounts').select('id', head).eq('fund_id', fundId).eq('vehicle_id', v.id).not('company_id', 'is', null)
      : none,
    (can.investments || can.imports || books) && !manco
      ? db.from('investment_transactions').select('id', head).eq('fund_id', fundId).eq('portfolio_group', v.name)
      : none,
    // Partners: anyone with a commitment event, a reported position, or a pasted LP investment in
    // this entity. Id columns only, capped — this is a checklist, not the register.
    can.lpCapital && !manco
      ? db.from('commitment_events').select('lp_entity_id, amount').eq('fund_id', fundId).eq('vehicle_id', v.id).limit(5000)
      : none,
    can.lpCapital && !manco
      ? db.from('lp_positions').select('lp_entity_id, commitment').eq('fund_id', fundId).eq('vehicle_id', v.id).limit(5000)
      : none,
    can.lpCapital && !manco
      ? db.from('lp_investments').select('entity_id, commitment').eq('fund_id', fundId).eq('portfolio_group', v.name).limit(5000)
      : none,
  ])

  let partnerCount: number | null = null
  let partnersWithCommitment: number | null = null
  if (can.lpCapital && !manco) {
    const partners = new Set<string>()
    const committed = new Map<string, number>()
    const positive = new Set<string>()
    for (const r of (commitEvents.data ?? []) as { lp_entity_id: string; amount: number | string | null }[]) {
      partners.add(r.lp_entity_id)
      committed.set(r.lp_entity_id, (committed.get(r.lp_entity_id) ?? 0) + Number(r.amount ?? 0))
    }
    for (const [id, amt] of committed) if (amt > 0) positive.add(id)
    for (const r of (positions.data ?? []) as { lp_entity_id: string; commitment: number | string | null }[]) {
      partners.add(r.lp_entity_id)
      if (Number(r.commitment ?? 0) > 0) positive.add(r.lp_entity_id)
    }
    for (const r of (lpInv.data ?? []) as { entity_id: string; commitment: number | string | null }[]) {
      partners.add(r.entity_id)
      if (Number(r.commitment ?? 0) > 0) positive.add(r.entity_id)
    }
    partnerCount = partners.size
    partnersWithCommitment = positive.size
  }

  const c = (r: { count: number | null }) => r.count
  return {
    id: v.id,
    name: v.name,
    kind: v.kind,
    vintageYear: v.vintage_year ?? null,
    hasWaterfallTerms: terms.count == null ? null : terms.count > 0,
    hasAccountingSettings: settings.count == null ? null : settings.count > 0,
    partnerCount,
    partnersWithCommitment,
    investmentTxnCount: c(txns),
    ledgerInvestmentAccounts: c(ledgerInv),
    chartAccounts: c(chart),
    postedEntries: c(posted),
    draftEntries: c(draftsRes),
    closedPeriods: c(closed),
    forecastPlans: c(plans),
  }
}
