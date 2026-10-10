// Agent tool registry — merges the pure manifest (name/description/scope/schema)
// with server-side handlers. Both the MCP endpoint and the REST agent endpoint
// dispatch through this list, so the tool surface is identical however an agent
// connects. Client code that only needs the metadata imports the manifest.

import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_TOOL_MANIFEST, type AgentToolMeta } from './agent-tools-manifest'
import type { Domain } from '@/lib/access/domains'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { carryRecipientIds, combineCarryRecipients, seesIndividualCarry } from '@/lib/access/carry-visibility'
import type { FeatureKey } from '@/lib/types/features'
import { loadPostedLedger, loadEntityNames, loadOwnership } from './load'
import { accountIdByCode, persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { computeCapitalAccounts, totalNav } from './capital-account'
import { trialBalance, balanceSheet, incomeStatement } from './statements'
import { reconcileCapital, type AdminCapitalAccount } from './reconcile'
import { runWaterfall } from './waterfall'
import { buildAllocationEntry, type AllocationBody } from './allocation-actions'
import { importBankTransactions } from './bank-import'
import { runCategorization } from './categorize-run'
import { bookCapitalCallFromInflow } from './bank-match'
import { exportLedgerText, postLedgerText } from './text-ledger-run'
import { listPeriods } from './periods'
import { closeThrough } from './close'
import { summarizeBankRec, type BankTxnState } from './bank'
import { accountBalances } from './ledger'
import type { SupabaseClient as _Sb } from '@supabase/supabase-js'
import type { JournalEntry, Posting } from './types'
import { PORTFOLIO_TOOL_MANIFEST } from '@/lib/agent/portfolio-tools-manifest'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'
import { DILIGENCE_TOOL_MANIFEST } from '@/lib/agent/diligence-tools-manifest'
import { DILIGENCE_HANDLERS } from '@/lib/agent/diligence-tools'
import { DEALS_TOOL_MANIFEST } from '@/lib/agent/deals-tools-manifest'
import { DEALS_HANDLERS } from '@/lib/agent/deals-tools'
import { LP_TOOL_MANIFEST } from '@/lib/agent/lp-tools-manifest'
import { LP_HANDLERS } from '@/lib/agent/lp-tools'
import { CONSTRUCTION_TOOL_MANIFEST } from '@/lib/agent/construction-tools-manifest'
import { CONSTRUCTION_HANDLERS } from '@/lib/agent/construction-tools'
import { FORECAST_TOOL_MANIFEST } from '@/lib/agent/forecast-tools-manifest'
import { FORECAST_HANDLERS } from '@/lib/agent/forecast-tools'
import { resolveVehicle } from './vehicle-resolver'
import { ACTUAL_BOOK } from './books'

export { resolveVehicle } from './vehicle-resolver'

export interface AgentToolContext {
  admin: SupabaseClient
  fundId: string
  /** The vehicle (portfolio_group) this call operates on. */
  portfolioGroup: string
  userId: string | null
  /**
   * The credential owner's live access. `authorizeToolUse` has already cleared the tool's own
   * domain — this is for handlers whose RESPONSE straddles domains and must trim it, exactly as a
   * route with a mixed payload does. Required, so a new tool can't quietly skip the question.
   */
  access: AccessContext
  /**
   * The deployment's public origin as the caller reached it, for tools that hand back a link
   * (lib/agent/report-links.ts). Absent = the configured site origin.
   */
  origin?: string
}

export type AgentToolHandler = (ctx: AgentToolContext, input: any) => Promise<any>
export interface AgentTool extends AgentToolMeta {
  handler: AgentToolHandler
}

const HANDLERS: Record<string, AgentToolHandler> = {
  list_accounts: async ({ admin, fundId, portfolioGroup }) => {
    const { accounts } = await loadPostedLedger(admin, fundId, portfolioGroup)
    return accounts.map(a => ({ code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
  },

  list_entities: async ({ admin, fundId, portfolioGroup }) => {
    const [names, ownership] = await Promise.all([loadEntityNames(admin, fundId, portfolioGroup), loadOwnership(admin, fundId, portfolioGroup)])
    const commitment = new Map(ownership.map(o => [o.lpEntityId, o.commitment]))
    return Array.from(names.entries()).map(([lpEntityId, name]) => ({ lpEntityId, name, commitment: commitment.get(lpEntityId) ?? 0 }))
  },

  capital_accounts: async ({ admin, fundId, portfolioGroup, access }) => {
    const [{ capitalPostings }, names] = await Promise.all([loadPostedLedger(admin, fundId, portfolioGroup), loadEntityNames(admin, fundId, portfolioGroup)])
    const accounts = computeCapitalAccounts(capitalPostings)
    // Each LP's carried-interest line is the fund's carry and is shown. What each carry RECIPIENT
    // earns is GP economics: without that grant their accounts are folded into one combined row
    // (lib/access/carry-visibility.ts), so the rows still sum to NAV.
    const all = Array.from(accounts.entries()).map(([lpEntityId, account]) => ({ id: lpEntityId, name: names.get(lpEntityId) ?? lpEntityId, ...account }))
    const { rows } = seesIndividualCarry(access)
      ? { rows: all }
      : combineCarryRecipients(all, await carryRecipientIds(admin, fundId, portfolioGroup))
    return { rows: rows.map(({ id, ...r }) => ({ lpEntityId: id, ...r })), nav: totalNav(accounts) }
  },

  financial_statements: async ({ admin, fundId, portfolioGroup }) => {
    const { accounts, postings } = await loadPostedLedger(admin, fundId, portfolioGroup)
    return {
      trialBalance: trialBalance(accounts, postings),
      balanceSheet: balanceSheet(accounts, postings),
      incomeStatement: incomeStatement(accounts, postings),
    }
  },

  list_journal: async ({ admin, fundId, portfolioGroup }, input) => {
    const limit = Math.min(Number(input?.limit ?? 100), 500)
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const { data } = await admin.from('journal_entries' as any).select('*, journal_postings(*)').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('entry_date', { ascending: false }).limit(limit)
    return data ?? []
  },

  post_entry: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const codes = await accountIdByCode(admin, fundId, portfolioGroup)
    const postings: Posting[] = (input.postings ?? []).map((p: any) => {
      // BY CODE ONLY. A raw `accountId` used to be accepted and passed straight through, which
      // let a caller name an account from a DIFFERENT vehicle — the entry still balanced, but the
      // foreign leg was dropped from every statement built on this vehicle's chart. Resolving
      // from the code means the account can only ever be one this vehicle owns.
      // (persistEntry now re-checks this too; both belt and braces are cheap.)
      const accountId = codes.get(String(p.accountCode))
      if (!accountId) throw new Error(`Unknown account code ${p.accountCode} for ${portfolioGroup}`)
      return { accountId, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lpEntityId ?? null }
    })
    const entry: JournalEntry = { fundId, entryDate: input.entryDate, memo: input.memo ?? null, sourceType: input.sourceType ?? 'manual', postings }
    const result = await persistEntry(admin, fundId, portfolioGroup, userId, entry, input.status === 'draft' ? 'draft' : 'posted')
    if ('error' in result) throw new Error(result.error)
    return { entryId: result.entryId }
  },

  allocation: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const built = await buildAllocationEntry(admin, fundId, portfolioGroup, input as AllocationBody)
    if ('error' in built) throw new Error(built.error)
    if (input.post === false) return { preview: built.entry }
    const result = await persistEntry(admin, fundId, portfolioGroup, userId, built.entry, 'posted')
    if ('error' in result) throw new Error(result.error)
    return { entryId: result.entryId, entry: built.entry }
  },

  reconcile: async ({ admin, fundId, portfolioGroup }, input) => {
    const { capitalPostings } = await loadPostedLedger(admin, fundId, portfolioGroup)
    const ledger = computeCapitalAccounts(capitalPostings)
    const adminMap = new Map<string, AdminCapitalAccount>(Object.entries(input?.admin ?? {}))
    return reconcileCapital(ledger, adminMap, typeof input?.tolerance === 'number' ? input.tolerance : 0.01)
  },

  run_waterfall: async (_ctx, input) => runWaterfall(Number(input.distributable), input.terms, input.state),

  list_periods: async ({ admin, fundId, portfolioGroup }) => listPeriods(admin, fundId, portfolioGroup),

  // Closes THROUGH a date, allocating as it goes — the same single path the UI uses.
  //
  // This used to call the legacy `closePeriod`, which locked an arbitrary range and allocated
  // NOTHING. Any P&L inside that range was then stranded permanently: never allocated to a
  // partner, and unreachable by a real close, because `closeThrough` refuses to overlap an
  // existing period. An external agent could silently and irreversibly break the books.
  //
  // The close is the only allocation path. There is no second one.
  close_period: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const through = String(input.periodEnd ?? input.through ?? '')
    if (!through) throw new Error('periodEnd (the date to close through) is required')
    const result = await closeThrough(admin, fundId, portfolioGroup, userId, through)
    if ('error' in result) throw new Error(result.error)
    return result
  },

  export_ledger_text: async ({ admin, fundId, portfolioGroup }) => ({ text: await exportLedgerText(admin, fundId, portfolioGroup) }),

  post_ledger_text: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    return postLedgerText(admin, fundId, portfolioGroup, userId, String(input.text ?? ''), input.status, input.reviewToken, hasAccess(access, 'lp_capital', 'read'))
  },

  import_bank_transactions: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    const result = await importBankTransactions(admin, fundId, portfolioGroup, userId, String(input.csv ?? ''), String(input.source ?? 'csv'), input.reviewToken, hasAccess(access, 'lp_capital', 'read'))
    if ('error' in result) throw new Error(result.error)
    return result
  },

  categorize_bank_transactions: async ({ admin, fundId, portfolioGroup }, input) => {
    const result = await runCategorization(admin, fundId, portfolioGroup, Array.isArray(input?.ids) ? input.ids : undefined)
    if ('error' in result) throw new Error(result.error)
    return result
  },

  book_capital_call: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const result = await bookCapitalCallFromInflow(admin, fundId, portfolioGroup, userId, String(input.bankTransactionId))
    if ('error' in result) throw new Error(result.error)
    return result
  },

  list_bank_transactions: async ({ admin, fundId, portfolioGroup }) => {
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const { data } = await admin
      .from('bank_transactions' as any)
      .select('id, txn_date, amount, description, counterparty, status, suggested_account_code, journal_entry_id')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .order('txn_date', { ascending: false })
      .limit(1000)
    return data ?? []
  },

  bank_reconciliation: async ({ admin, fundId, portfolioGroup }) => {
    const { accounts, postings } = await loadPostedLedger(admin, fundId, portfolioGroup)
    const cash = accounts.find(a => a.code === '1000')
    const ledgerCashBalance = cash ? (accountBalances(postings).get(cash.id) ?? 0) : 0
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const { data } = await admin.from('bank_transactions' as any).select('amount, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'ignored')
    const txns: BankTxnState[] = ((data as any[]) ?? []).map(t => ({ amount: Number(t.amount), matched: t.status === 'reconciled' }))
    return summarizeBankRec(txns, ledgerCashBalance)
  },
}

const VEHICLE_PROP = { type: 'string', description: 'vehicle (portfolio_group); optional when the fund has a single vehicle' }

/** Bind a domain's manifest to its handlers, failing loudly if either side is missing one. */
function bind(manifest: AgentToolMeta[], handlers: Record<string, AgentToolHandler>): AgentTool[] {
  return manifest.map(meta => {
    const handler = handlers[meta.name]
    if (!handler) throw new Error(`No handler for agent tool ${meta.name}`)
    return { ...meta, handler }
  })
}

/**
 * The whole tool surface, across every domain the firm has. One registry, so MCP and REST
 * expose the same thing and an agent can move between "what is in the pipeline", "what
 * does the fund own", "what do the LPs hold" and "what do the books say" without changing
 * endpoints or keys.
 *
 * LEDGER TOOLS ARE THE ODD ONE OUT, and that is the only thing `domain` changes at
 * dispatch. A ledger tool operates on ONE set of books, so the caller must land on exactly
 * one vehicle and we inject `vehicle` as that scope. Every other domain is fund-wide — a
 * company can sit in several vehicles, a deal sits in none — so `vehicle` is at most an
 * optional filter they declare themselves. Forcing them to pick one would make "list every
 * company" (or every deal) impossible on a multi-vehicle fund.
 */
export const AGENT_TOOLS: AgentTool[] = [
  ...AGENT_TOOL_MANIFEST.map(meta => {
    const handler = HANDLERS[meta.name]
    if (!handler) throw new Error(`No handler for agent tool ${meta.name}`)
    const inputSchema = { ...meta.inputSchema, properties: { ...(meta.inputSchema.properties ?? {}), vehicle: VEHICLE_PROP } }
    return { ...meta, domain: 'ledger' as const, inputSchema, handler }
  }),
  ...bind(PORTFOLIO_TOOL_MANIFEST, PORTFOLIO_HANDLERS),
  ...bind(DILIGENCE_TOOL_MANIFEST, DILIGENCE_HANDLERS),
  ...bind(DEALS_TOOL_MANIFEST, DEALS_HANDLERS),
  ...bind(LP_TOOL_MANIFEST, LP_HANDLERS),
  ...bind(CONSTRUCTION_TOOL_MANIFEST, CONSTRUCTION_HANDLERS),
  ...bind(FORECAST_TOOL_MANIFEST, FORECAST_HANDLERS),
]

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find(t => t.name === name)
}

/** Ledger tools are scoped to a vehicle; portfolio tools are scoped to the fund. */
export function isLedgerTool(tool: AgentToolMeta): boolean {
  return (tool.domain ?? 'ledger') === 'ledger'
}

/**
 * The dispatch grouping's access domain, where a tool doesn't name its own. A default, not a
 * synonym: `ledger` covers plain bookkeeping, but several ledger tools are really LP capital or GP
 * economics and say so via `accessDomain`.
 */
const ACCESS_DOMAIN_BY_DISPATCH: Record<NonNullable<AgentToolMeta['domain']>, Domain> = {
  ledger: 'accounting',
  portfolio: 'portfolio',
  diligence: 'diligence',
  deals: 'dealflow',
  lp: 'lp_capital',
}

/** Which content area a tool touches — the question `authorizeToolUse` answers against. */
export function accessDomainFor(tool: AgentToolMeta): Domain {
  return tool.accessDomain ?? ACCESS_DOMAIN_BY_DISPATCH[tool.domain ?? 'ledger']
}

/**
 * The fund-level switch a tool answers to, if it named one.
 *
 * Domains that span several switches have no `primaryFeature`, and `effectiveAccess` with no
 * feature treats the ceiling as open — so a tool under `portfolio`/`relationships`/`lp_relations`
 * that doesn't name its key is NOT subject to hidden/off over MCP, admins included. Web routes
 * name theirs in route-domains.ts; this is the same idea for tools.
 */
export function accessFeatureFor(tool: AgentToolMeta): FeatureKey | undefined {
  return tool.accessFeature
}

/**
 * Tools whose domain depends on their INPUT. Only one so far, and it earns its keep: `allocation`
 * runs the whole period close — fees, expenses, gains — which is ordinary accounting work, but the
 * same tool with `action: 'carry'` computes and returns each partner's carry. Gating the tool at
 * gp_economics would lock ops staff out of the close; gating it at accounting would hand them the
 * carry. So the action decides.
 */
const INPUT_ELEVATIONS: Record<string, (input: any) => Domain | null> = {
  allocation: input => (input?.action === 'carry' ? 'gp_economics' : null),
}

/** The domain a specific CALL touches, accounting for input-dependent elevation. */
export function accessDomainForCall(tool: AgentToolMeta, input: unknown): Domain {
  return INPUT_ELEVATIONS[tool.name]?.(input) ?? accessDomainFor(tool)
}

/**
 * Resolve the vehicle (portfolio_group) a call targets: the explicit `vehicle` argument, or the
 * sole vehicle if the fund has exactly one. Throws (with the list) when it's ambiguous.
 *
 * THE REQUESTED NAME IS VALIDATED AGAINST THE REGISTRY. It used to be returned verbatim — and
 * since every accounting route funnels through here (via `resolveGroupOr400`), an arbitrary
 * string reached the whole module. Most callees survived because `vehicleIdByName` returns null
 * and they refuse; the chart-seed path did not, and would happily insert ~40 chart rows with
 * `vehicle_id = NULL` and the caller's made-up name, repeatable with a fresh string every time.
 * Those rows are invisible to every read (all of which filter on `vehicle_id`), which is exactly
 * the orphan class the rest of the module works hard to prevent.
 *
 * Validating once, here, closes it everywhere instead of per-callee.
 */
/**
 * The vehicle a tool call runs against. Portfolio tools get an empty string: they never
 * read `ctx.portfolioGroup` (they take `vehicle` from their own input as a filter), and
 * making them resolve one would throw on any fund with more than one vehicle.
 */
export async function resolveVehicleForTool(
  tool: AgentToolMeta,
  admin: _Sb,
  fundId: string,
  requested: string | undefined,
  /** The credential owner's access — required, so a tool can only reach their entities. */
  access: Pick<AccessContext, 'vehicles'>,
): Promise<string> {
  if (!isLedgerTool(tool)) return ''
  return resolveVehicle(admin, fundId, requested, { access })
}
