// The accounting half of the unified Analyst: it gathers a vehicle's books (chart, balances,
// recent entries, partner capital) as prompt context, supplies the prompt text that teaches the
// Analyst to reason about them and to hand back drafted entries, and applies a drafted entry.
//
// The Analyst that consumes all of this is /api/analyst — and it appends any of it ONLY for a
// user entitled to accounting. See plans/plan-unified-analyst.md. Nothing here posts to the books:
// a proposal is applied as a DRAFT entry the user reviews and posts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger, loadEntityNames } from './load'
import { accountBalances, assertBalanced } from './ledger'
import { accountIdByCode, persistEntry } from './persist'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { fundCurrency } from './currency'
import { vehicleIdByName } from './vehicle-id'
import { releaseOwnership, type OwningTransaction } from './ownership'
import { setGeneratedAllocationStatus } from './continuous-allocation'
import { lpCapitalSummary } from './capital-calls'
import { ENTRY_SOURCE_TYPES } from './source-types'
import { loadVehicleGpLinks } from './gp-links'
import type { JournalEntry, Posting } from './types'
import { ACTUAL_BOOK } from './books'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

export interface AssistantProposalPosting { accountCode: string; amount: number; lpEntity?: string | null }
export interface AssistantProposal {
  type: 'create' | 'edit'
  entryId?: string | null
  entryDate: string
  memo: string
  sourceType?: string | null
  postings: AssistantProposalPosting[]
  rationale: string
}

/** A readable snapshot of one vehicle's books. `full` includes the chart and more
 *  history (for the primary vehicle); related entities get a compact version. */
async function vehicleBooks(admin: SupabaseClient, fundId: string, group: string, label: string, full: boolean): Promise<string> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [{ data: acctRows }, { accounts, postings }, { data: entryRows }] = await Promise.all([
    admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype').eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('code'),
    loadPostedLedger(admin, fundId, group),
    admin.from('journal_entries' as any)
      .select('id, entry_date, memo, source_type, status, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void')
      .order('entry_date', { ascending: false }).limit(full ? 40 : 12),
  ])

  const codeById = new Map<string, string>(((acctRows as any[]) ?? []).map(a => [a.id, `${a.code} ${a.name}`]))
  const bal = accountBalances(postings)
  const balLines = accounts
    .map(a => ({ a, b: bal.get(a.id) ?? 0 }))
    .filter(x => Math.abs(x.b) > 0.005)
    .map(x => `  ${x.a.code} ${x.a.name} (${x.a.type}): ${x.b.toFixed(2)}`)
    .join('\n')
  const entryLines = ((entryRows as any[]) ?? []).map(e => {
    const posts = ((e.journal_postings ?? []) as any[])
      .map(p => `${codeById.get(p.account_id) ?? p.account_id.slice(0, 8)} ${Number(p.amount).toFixed(2)}`)
      .join('; ')
    return `  [${e.id}] ${e.entry_date} "${e.memo ?? e.source_type ?? ''}" (${e.status}): ${posts}`
  }).join('\n')

  const parts = [`### ${label}`]
  if (full) {
    const chartLines = ((acctRows as any[]) ?? []).map(a => `  ${a.code}  ${a.name} (${a.type}${a.subtype ? '/' + a.subtype : ''})`).join('\n')
    parts.push(`CHART OF ACCOUNTS:\n${chartLines || '  (none)'}`)
  }
  parts.push(`ACCOUNT BALANCES (debit +, credit -):\n${balLines || '  (all zero)'}`)
  parts.push(`RECENT ENTRIES (id, date, memo, status, postings "code amount"):\n${entryLines || '  (none)'}`)
  return parts.join('\n')
}

/**
 * What of a vehicle's books to include.
 *
 * Partner capital is NOT optional and deliberately isn't listed here: the chart has one named
 * capital account per partner, so the balances and entries below carry them anyway. `accounting`
 * implies `lp_capital` for exactly that reason (see DOMAIN_META.lp_capital.impliedBy), and an
 * option that could never be false would only imply a protection that doesn't exist.
 *
 * The GP/associate entities ARE separable — carry isn't structurally part of this vehicle's
 * ledger — so that one is a real choice the caller must make.
 */
export interface AccountingContextOptions {
  includeRelatedEntities: boolean
  /** The caller's access. Required: related entities' books are included only for entities they were granted. */
  access: Pick<AccessContext, 'vehicles'>
}

/**
 * The entities whose books sit beside the primary vehicle's: GP/associate entities linked as its GP;
 * if it is itself a GP, every vehicle it serves; before any links exist, every associate. Then only
 * those the caller can see — a GP serving your fund is not thereby yours.
 */
export function relatedEntities<V extends { id: string; kind: string }>(
  veh: V[],
  links: Array<{ gpVehicleId: string; servedVehicleId: string }>,
  vehicleId: string | null | undefined,
  access: Pick<AccessContext, 'vehicles'>,
): V[] {
  const vehById = new Map(veh.map(v => [v.id, v]))
  const current = vehicleId ? vehById.get(vehicleId) : undefined
  const associates = veh.filter(v => v.kind === 'associate' && v.id !== vehicleId)
  // Associate vehicles that are a GP OF the current vehicle.
  const linked = links
    .filter(l => l.servedVehicleId === vehicleId)
    .map(l => vehById.get(l.gpVehicleId))
    .filter((v): v is V => !!v && v.kind === 'associate' && v.id !== vehicleId)
  // If the current vehicle is itself a GP/associate, every vehicle it serves.
  const servedByCurrent = links
    .filter(l => l.gpVehicleId === vehicleId)
    .map(l => vehById.get(l.servedVehicleId))
    .filter((v): v is V => !!v)
  // Dedupe (a vehicle could in principle appear via both directions).
  let related = Array.from(new Map([...linked, ...servedByCurrent].map(v => [v.id, v])).values())
  if (related.length === 0 && current?.kind !== 'associate') related = associates
  return related.filter(v => canSeeVehicle(access, v.id))
}

/** The full context: the primary vehicle (chart, balances, entries, partner capital) plus the
 *  related GP/associate entities if the caller is entitled to them. */
async function gatherContext(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  options: AccountingContextOptions,
): Promise<string> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  const primary = await vehicleBooks(admin, fundId, group, `PRIMARY VEHICLE: ${group}`, true)

  let capText = ''
  try {
    const rows = await lpCapitalSummary(admin, fundId, group)
    if (rows.length) {
      capText = '\nPARTNER CAPITAL (per partner — commitment / called / funded / outstanding / NAV):\n' +
        rows.map(r => `  ${r.name}${r.partnerClass === 'gp' ? ' [GP]' : ''}: commit ${r.commitment.toFixed(2)}, called ${(r.called == null ? 'unknown' : r.called.toFixed(2))}, funded ${(r.funded == null ? 'unknown' : r.funded.toFixed(2))}, outstanding ${(r.outstanding == null ? 'unknown' : r.outstanding.toFixed(2))}, NAV ${(r.ending == null ? 'unknown' : r.ending.toFixed(2))}`).join('\n')
    }
  } catch { /* LP data may be absent */ }

  if (!options.includeRelatedEntities) {
    return primary + capText
  }

  // Related GP/associate entities: those explicitly linked to this vehicle (many-to-many, via
  // vehicle_gp_links), else (before any links are set) every associate entity in the fund.
  let veh: any[] = []
  try {
    const { data, error } = await admin.from('fund_vehicles' as any).select('id, name, kind').eq('fund_id', fundId)
    if (error) throw error
    veh = (data as any[]) ?? []
  } catch {
    veh = []
  }
  const related = relatedEntities(veh, await loadVehicleGpLinks(admin, fundId), vehicleId, options.access)

  const relatedBlocks: string[] = []
  for (const r of related) {
    relatedBlocks.push(await vehicleBooks(admin, fundId, r.name, `RELATED ${r.kind === 'associate' ? 'GP/ASSOCIATE' : 'FUND'} ENTITY: ${r.name}`, false))
  }

  return [primary + capText, ...relatedBlocks].join('\n\n=====\n\n')
}

/** The unified Analyst's accounting context block — exported so `/api/analyst` can append it for
 *  a user entitled to accounting, and only for such a user. */
export { gatherContext as buildAccountingContext }

/**
 * What the unified Analyst needs to know to reason about a vehicle's books.
 *
 * Built per request, because the guide must describe what was ACTUALLY included: a user without
 * gp_economics gets no GP/associate section, and telling their Analyst it can reconcile the fund
 * against the GP would only make it apologise for data it was never handed — or, worse, invent it.
 */
export function accountingAnalystGuide(options: AccountingContextOptions): string {
  const abilities = [
    "- interpret and explain financial statements (statement of assets/liabilities & partners' capital i.e. balance sheet, statement of operations i.e. income statement, statement of changes in partners' capital, cash flows, schedule of investments) from the chart, balances, and entries provided;",
    '- explain capital accounts and capital calls (commitment / called / funded / outstanding / NAV per partner);',
    ...(options.includeRelatedEntities
      ? ['- answer reconciliation questions — including between a fund and its GP/associate entity, whose own books reconcile to the fund (a GP entity\'s "Investment in Fund" should equal its capital-account balance on the fund\'s books);']
      : []),
    '- review the books for problems: entries that don\'t balance, postings that debit and credit the SAME account (always wrong), mis-categorized postings, missing counterparts (e.g. a loan drawn but never repaid), and unusual amounts.',
  ]

  const given = [
    'You are given the PRIMARY vehicle being viewed: its chart, balances, recent entries and partner capital',
    options.includeRelatedEntities ? ', plus any RELATED GP/associate entities as read-only reference' : '',
    '.',
  ].join('')

  // Said plainly, so it declines rather than guesses. This is a courtesy to the user, NOT the
  // access control — the data simply isn't in the prompt.
  const withheld: string[] = []
  if (!options.includeRelatedEntities) withheld.push("the GP/associate entities' books and the fund-vs-GP reconciliation")
  const withheldNote = withheld.length
    ? `\n\nYou do NOT have ${withheld.join(', or ')} — this user's access does not include it. If asked, say it isn't part of what you can see here and suggest they ask an admin. Never estimate or reconstruct it from the ledger.`
    : ''

  return `The user is in the Accounting section, viewing one vehicle. Its books are below. You can:
${abilities.join('\n')}

${given}${withheldNote}

Sign convention: every posting amount is the signed change to the account — DEBIT positive, CREDIT negative — and each entry's postings sum to exactly 0. Cite specific account codes, entry ids, dates, and amounts from the data below; never invent them.`
}

/** Framing for a source document the user attached. Appended only alongside the books. */
export const ACCOUNTING_DOCUMENT_GUIDE = `The SOURCE DOCUMENT above was attached by the user — typically a capital-call notice, invoice, wire confirmation, or distribution notice. Unless they asked for something else, default to proposing ONE balanced entry that records it, and explain your reading of it in your prose: what it is, its date, its amount, and its counterparty. If the document is unreadable or isn't something you can record, say so plainly rather than guessing at an entry.`

/** How the Analyst hands a drafted entry back to the app. Appended ONLY for a user entitled to
 *  draft (admin + accounting scope) — this text IS the capability grant, so gate it there. */
export const ACCOUNTING_DRAFTING_PROTOCOL = `
DRAFTING ENTRIES
When — and only when — the user asks you to draft, fix, or record a journal entry, append one fenced block per proposed entry AFTER your prose answer, in exactly this form (one JSON object per block, no other text inside it):

\`\`\`proposal
{"type":"create","entryId":null,"entryDate":"YYYY-MM-DD","memo":"...","sourceType":"manual","postings":[{"accountCode":"1100","amount":5000000,"lpEntity":null},{"accountCode":"2200","amount":-5000000,"lpEntity":null}],"rationale":"why"}
\`\`\`

Rules:
- DEBIT positive, CREDIT negative; the postings MUST sum to exactly 0 or the app rejects the draft.
- Only use account codes that exist in the PRIMARY vehicle's chart, and only propose entries for the PRIMARY vehicle — related entities are reference only; describe any entries they'd need in your prose instead.
- "sourceType" must be one of: ${ENTRY_SOURCE_TYPES.join(', ')}.
- To fix an existing entry, use "type":"edit" with that entry's id in "entryId".
- Do NOT split a capital call pro-rata across ALL partners — that belongs in the Bank "Book as call" flow. When the request names ONE specific partner, attribute the posting to them by putting their exact name in "lpEntity"; otherwise omit it and work at the standard chart level (e.g. 3100 LP capital, 3000 GP capital).
- Don't mention the block itself in your prose — the app renders it as a reviewable draft the user applies. Nothing is posted automatically.
When the user is only asking a question, emit no blocks.`

/** Apply one proposal as a DRAFT entry (create, or edit an existing entry). */
export async function applyProposal(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  proposal: AssistantProposal
): Promise<({ entryId: string } | { error: string }) & { removedTransactions?: OwningTransaction[]; unlinkedRegisterRows?: string[] }> {
  const [codes, names] = await Promise.all([
    accountIdByCode(admin, fundId, group),
    loadEntityNames(admin, fundId, group),
  ])
  // Partner name → id, so a proposal drafted from a document that names one
  // partner lands on that partner's capital account rather than the pooled one.
  const entityByName = new Map(Array.from(names.entries()).map(([id, name]) => [name.toLowerCase(), id]))

  let currency: string
  try {
    currency = await fundCurrency(admin, fundId)
  } catch (e) {
    return { error: `${e instanceof Error ? e.message : String(e)}. Nothing was changed — try again.` }
  }
  const postings: Posting[] = []
  for (const p of proposal.postings ?? []) {
    const accountId = codes.get(String(p.accountCode))
    if (!accountId) return { error: `Unknown account code ${p.accountCode}` }
    const lpEntityId = p.lpEntity ? entityByName.get(String(p.lpEntity).toLowerCase()) ?? null : null
    // Denominated in the fund's currency, not assumed dollars. The create path gets this from
    // persistEntry; the edit path inserts postings directly, so it has to stamp them itself.
    postings.push({ accountId, amount: Number(p.amount), currency, lpEntityId })
  }
  if (postings.length === 0) return { error: 'The proposal has no postings' }

  if (proposal.type === 'edit' && proposal.entryId) {
    const vehicleId = await vehicleIdByName(admin, fundId, group)
    if (!vehicleId) return { error: `Unknown vehicle "${group}".` }

    const { data: existing } = await admin.from('journal_entries' as any)
      .select('id, status, entry_date, source_ref').eq('id', proposal.entryId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK).maybeSingle()
    if (!existing) return { error: 'Entry to edit not found' }

    // THE GUARDS THE CREATE PATH GETS FOR FREE FROM persistEntry, AND THIS PATH USED TO SKIP.
    //
    // These postings came out of an LLM's JSON. Without the balance check, a hallucinated
    // edit saved an unbalanced entry as a draft — and the journal's Post action checks the
    // period lock but NOT balance, so one click later it was posted and the trial balance
    // was silently off. Without the period check, the edit could rewrite `entry_date` INTO a
    // closed month, or amend an entry already sitting in one.
    try {
      assertBalanced({ fundId, entryDate: proposal.entryDate, postings } as JournalEntry)
    } catch (e) {
      return { error: `The proposed edit doesn't balance: ${(e as Error).message}` }
    }

    const closed = await closedPeriodRanges(admin, fundId, group)
    // Check the date it's moving TO and the date it's moving FROM — an entry may neither be
    // smuggled into a locked period nor out of one.
    if (dateInAnyClosedPeriod(closed, proposal.entryDate)) {
      return { error: `The period covering ${proposal.entryDate} is closed — reopen it to post there.` }
    }
    const currentDate = (existing as any).entry_date
    if (currentDate && dateInAnyClosedPeriod(closed, currentDate)) {
      return { error: `That entry is dated ${currentDate}, inside a closed period — reopen it to amend it.` }
    }

    // An owned entry being edited no longer says what its transactions say: delete them (the
    // edited lines are adopted when it posts again). And bring a posted entry back to draft WITH
    // its generated partner allocation — leaving that posted credited partners for an entry that
    // is no longer on the books.
    const released = await releaseOwnership(admin, fundId, existing as any)
    if ('error' in released) return { error: released.error, removedTransactions: released.removed ?? [], unlinkedRegisterRows: released.unlinked ?? [] }
    const gone = { removedTransactions: released.removed, unlinkedRegisterRows: released.unlinked }
    if ((existing as any).status !== 'draft') {
      const allocation = await setGeneratedAllocationStatus(admin, fundId, proposal.entryId, 'draft')
      if (allocation.error) return { error: allocation.error, ...gone }
      await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', proposal.entryId).eq('fund_id', fundId)
      await admin.from('bank_transactions' as any).update({ status: 'drafted' }).eq('journal_entry_id', proposal.entryId).eq('fund_id', fundId)
    }

    const { data: oldRows } = await admin.from('journal_postings' as any).select('id').eq('book', ACTUAL_BOOK).eq('journal_entry_id', proposal.entryId)
    const { error: insErr } = await admin.from('journal_postings' as any).insert(
      postings.map(p => ({ fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId, journal_entry_id: proposal.entryId, account_id: p.accountId, amount: p.amount, currency: p.currency, lp_entity_id: p.lpEntityId }))
    )
    if (insErr) return { error: insErr.message, ...gone }
    const oldIds = ((oldRows as any[]) ?? []).map(r => r.id)
    if (oldIds.length) await admin.from('journal_postings' as any).delete().in('id', oldIds)
    await admin.from('journal_entries' as any).update({ entry_date: proposal.entryDate, memo: proposal.memo ?? null }).eq('id', proposal.entryId).eq('fund_id', fundId)
    return { entryId: proposal.entryId, ...gone }
  }

  const entry: JournalEntry = {
    fundId,
    entryDate: proposal.entryDate,
    memo: proposal.memo ?? null,
    sourceType: proposal.sourceType ?? 'manual',
    postings,
  }
  const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
  if ('error' in result) return { error: result.error }
  return { entryId: result.entryId }
}
