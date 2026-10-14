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
import { loadPostedLedger, loadEntityNames, loadOwnership, fetchAllRows } from './load'
import { accountIdByCode, duplicateRefMessage, liveEntryByRef, persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { computeCapitalAccounts, totalNav } from './capital-account'
import { trialBalance, balanceSheet, incomeStatement } from './statements'
import { vehicleKindByName } from './vehicle-domain'
import { closesToOwnerEquity, equityLabel } from './vocab'
import { changesInMembersCapital } from './members-capital'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { reconcileCapital, type AdminCapitalAccount } from './reconcile'
import { runWaterfall } from './waterfall'
import { allocationSourceRef, buildAllocationEntry, type AllocationBody } from './allocation-actions'
import { importBankTransactions } from './bank-import'
import { normalizeQbTransactions, parseQbJournal } from './quickbooks/parse-journal'
import { importQbJournal, proposeQbAccounts, saveQbMappings } from './quickbooks/import-journal'
import { journalSource } from './quickbooks/sources'
import { addChartAccount } from './chart-add'
import { addPartner, parseAddPartnerInput } from './add-partner'
import { postBankTransaction, setBankTransactionAccount } from './bank-actions'
import { mayTouchInvestments } from './investment-access'
import { runCategorization } from './categorize-run'
import { bookCapitalCallFromInflow } from './bank-match'
import { exportLedgerTextPage, postLedgerText } from './text-ledger-run'
import { listPeriods } from './periods'
import { closeThrough, previewCloseThrough } from './close'
import { openingCashBefore, summarizeBankRec, type BankTxnState } from './bank'
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
import { LP_RECORD_HANDLERS } from '@/lib/agent/lp-record-tools'
import { DOCUMENT_TOOL_MANIFEST } from '@/lib/agent/document-tools-manifest'
import { DOCUMENT_HANDLERS } from '@/lib/agent/document-tools'
import { CONSTRUCTION_TOOL_MANIFEST } from '@/lib/agent/construction-tools-manifest'
import { CONSTRUCTION_HANDLERS } from '@/lib/agent/construction-tools'
import { FORECAST_TOOL_MANIFEST } from '@/lib/agent/forecast-tools-manifest'
import { FORECAST_HANDLERS } from '@/lib/agent/forecast-tools'
import { SETUP_TOOL_MANIFEST } from '@/lib/agent/setup-tools-manifest'
import { SETUP_HANDLERS } from '@/lib/agent/setup-tools'
import { LP_PORTAL_TOOL_MANIFEST } from '@/lib/agent/lp-portal-tools-manifest'
import { LP_PORTAL_HANDLERS } from '@/lib/agent/lp-portal-tools'
import { REPORT_TOOL_MANIFEST } from '@/lib/agent/report-tools-manifest'
import { REPORT_HANDLERS } from '@/lib/agent/report-tools'
import { LETTER_TOOL_MANIFEST } from '@/lib/agent/letter-tools-manifest'
import { LETTER_HANDLERS } from '@/lib/agent/letter-tools'
import { QUERY_TOOL_MANIFEST } from '@/lib/agent/query-tools-manifest'
import { QUERY_HANDLERS } from '@/lib/agent/query-tools'
import { ENTITY_OPERATIONS_TOOL_MANIFEST, OPERATIONS_TOOL_MANIFEST } from '@/lib/agent/operations-tools-manifest'
import { OPERATIONS_HANDLERS } from '@/lib/agent/operations-tools'
import { DESTRUCTIVE_LEDGER_TOOL_MANIFEST, DESTRUCTIVE_TOOL_MANIFEST } from '@/lib/agent/destructive-tools-manifest'
import { DESTRUCTIVE_HANDLERS } from '@/lib/agent/destructive-tools'

import { UPLOAD_TOOL_MANIFEST } from '@/lib/agent/upload-tools-manifest'
import { UPLOAD_HANDLERS } from '@/lib/agent/upload-tools'
import { SERVER_AI_TOOL_MANIFEST } from '@/lib/agent/server-ai-tools-manifest'
import { SERVER_AI_HANDLERS } from '@/lib/agent/server-ai-tools'
import { reopenClosedPeriods } from './reopen'
import { resolveVehicle } from './vehicle-resolver'
import { resolveVehicleWithAccess } from './http-vehicle'
import { ACTUAL_BOOK } from './books'
import { readBulkScope, runBulkDraftAction } from './journal-bulk'
import { addEntityDocument, entityDocumentUploadUrl, listEntityDocuments } from '@/lib/entity-documents/agent'
import { RECEIPT_TOOL_MANIFEST } from '@/lib/agent/receipt-tools-manifest'
import { RECEIPT_HANDLERS } from '@/lib/agent/receipt-tools'

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

/** `limit` (clamped to [1, max]) and the offset a `cursor` from a previous page names. */
function pageArgs(input: any, dflt: number, max: number): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, Math.floor(Number(input?.limit ?? dflt)) || dflt), max)
  const offset = Math.max(0, Math.floor(Number(input?.cursor ?? 0)) || 0)
  return { limit, offset }
}

/** An optional YYYY-MM-DD filter argument; anything else is refused rather than ignored. */
function dateArg(input: any, key: string): string | undefined {
  const v = input?.[key]
  if (v == null || v === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${key} must be an ISO date (YYYY-MM-DD)`)
  return String(v)
}

/** One page of a list tool: the rows, whether more remain, and — when they do — the cursor and a
 *  note saying how to continue, so a partial list can never pass for the whole one. */
function pageResult<T>(rows: T[], offset: number, limit: number, total: number | null | undefined, tool: string, noun: string) {
  const hasMore = total != null ? offset + rows.length < total : rows.length === limit
  const nextCursor = hasMore ? String(offset + rows.length) : null
  return {
    rows,
    total: total ?? null,
    hasMore,
    nextCursor,
    ...(hasMore ? { note: `Showing ${noun} ${offset + 1}-${offset + rows.length}${total != null ? ` of ${total}` : ''}. Call ${tool} again with cursor "${nextCursor}" for more.` } : {}),
  }
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
    const [{ accounts, postings, sourcedPostings }, kind] = await Promise.all([
      loadPostedLedger(admin, fundId, portfolioGroup),
      vehicleKindByName(admin, fundId, portfolioGroup),
    ])
    return {
      trialBalance: trialBalance(accounts, postings),
      balanceSheet: balanceSheet(accounts, postings, { equityLabel: equityLabel(kind), itemizeEquity: closesToOwnerEquity(kind) }),
      incomeStatement: incomeStatement(accounts, postings),
      // A management company's members have no statements of their own; this is each member's
      // capital roll-forward since inception (lib/accounting/members-capital.ts).
      ...(isManagementCompany(kind)
        ? { changesInMembersCapital: changesInMembersCapital(accounts, sourcedPostings, { start: null, end: null }) }
        : {}),
    }
  },

  // Newest first, one page per call. A bare array used to stop at `limit` with no sign there was
  // more, so an agent reading "the journal" could reason from the newest 100 entries alone.
  list_journal: async ({ admin, fundId, portfolioGroup }, input) => {
    const { limit, offset } = pageArgs(input, 100, 500)
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    let q = admin.from('journal_entries' as any).select('*, journal_postings(*)', { count: 'exact' }).eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    const start = dateArg(input, 'start'), end = dateArg(input, 'end')
    if (start) q = q.gte('entry_date', start)
    if (end) q = q.lte('entry_date', end)
    const { data, error, count } = await q.order('entry_date', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1)
    if (error) throw new Error(`The journal could not be read: ${error.message}`)
    return pageResult((data as any[]) ?? [], offset, limit, count, 'list_journal', 'entries')
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

  add_account: async ({ admin, fundId, portfolioGroup }, input) => {
    const result = await addChartAccount(admin, fundId, portfolioGroup, input ?? {})
    if ('error' in result) throw new Error(result.error)
    return result.account
  },

  add_partner: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    // No closingId: admission to a closing stays a decision for the UI.
    const parsed = parseAddPartnerInput({ name: input?.name, partnerClass: input?.partnerClass, commitment: input?.commitment })
    if ('error' in parsed) throw new Error(parsed.error)
    const result = await addPartner(admin, fundId, portfolioGroup, userId, parsed)
    if ('error' in result) throw new Error(result.error)
    return result
  },

  allocation: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const built = await buildAllocationEntry(admin, fundId, portfolioGroup, input as AllocationBody)
    if ('error' in built) throw new Error(built.error)
    // IDEMPOTENT BY CONTENT. This tool used to post with no source_ref, so two chats asked for
    // the same carry reallocation booked it twice. The ref is derived from what the entry does
    // (action, date, lines), and a live entry already carrying it is refused by name — here, with
    // the friendlier message, and by the unique index if two posts race.
    const sourceRef = allocationSourceRef(String(input.action), built.entry)
    const entry: JournalEntry = { ...built.entry, sourceRef }
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const existing = vehicleId ? await liveEntryByRef(admin, fundId, vehicleId, sourceRef) : null
    if (input.post === false) return { preview: entry, ...(existing ? { alreadyBooked: existing } : {}) }
    if (existing) throw new Error(duplicateRefMessage(sourceRef, existing))
    const result = await persistEntry(admin, fundId, portfolioGroup, userId, entry, 'posted')
    if ('error' in result) throw new Error(result.error)
    return { entryId: result.entryId, entry }
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

  // The Periods page's preview: what closing through a date would do, changing nothing.
  preview_close: async ({ admin, fundId, portfolioGroup }, input) => {
    const through = String(input?.periodEnd ?? input?.through ?? '')
    if (!through) throw new Error('periodEnd (the date to close through) is required')
    const result = await previewCloseThrough(admin, fundId, portfolioGroup, through)
    if ('error' in result) throw new Error(result.error)
    return result
  },

  // The Periods page's Reopen: the same lib function, reason and audit event (lib/accounting/reopen.ts).
  // Admin-only (ADMIN_ONLY_TOOLS), so from chat it is staged for an admin to approve.
  reopen_period: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    if (!userId) throw new Error('Reopening a period needs a signed-in user to record on the audit trail.')
    const result = await reopenClosedPeriods(admin, { fundId, userId }, portfolioGroup, {
      id: input?.period_id, fromDate: input?.from_date, reason: input?.reason,
    })
    if (!result.ok) throw new Error(result.error)
    return { vehicle: portfolioGroup, ...result.value }
  },

  // Pages instead of truncating: `truncated` + `cursor` when the text would be too large to return.
  export_ledger_text: async ({ admin, fundId, portfolioGroup }, input) => {
    return exportLedgerTextPage(admin, fundId, portfolioGroup, {
      start: dateArg(input, 'start'),
      end: dateArg(input, 'end') ?? dateArg(input, 'asOf'),
      cursor: input?.cursor,
    })
  },

  post_ledger_text: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    return postLedgerText(admin, fundId, portfolioGroup, userId, String(input.text ?? ''), input.status, input.reviewToken, hasAccess(access, 'lp_capital', 'read'))
  },

  import_bank_transactions: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    const result = await importBankTransactions(admin, fundId, portfolioGroup, userId, String(input.csv ?? ''), String(input.source ?? 'csv'), input.reviewToken, hasAccess(access, 'lp_capital', 'read'))
    // A review hold is not a failure: return the differences and their token, as post_ledger_text
    // does. Throwing here dropped both, so an agent could never present them or supply the token.
    if ('error' in result && result.importReview) return { imported: 0, reviewRequired: true, error: result.error, importReview: result.importReview }
    if ('error' in result) throw new Error(result.error)
    return result
  },

  journal_import_accounts: async ({ admin, fundId, portfolioGroup }, input) => {
    return proposeQbAccounts(admin, fundId, portfolioGroup, qbInput(input), journalSource(input?.source))
  },

  save_journal_mapping: async ({ admin, fundId, portfolioGroup }, input) => {
    if (!Array.isArray(input?.rows)) throw new Error('rows[] is required')
    return saveQbMappings(admin, fundId, portfolioGroup, input.rows, journalSource(input?.source))
  },

  import_journal: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    const source = journalSource(input?.source)
    const { transactions, errors } = qbInput(input)
    const result = await importQbJournal(admin, {
      fundId,
      group: portfolioGroup,
      source,
      userId,
      transactions,
      parseErrors: errors,
      dryRun: !!input?.dryRun,
      reviewToken: input?.reviewToken ?? null,
      includeLp: hasAccess(access, 'lp_capital', 'read'),
      sourceLabel: typeof input?.sourceLabel === 'string' ? input.sourceLabel : `agent (${source})`,
    })
    // A review hold is not a failure — same shape as import_bank_transactions.
    if ('reviewRequired' in result) return { created: 0, reviewRequired: true, error: result.error, importReview: result.importReview }
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

  set_bank_transaction_account: async ({ admin, fundId, portfolioGroup }, input) => {
    const result = await setBankTransactionAccount(admin, fundId, portfolioGroup, String(input?.bankTransactionId ?? ''), input?.accountCode, 'ai')
    if ('error' in result) throw new Error(result.error)
    return result
  },

  post_bank_transaction: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    const result = await postBankTransaction(admin, fundId, portfolioGroup, userId, String(input?.bankTransactionId ?? ''), { investments: mayTouchInvestments(access) })
    if ('error' in result) throw new Error(String(result.error))
    return result
  },

  // The journal's bulk post, one page per call (each post adopts and may allocate, so a page is
  // kept small enough to finish inside a request).
  post_drafts: async ({ admin, fundId, portfolioGroup, userId, access }, input) => {
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const result = await runBulkDraftAction(admin, {
      fundId, vehicleId, group: portfolioGroup, action: 'post', scope: readBulkScope(input), userId,
      investments: mayTouchInvestments(access), allocate: input?.allocate !== false, batchSize: 100,
    })
    if (!result.ok) throw new Error(String((result.error as any)?.message ?? result.error))
    const { changed, skipped, warnings, hasMore, cursor } = result.outcome
    return { posted: changed, skipped, warnings, hasMore, cursor }
  },

  // The journal's bulk discard (api/accounting/journal/bulk-void): drafts only, never a posted entry.
  discard_drafts: async ({ admin, fundId, portfolioGroup, userId }, input) => {
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    const result = await runBulkDraftAction(admin, {
      fundId, vehicleId, group: portfolioGroup, action: 'void', scope: readBulkScope(input), userId,
    })
    if (!result.ok) throw new Error(String((result.error as any)?.message ?? result.error))
    const { changed, skipped, hasMore, cursor } = result.outcome
    return { discarded: changed, skipped, hasMore, cursor }
  },

  list_bank_transactions: async ({ admin, fundId, portfolioGroup }, input) => {
    const { limit, offset } = pageArgs(input, 500, 1000)
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    let q = admin
      .from('bank_transactions' as any)
      .select('id, txn_date, amount, description, counterparty, status, suggested_account_code, journal_entry_id', { count: 'exact' })
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
    if (input?.status) q = q.eq('status', String(input.status))
    const start = dateArg(input, 'start'), end = dateArg(input, 'end')
    if (start) q = q.gte('txn_date', start)
    if (end) q = q.lte('txn_date', end)
    const { data, error, count } = await q.order('txn_date', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1)
    if (error) throw new Error(`Bank transactions could not be read: ${error.message}`)
    return pageResult((data as any[]) ?? [], offset, limit, count, 'list_bank_transactions', 'transactions')
  },

  bank_reconciliation: async ({ admin, fundId, portfolioGroup }) => {
    const { accounts, postings } = await loadPostedLedger(admin, fundId, portfolioGroup)
    const cash = accounts.find(a => a.code === '1000')
    const ledgerCashBalance = cash ? (accountBalances(postings).get(cash.id) ?? 0) : 0
    const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
    // Every row, paged: past 1000 the unmatched count and difference were silently understated.
    const data = await fetchAllRows<any>((f, t) => admin.from('bank_transactions' as any).select('id, txn_date, amount, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'ignored').order('id').range(f, t))
    const txns: BankTxnState[] = data.map(t => ({ amount: Number(t.amount), matched: t.status === 'reconciled' }))
    return summarizeBankRec(txns, ledgerCashBalance, openingCashBefore(postings, cash?.id, data.map(t => t.txn_date)))
  },

  list_entity_documents: async ({ admin, fundId, portfolioGroup, userId }) =>
    listEntityDocuments(await documentScope(admin, fundId, portfolioGroup, userId)),

  entity_document_upload_url: async ({ admin, fundId, portfolioGroup, userId }, input) =>
    entityDocumentUploadUrl(await documentScope(admin, fundId, portfolioGroup, userId), input ?? {}),

  add_entity_document: async ({ admin, fundId, portfolioGroup, userId }, input) =>
    addEntityDocument(await documentScope(admin, fundId, portfolioGroup, userId), input ?? {}),
}

/** The resolved vehicle a document tool works in. The dispatcher has already checked the caller can see it. */
async function documentScope(admin: SupabaseClient, fundId: string, portfolioGroup: string, userId: string | null) {
  const vehicleId = await vehicleIdByName(admin, fundId, portfolioGroup)
  if (!vehicleId) throw new Error(`Unknown vehicle "${portfolioGroup}"`)
  return { admin, fundId, vehicleId, userId }
}

const VEHICLE_PROP = { type: 'string', description: 'vehicle (portfolio_group), or a management company by name; optional when the fund has a single vehicle' }

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
/** The same for tools on ONE entity's books: the dispatcher resolves the entity, `vehicle` names it. */
function bindLedger(manifest: AgentToolMeta[], handlers: Record<string, AgentToolHandler>): AgentTool[] {
  return bind(manifest, handlers).map(tool => ({
    ...tool,
    domain: 'ledger' as const,
    inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties ?? {}), vehicle: VEHICLE_PROP } },
  }))
}

export const AGENT_TOOLS: AgentTool[] = [
  ...bindLedger(AGENT_TOOL_MANIFEST, HANDLERS),
  ...bindLedger(ENTITY_OPERATIONS_TOOL_MANIFEST, OPERATIONS_HANDLERS),
  ...bindLedger(RECEIPT_TOOL_MANIFEST, RECEIPT_HANDLERS),
  ...bind(PORTFOLIO_TOOL_MANIFEST, PORTFOLIO_HANDLERS),
  ...bind(DILIGENCE_TOOL_MANIFEST, DILIGENCE_HANDLERS),
  ...bind(DEALS_TOOL_MANIFEST, DEALS_HANDLERS),
  ...bind(LP_TOOL_MANIFEST, { ...LP_HANDLERS, ...LP_RECORD_HANDLERS }),
  ...bind(DOCUMENT_TOOL_MANIFEST, DOCUMENT_HANDLERS),
  ...bind(CONSTRUCTION_TOOL_MANIFEST, CONSTRUCTION_HANDLERS),
  ...bind(FORECAST_TOOL_MANIFEST, FORECAST_HANDLERS),
  ...bind(SETUP_TOOL_MANIFEST, SETUP_HANDLERS),
  ...bind(REPORT_TOOL_MANIFEST, REPORT_HANDLERS),
  ...bind(LETTER_TOOL_MANIFEST, LETTER_HANDLERS),
  ...bind(QUERY_TOOL_MANIFEST, QUERY_HANDLERS),
  ...bind(OPERATIONS_TOOL_MANIFEST, OPERATIONS_HANDLERS),
  ...bind(LP_PORTAL_TOOL_MANIFEST, LP_PORTAL_HANDLERS),

  // Offered only with AGENT_DESTRUCTIVE_ACTIONS=true, and always staged for an admin (lib/agent/destructive.ts).
  ...bindLedger(DESTRUCTIVE_LEDGER_TOOL_MANIFEST, DESTRUCTIVE_HANDLERS), ...bind(DESTRUCTIVE_TOOL_MANIFEST, DESTRUCTIVE_HANDLERS),

  ...bind(UPLOAD_TOOL_MANIFEST, UPLOAD_HANDLERS),
  ...bind(SERVER_AI_TOOL_MANIFEST, SERVER_AI_HANDLERS),
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
  access: AccessContext,
): Promise<string> {
  if (!isLedgerTool(tool)) return ''
  // A NAMED entity may be a management company. Its books are gated on `management_company` as
  // well as the `accounting` grant the caller has already cleared (the same conjunction
  // `assertVehicleDomain` applies to /api/accounting/*), so it resolves through
  // resolveVehicleWithAccess, which opts in and checks that grant at the tool's own level before
  // returning. The unnamed default still never picks a manco.
  if (requested?.trim()) return (await resolveVehicleWithAccess(admin, access, requested, tool.scope)).name
  return resolveVehicle(admin, fundId, requested, { access })
}

/** Journal-import tool input: structured `transactions` from a connector, or a pasted QuickBooks Journal `text`. */
function qbInput(input: any) {
  if (Array.isArray(input?.transactions)) return normalizeQbTransactions(input.transactions)
  if (typeof input?.text === 'string' && input.text.trim()) return parseQbJournal(input.text)
  throw new Error('Pass transactions (structured) or text (a Journal report export).')
}
