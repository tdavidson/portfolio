import { capitalOperationKey, validCapitalDate, validCapitalAmounts } from './capital-operation-key'
import { loadSettlementReviews } from './settlement-reviews'
import { loadReportingCapital } from './reporting-capital'
import { ensureVehicleAccounts } from './provision-accounts'
// Capital-call register + reporting. A call recognizes contributed capital and a
// receivable (chart 1300 "Due from LPs") when issued; funding clears it later.
// Called/funded/outstanding all derive from the capital postings + the call register,
// so they never drift:
//   called      = Σ capital_call_lines.amount for the LP (the register)
//   receivable  = the LP's balance in account 1300 (from the posted ledger)
//   funded      = called − receivable   (cash actually received)
//   outstanding = commitment − called   (commitment REMAINING TO BE CALLED)
//
// `outstanding` used to be `commitment − funded`, which is uncalled capital PLUS the
// receivable — so it overlapped with `receivable` and the two double-counted anywhere both
// were shown (the capital-accounts table and the LP statement PDF both show both). It also
// disagreed with `live-report.ts`, where `outstanding_balance = commitment − paidIn`, and
// with the LP snapshot's `outstanding_balance` ("remaining uncalled commitment") — so the
// same LP could read a different number on their statement than on their snapshot.
//
// The four are now disjoint and read left to right as the life of a commitment:
//   committed → called → funded, with `outstanding` still to be called and `receivable`
//   called but not yet in the bank. Total cash the LP still owes = outstanding + receivable.
//
// Reporting resolves dated observations and accounting evidence per partner. Reported capital
// does not by itself establish receipts or receivables; unknown amounts remain unknown.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPostedLedger, loadOwnership, loadEntityNames, loadEntityClasses } from './load'
import { loadCapitalPostings } from './capital-source'
import { commitmentsFromPositions } from './lp-positions'
import { loadCommitmentEvents, resolveCommitmentMap } from './terms'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { computeCapitalAccounts, emptyAccount, type CapitalAccount, type CapitalPeriod, type CapitalPosting } from './capital-account'
import { buildCapitalCallIssuanceEntry } from './entries'
import { allocateAmount } from './allocation'
import { vehicleIdByName } from './vehicle-id'
import { roundCents } from './ledger'
import { RECEIVABLE_CODE, DISTRIBUTION_PAYABLE_CODE } from './chart'
import { ACTUAL_BOOK } from './books'
import { callExtras } from './call-extras'
import { reconcileSettlements, registerStatus, settlementsFromPostings, type LineStatus, type RegisterStatus, type Settlement } from './settlement'

// Re-exported for the callers that have always imported it from here.
export { RECEIVABLE_CODE }

export interface CallLineInput {
  lpEntityId: string
  amount: number
}

/** Split a fund-wide call total across LPs pro-rata by commitment (to the cent). */
export async function proRataCall(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  total: number
): Promise<CallLineInput[]> {
  const owners = await loadOwnership(admin, fundId, group)
  const funded = owners.filter(o => o.commitment > 0)
  if (funded.length === 0) return []
  const split = allocateAmount(total, funded.map(o => ({ lpEntityId: o.lpEntityId, commitment: o.commitment })))
  return Array.from(split.entries()).map(([lpEntityId, amount]) => ({ lpEntityId, amount }))
}

export interface IssueCallInput {
  requestKey?: string
  callDate: string
  /** When the money is due. Recorded at issue so a notice can't invent it later. */
  dueDate?: string | null
  description?: string | null
  scope: 'fund_wide' | 'per_lp'
  lines: CallLineInput[]
}

/**
 * Issue a capital call: post the receivable/capital entry (Dr 1300 / Cr each LP's
 * capital) and record the call + its per-LP lines in the register.
 *
 * The first call provisions the required accounts; no activation step is needed.
 */
export async function issueCapitalCall(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: IssueCallInput
): Promise<{ callId: string; entryId: string | null } | { error: string }> {
  if (!validCapitalAmounts(input.lines ?? [])) return { error: 'Call amounts must be finite nonnegative amounts in cents' }
  const lines = (input.lines ?? []).filter(l => l.lpEntityId && Number(l.amount) > 0)
  if (lines.length === 0) return { error: 'A call needs at least one LP with a positive amount' }
  if (!validCapitalDate(input.callDate)) return { error: 'A valid call date is required' }
  if (input.dueDate && (!validCapitalDate(input.dueDate) || input.dueDate < input.callDate)) return { error: 'The due date must be valid and on or after the call date' }

  const perLp = new Map<string, number>()
  for (const l of lines) perLp.set(l.lpEntityId, roundCents((perLp.get(l.lpEntityId) ?? 0) + Number(l.amount)))

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  // REFUSE BEFORE ANYTHING IS WRITTEN. Every scoping below keys off this id, and a null one is
  // not a wildcard — it is a hole: `request_key` cannot be unique across NULL vehicle_ids, the
  // retry lookup below cannot match a NULL row, and `complete_capital_operation` would refuse the
  // publication anyway, after a draft entry and a register row had already been written.
  if (!vehicleId) return { error: `"${group}" is not in this fund's vehicle registry, so a capital call cannot be recorded against it` }
  const requestKey = capitalOperationKey(input)
  const { data: prior, error: priorError } = await admin.from('capital_calls' as any)
    .select('id, status, journal_entry_id, capital_call_lines(id)').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('request_key', requestKey).maybeSingle()
  if (priorError) return { error: priorError.message }
  const previous = prior as any
  if (previous?.status === 'issued') return { callId: previous.id, entryId: previous.journal_entry_id }
  let entryId: string | null = previous?.journal_entry_id ?? null
  let callId: string = previous?.id
  if (!previous) {
    await ensureVehicleAccounts(admin, fundId, group)
    const codes = await accountIdByCode(admin, fundId, group)
    const receivableId = codes.get(RECEIVABLE_CODE)
    if (!receivableId) return { error: `The chart is missing account ${RECEIVABLE_CODE} Due from LPs — add it under the entity's Admin → Chart of accounts.` }

    const capMap = await ensureCapitalAccounts(admin, fundId, group, lines.map(l => l.lpEntityId))
    const entry = buildCapitalCallIssuanceEntry(
      { fundId, entryDate: input.callDate, memo: input.description || 'Capital call' },
      perLp,
      capMap,
      receivableId
    )
    const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
    if ('error' in result) return { error: result.error }
    entryId = result.entryId


    const { data: call, error: callErr } = await admin
      .from('capital_calls' as any)
      .insert({
        fund_id: fundId,
        vehicle_id: vehicleId,
        request_key: requestKey,
        call_date: input.callDate,
        due_date: input.dueDate || null,
        description: input.description ?? null,
        scope: input.scope,
        status: 'draft',
        journal_entry_id: entryId,
        created_by: userId,
      })
      .select('id')
      .single()
    if (callErr) {
      const { error: cleanupError } = await admin.rpc('discard_unregistered_capital_drafts' as any, { p_fund_id: fundId, p_vehicle_id: vehicleId, p_entry_ids: [entryId] })
      return { error: `${callErr.message}${cleanupError ? `; draft cleanup failed: ${cleanupError.message}` : ''}` }
    }
    callId = (call as any).id
  }

  const { error: finalizeError } = await admin.rpc('complete_capital_operation' as any, {
    p_fund_id: fundId, p_vehicle_id: vehicleId, p_kind: 'call', p_register_id: callId, p_entry_ids: [entryId],
    p_lines: Array.from(perLp.entries()).map(([lpEntityId, amount]) => ({ lpEntityId, amount })),
  })
  if (finalizeError) return { error: `Call remains a draft: ${finalizeError.message}` }
  return { callId, entryId }
}


/** The receivable (1300) balance per LP from the posted ledger. */
export async function lpReceivableBalances(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, number>> {
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group)
  const receivable = accounts.find(a => a.code === RECEIVABLE_CODE)
  const out = new Map<string, number>()
  if (!receivable) return out
  for (const p of postings) {
    if (p.accountId !== receivable.id || !p.lpEntityId) continue
    out.set(p.lpEntityId, roundCents((out.get(p.lpEntityId) ?? 0) + p.amount))
  }
  return out
}

/**
 * Per-LP DECLARED-BUT-UNPAID distribution balance, from the ledger (account 2300).
 *
 * The outbound mirror of `lpReceivableBalances`. Returned POSITIVE = still owed to the
 * partner, so callers don't have to reason about the payable's credit-normal sign.
 */
export async function lpPayableBalances(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, number>> {
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group)
  const payable = accounts.find(a => a.code === DISTRIBUTION_PAYABLE_CODE)
  const out = new Map<string, number>()
  if (!payable) return out
  for (const p of postings) {
    if (p.accountId !== payable.id || !p.lpEntityId) continue
    // A credit (negative posting) creates the obligation, so negate to report what is owed.
    out.set(p.lpEntityId, roundCents((out.get(p.lpEntityId) ?? 0) - p.amount))
  }
  return out
}

/** Sum of called amounts per LP, from the call register. */
export async function lpCalledTotals(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, number>> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('capital_call_lines' as any)
    .select('lp_entity_id, amount')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const out = new Map<string, number>()
  for (const r of ((data as any[]) ?? [])) {
    out.set(r.lp_entity_id, roundCents((out.get(r.lp_entity_id) ?? 0) + Number(r.amount)))
  }
  return out
}

export interface CapitalCallLineRow {
  /** The register line's id — what a notice, a receipt and an acknowledgment hang off. */
  id: string
  lpEntityId: string
  name: string
  amount: number
  /** What has arrived against THIS line, oldest call first (lib/accounting/settlement.ts). */
  settled: number
  outstanding: number
  status: LineStatus
  settledOn: string | null
  /** The most recent funding applied to the line, complete or not — what a receipt acknowledges. */
  manualSettled?: number
  settlementReview?: string
  lastSettlementOn: string | null
  /** The notice PDF published for this line, if any. */
  noticeDocumentId: string | null
  /** The partner's own word, from their portal: "we wired on this date, with this reference". */
  ack: { at: string; wiredOn: string | null; reference: string | null; note: string | null } | null
  /** Other amounts collected with the call from this partner (lib/accounting/call-extras.ts). */
  charges: { amount: number; description: string }[]
  /** What the partner owes on this line: the capital called plus the charges. `settled` and `outstanding` are of this. */
  due: number
  /** Of what was settled, how much came from money the partner sent ahead of the call. */
  advanceApplied: number
}

export interface CapitalCallRow extends RegisterStatus {
  id: string
  callDate: string
  dueDate: string | null
  callNumber: number | null
  description: string | null
  scope: string
  total: number
  lines: CapitalCallLineRow[]
}

/**
 * The money that has moved against a vehicle's calls or distributions, by partner and date.
 *
 * Accounting payments come from the receivable (fundings) or payable (payments).
 * The caller reconciles these with any manually recorded line payments.
 */
export async function loadSettlements(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  direction: 'receivable' | 'payable',
): Promise<Settlement[]> {
  const { accounts, sourcedPostings } = await loadPostedLedger(admin, fundId, group)
  const code = direction === 'receivable' ? RECEIVABLE_CODE : DISTRIBUTION_PAYABLE_CODE
  const account = accounts.find(a => a.code === code)
  if (!account) return []
  return settlementsFromPostings(sourcedPostings, account.id, direction)
}

/** Issued calls (most recent first) with their per-LP lines and what has been funded against each. */
export async function listCapitalCalls(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<CapitalCallRow[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [{ data: calls }, names, settlements, reviews] = await Promise.all([
    admin
      .from('capital_calls' as any)
      .select('id, status, call_date, due_date, call_number, description, scope, capital_call_lines(id, lp_entity_id, amount, notice_document_id, settled_amount, settled_on, ack_at, ack_wired_on, ack_reference, ack_note)')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .order('call_date', { ascending: false }),
    loadEntityNames(admin, fundId, group),
    loadSettlements(admin, fundId, group, 'receivable'),
    loadSettlementReviews(admin, fundId, vehicleId, 'call'),
  ])
  const rows = ((calls as any[]) ?? []).filter(row => row.status !== 'draft')
  const extras = await callExtras(admin, fundId, vehicleId, rows.map(c => c.id as string))
  const chargesOf = (callId: string, lp: string) => extras.get(callId)?.charges.get(lp) ?? []
  const chargeTotal = (callId: string, lp: string) => roundCents(chargesOf(callId, lp).reduce((s, c) => s + c.amount, 0))

  // Every line of every call goes through ONE FIFO pass, so a wire that covers two calls is
  // applied to both in order rather than counted against each.
  // A line is settled against everything the partner owes on it: the capital and the charges.
  const registerLines = rows.flatMap(c => ((c.capital_call_lines as any[]) ?? []).map(l => ({
    id: l.id as string, lpEntityId: l.lp_entity_id as string, date: c.call_date as string,
    amount: roundCents(Number(l.amount) + chargeTotal(c.id, l.lp_entity_id)),
  })))
  // Manual payments belong to their recorded lines, even after books are imported.
  const manual: (Settlement & { lineId: string })[] = rows.flatMap(c => ((c.capital_call_lines as any[]) ?? [])
    .filter(l => Number(l.settled_amount) > 0)
    .map(l => ({ lineId: l.id as string, lpEntityId: l.lp_entity_id as string, date: (l.settled_on ?? c.call_date) as string, amount: Number(l.settled_amount) })))
  const settledByLine = reconcileSettlements(registerLines, settlements, manual, reviews)

  return rows.map(c => {
    const lines: CapitalCallLineRow[] = ((c.capital_call_lines as any[]) ?? []).map(l => {
      const s = settledByLine.get(l.id)
      return {
        id: l.id,
        lpEntityId: l.lp_entity_id,
        name: names.get(l.lp_entity_id) ?? l.lp_entity_id,
        amount: Number(l.amount),
        charges: chargesOf(c.id, l.lp_entity_id),
        due: roundCents(Number(l.amount) + chargeTotal(c.id, l.lp_entity_id)),
        advanceApplied: extras.get(c.id)?.advance.get(l.lp_entity_id) ?? 0,
        settled: s?.settled ?? 0,
        outstanding: s?.outstanding ?? roundCents(Number(l.amount) + chargeTotal(c.id, l.lp_entity_id)),
        status: s?.status ?? 'open',
        settledOn: s?.settledOn ?? null,
        settlementReview: s?.settlementReview,
        manualSettled: Number(l.settled_amount ?? 0),
        lastSettlementOn: s?.lastSettlementOn ?? null,
        noticeDocumentId: l.notice_document_id ?? null,
        ack: l.ack_at ? { at: l.ack_at, wiredOn: l.ack_wired_on ?? null, reference: l.ack_reference ?? null, note: l.ack_note ?? null } : null,
      }
    })
    return {
      id: c.id,
      callDate: c.call_date,
      dueDate: c.due_date ?? null,
      callNumber: c.call_number ?? null,
      description: c.description ?? null,
      scope: c.scope,
      total: roundCents(lines.reduce((s, l) => s + l.amount, 0)),
      lines,
      ...registerStatus(lines, c.due_date ?? null, today),
    }
  })
}

export interface LpCapitalRow {
  lpEntityId: string
  name: string
  partnerClass: string
  /** What the LP signed up for. */
  commitment: number
  /** What has been asked for so far. Capital is recognized here, not at funding. */
  called: number | null
  /** What actually arrived: called − receivable. */
  funded: number | null
  /** Remaining to be CALLED: commitment − called. Disjoint from `receivable`. */
  outstanding: number | null
  /** Called but not yet in the bank (acct 1300). Always 0 on an events vehicle. */
  receivable: number | null
  /**
   * `called − receivable` came out NEGATIVE, which is impossible for cash received. It means
   * this LP has a receivable but no reachable capital postings — almost always capital
   * stranded on the pooled account. `funded` is clamped to 0; treat this as "the books are
   * wrong", not as a number to display.
   */
  fundedUnderflow: boolean
  /** Capital-account ending balance (the LP's NAV). */
  ending: number | null
}

/** Per-LP commitment / called / funded / outstanding + ending capital (NAV). */
export async function lpCapitalSummary(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
): Promise<LpCapitalRow[]> {
  // One source-aware load: `postings` come from the ledger or from lp_capital_events
  // depending on the vehicle, and `receivableByLp` falls out of the same read (it is
  // always empty for an events vehicle).
  const [{ postings: capitalPostings, receivableByLp, commitmentByLp, evidenceByLp }, names, classes] = await Promise.all([
    loadReportingCapital(admin, fundId, group, asOf),
    loadEntityNames(admin, fundId, group),
    loadEntityClasses(admin, fundId, group),
  ])
  const accountByLp = computeCapitalAccounts(capitalPostings)

  const ids = new Set<string>([
    ...Array.from(names.keys()),
    ...Array.from(commitmentByLp.keys()),
    ...Array.from(accountByLp.keys()),
    ...Array.from(evidenceByLp.keys()),
  ])

  const rows: LpCapitalRow[] = Array.from(ids).map(lpEntityId => {
    const acct = accountByLp.get(lpEntityId)
    const evidence = evidenceByLp.get(lpEntityId)
    const commitment = commitmentByLp.get(lpEntityId) ?? 0
    const called = evidence ? evidence.values.contributions : acct?.contributions ?? 0
    const receivable = evidence?.basis === 'reported' && !receivableByLp.has(lpEntityId) ? null : receivableByLp.get(lpEntityId) ?? 0
    return {
      lpEntityId,
      name: names.get(lpEntityId) ?? lpEntityId,
      partnerClass: classes.get(lpEntityId) ?? 'lp',
      ...commitmentFigures(
        commitmentByLp.get(lpEntityId) ?? 0,
        // Called = capital recognized via call entries (the contributions bucket).
        acct?.contributions ?? 0,
        receivableByLp.get(lpEntityId) ?? 0,
      ),
      called,
      receivable,
      funded: called == null || receivable == null ? null : Math.max(0, roundCents(called - receivable)),
      outstanding: called == null ? null : roundCents(commitment - called),
      ending: evidence ? evidence.values.nav : roundCents(acct?.ending ?? 0),
    }
  })
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The commitment-side arithmetic, pulled out so it can be pinned by a test.
 *
 * It is four numbers and it silently changed meaning once already, so it gets to be a
 * function rather than four expressions buried in a `.map`.
 *
 * The invariant that matters: `outstanding` and `receivable` are DISJOINT. One is capital
 * not yet asked for, the other is capital asked for and not yet received. Total cash the
 * LP still owes is the sum of them — which is what `outstanding` used to be on its own,
 * which is why it double-counted against `receivable` wherever both were displayed.
 */
export function commitmentFigures(
  commitmentRaw: number,
  calledRaw: number,
  receivableRaw: number,
): {
  commitment: number; called: number; funded: number; outstanding: number; receivable: number
  fundedUnderflow: boolean
} {
  const commitment = roundCents(commitmentRaw)
  const called = roundCents(calledRaw)
  const receivable = roundCents(receivableRaw)

  // `called - receivable` can only go negative when the two sides disagree about reality:
  // a 1300 receivable exists for an LP whose capital postings never reached their own
  // account, so `called` reads 0 while the receivable stands. Cash received is never
  // negative, so rather than render an impossible figure we clamp it and raise a flag the
  // surfaces turn into "these books need attention" — see loadStrandedCapital.
  //
  // The shape to recognise: capital pooled on 3100 with no per-LP accounts gives
  // funded = 0 - commitment = -commitment indefinitely, and without this flag nothing in
  // the product treats it as anything other than a number.
  const rawFunded = roundCents(called - receivable)
  const fundedUnderflow = rawFunded < -0.005

  return {
    commitment,
    called,
    funded: fundedUnderflow ? 0 : rawFunded,      // cash actually received
    outstanding: roundCents(commitment - called), // remaining to be called
    receivable,
    fundedUnderflow,
  }
}

export interface LpStatementTxn {
  date: string
  memo: string | null
  sourceType: string | null
  amount: number   // signed change to the LP's capital (credit +, debit −)
  balance: number  // running capital balance
}
export interface LpStatement {
  row: LpCapitalRow
  /** Inception-to-date roll-forward. */
  rollForward: CapitalAccount
  /** Roll-forward scoped to the statement period, opening with capital carried in. */
  periodRollForward: CapitalAccount
  transactions: LpStatementTxn[]
}

/** One movement in an LP's capital, before it is windowed into a statement.
 *  `delta` is credit-positive: what the movement did to the LP's capital. */
interface Movement { date: string; memo: string | null; sourceType: string | null; delta: number }

/** Movements from the posted ledger — the LP's own capital sub-account in the chart. */
async function ledgerMovements(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
  lpEntityId: string
): Promise<Movement[]> {
  const { data: acct } = await admin
    .from('chart_of_accounts' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('lp_entity_id', lpEntityId)
    .maybeSingle()
  if (!acct) return []

  const { data: rows } = await admin
    .from('journal_postings' as any)
    .select('amount, journal_entries!inner(entry_date, memo, source_type, status)')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('account_id', (acct as any).id)

  return ((rows as any[]) ?? [])
    .filter(r => r.journal_entries?.status === 'posted')
    .map(r => ({
      date: String(r.journal_entries.entry_date ?? ''),
      memo: r.journal_entries.memo ?? null,
      sourceType: r.journal_entries.source_type ?? null,
      delta: roundCents(-Number(r.amount)),
    }))
}

/**
 * Movements for a NON-ledger (positions-tracked) vehicle, derived from the SAME delta postings
 * that produced the roll-forward — so the statement's activity list and its totals can never
 * disagree. (Previously this read the legacy `lp_capital_events` table, which is empty for a
 * vehicle tracked via `lp_positions`, so the activity list came up blank.)
 */
function positionMovements(capitalPostings: CapitalPosting[], lpEntityId: string): Movement[] {
  return capitalPostings
    .filter(p => p.lpEntityId === lpEntityId)
    .map(p => ({
      date: String(p.entryDate ?? ''),
      memo: null,
      sourceType: p.sourceType ?? null,
      delta: roundCents(-p.amount), // debit-positive posting → capital delta is the negation
    }))
}

/** A single LP's capital statement: summary, roll-forward, and every capital movement. */
export async function lpStatement(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  lpEntityId: string,
  period?: CapitalPeriod
): Promise<LpStatement | { error: string }> {
  const summary = await lpCapitalSummary(admin, fundId, group, period?.end ?? undefined)
  const row = summary.find(r => r.lpEntityId === lpEntityId)
  if (!row) return { error: 'LP not found in this vehicle' }

  const { source, postings: capitalPostings } = await loadCapitalPostings(admin, fundId, group)
  const rollForward = computeCapitalAccounts(capitalPostings, { end: period?.end })
    .get(lpEntityId) ?? emptyAccount()
  const periodRollForward = computeCapitalAccounts(capitalPostings, period)
    .get(lpEntityId) ?? emptyAccount()

  const vehicleId = await vehicleIdByName(admin, fundId, group)

  // The movements behind the roll-forward, from whichever producer this vehicle uses. Both
  // store debit-positive (like journal_postings), so a capital delta is the negated amount
  // either way.
  const movements = positionMovements(capitalPostings, lpEntityId)
  movements.sort((a, b) => a.date.localeCompare(b.date))

  // The statement lists activity IN THE PERIOD, under exactly that heading. This used to
  // return every posting since inception with no date filter at all, so a Q3 statement listed
  // the LP's entire history labelled as one quarter's activity.
  //
  // The running balance still accumulates from INCEPTION — a period statement's closing
  // balance is the LP's real capital, not the sum of three months. So we walk everything, and
  // only emit the rows that fall inside the window.
  const transactions: LpStatementTxn[] = []
  let balance = 0
  for (const m of movements) {
    // Anything after the statement date isn't on this statement — it hasn't happened yet as
    // far as this document is concerned, and must not move the closing balance either.
    if (period?.end && m.date > period.end) continue

    balance = roundCents(balance + m.delta)

    if (period?.start && m.date < period.start) continue // carried into `beginning`, not listed
    transactions.push({ date: m.date, memo: m.memo, sourceType: m.sourceType, amount: m.delta, balance })
  }

  return { row, rollForward, periodRollForward, transactions }
}
