// Charges between two vehicles of the same firm — the management fee a fund owes the management
// company, a cost one entity paid on another's behalf, an advance between them.
//
// WHY THIS IS ITS OWN MODULE AND NOT TWO JOURNAL ENTRIES.
//
// An intercompany charge is one economic fact and two ledgers. Booked as two ordinary journal
// entries, nothing in the system knows they are the same charge: the manco's receivable and the
// fund's payable are independent numbers that agree only for as long as both were typed correctly,
// and when they stop agreeing there is no way to tell which one moved. That is the classic
// intercompany failure, and it is discovered at audit.
//
// So a charge is a row (`intercompany_transactions`), and posting it writes BOTH sides in one
// action, each entry tagged `source_ref = 'intercompany:<id>'` — the same convention the period
// close uses to find the entries it wrote. The row keeps the two entry ids as well, so the
// reconciliation is a lookup in either direction rather than a join on a memo string.
//
// WHAT IS NOT HERE: the BALANCE. The outstanding due-from/due-to per counterparty is read off the
// ledger (`intercompanyBalances` below), not summed from these rows. A register that computed its
// own balance would disagree with the balance sheet the first time anyone posted a correcting
// entry by hand, and nothing would say which was right. The ledger is the answer; this table is
// the story of how it got there.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import {
  INTERCOMPANY_RECEIVABLE_CODE, INTERCOMPANY_PAYABLE_CODE,
  INTERCOMPANY_RECEIVABLE_SUBTYPE, INTERCOMPANY_PAYABLE_SUBTYPE,
  intercompanyCode,
} from './chart'
import { ACTUAL_BOOK } from './books'
import type { JournalEntry } from './types'

export const INTERCOMPANY_KINDS = [
  'management_fee', 'expense_reimbursement', 'allocated_cost',
  'loan_advance', 'loan_repayment', 'other',
] as const

export type IntercompanyKind = (typeof INTERCOMPANY_KINDS)[number]

export const INTERCOMPANY_KIND_LABELS: Record<IntercompanyKind, string> = {
  management_fee: 'Management fee',
  expense_reimbursement: 'Expense reimbursement',
  allocated_cost: 'Allocated cost',
  loan_advance: 'Advance',
  loan_repayment: 'Advance repaid',
  other: 'Other charge',
}

/**
 * Kinds that CREATE an obligation now and move cash later — the ones with an accrual and a
 * separate settlement. The rest move cash at the moment they are recorded, so they have one event
 * and no settlement of their own (an advance is cleared by recording a repayment, which is its own
 * row, because that is what actually happened).
 */
const ACCRUING_KINDS: IntercompanyKind[] = [
  'management_fee', 'expense_reimbursement', 'allocated_cost', 'other',
]

export function isAccruingKind(kind: IntercompanyKind): boolean {
  return ACCRUING_KINDS.includes(kind)
}

/**
 * Which P&L account each side books, IN PREFERENCE ORDER, by `chart_of_accounts.subtype`.
 *
 * Subtype rather than code, because the two sides of a charge hold different charts: the payee is
 * usually the management company (4000 management fee income) and the payer a fund (5000
 * management fee expense), but either can be a GP entity, whose chart numbers the same concepts
 * differently. A subtype survives that; a code does not.
 *
 * The list is a preference, not a fallback chain to a wrong answer — every entry in it is a
 * defensible home for that charge on some chart. When none of them exists, this refuses to post
 * rather than picking the nearest account, because an intercompany charge landing in the wrong
 * income account is a misstatement that balances, and therefore one nothing will ever flag.
 */
const INCOME_SUBTYPES: Record<IntercompanyKind, string[]> = {
  management_fee: ['management_fee_income'],
  expense_reimbursement: ['reimbursement_income', 'other_income'],
  allocated_cost: ['reimbursement_income', 'other_income'],
  other: ['other_income', 'reimbursement_income'],
  // Cash kinds never touch the P&L: lending money is not income to the lender.
  loan_advance: [],
  loan_repayment: [],
}

const EXPENSE_SUBTYPES: Record<IntercompanyKind, string[]> = {
  management_fee: ['management_fee', 'partnership_expense', 'operating_expense'],
  expense_reimbursement: ['partnership_expense', 'operating_expense', 'office'],
  allocated_cost: ['partnership_expense', 'operating_expense', 'office'],
  other: ['partnership_expense', 'operating_expense', 'office'],
  loan_advance: [],
  loan_repayment: [],
}

/** The accounts one side of a charge posts to. */
export interface SideAccounts {
  /** Due-from-<counterparty> (the payee) or due-to-<counterparty> (the payer). */
  intercompanyAccountId: string
  cashAccountId: string
  /** Income for the payee, expense for the payer. Absent for the cash-only kinds. */
  pnlAccountId?: string | null
}

export interface ChargeInput {
  fundId: string
  kind: IntercompanyKind
  /** YYYY-MM-DD. */
  chargeDate: string
  amount: number
  memo?: string | null
  /** The intercompany_transactions row id, so both entries can point back at it. */
  chargeId: string
}

const sourceRef = (chargeId: string) => `intercompany:${chargeId}`

/**
 * The PAYEE's entry — the side that is owed. Debits what it is owed (or, for an advance, pays the
 * cash out) and credits the income it earned (or the cash it lent).
 *
 *   management fee   Dr Due from <payer>   Cr Management fee income
 *   advance          Dr Due from <payer>   Cr Cash
 */
export function buildPayeeEntry(input: ChargeInput, accts: SideAccounts): JournalEntry {
  const amount = roundCents(input.amount)
  if (!(amount > 0)) throw new Error('An intercompany charge must be a positive amount')
  const credit = isAccruingKind(input.kind) ? accts.pnlAccountId : accts.cashAccountId
  if (!credit) throw new Error('No income account for this charge on the payee’s chart')
  return finalizeCharge(input, [
    { accountId: accts.intercompanyAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: credit, amount: -amount, currency: 'USD', lpEntityId: null },
  ])
}

/**
 * The PAYER's entry — the side that owes. Debits the cost it incurred (or, for an advance, the
 * cash it received) and credits what it now owes.
 *
 *   management fee   Dr Management fee expense   Cr Due to <payee>
 *   advance          Dr Cash                     Cr Due to <payee>
 */
export function buildPayerEntry(input: ChargeInput, accts: SideAccounts): JournalEntry {
  const amount = roundCents(input.amount)
  if (!(amount > 0)) throw new Error('An intercompany charge must be a positive amount')
  const debit = isAccruingKind(input.kind) ? accts.pnlAccountId : accts.cashAccountId
  if (!debit) throw new Error('No expense account for this charge on the payer’s chart')
  return finalizeCharge(input, [
    { accountId: debit, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.intercompanyAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ])
}

/**
 * Settlement: the cash finally moves and the balance clears. The mirror of the two above, with
 * cash on the other side.
 *
 *   payee   Dr Cash              Cr Due from <payer>
 *   payer   Dr Due to <payee>    Cr Cash
 */
export function buildPayeeSettlementEntry(
  input: ChargeInput & { settledDate: string },
  accts: SideAccounts,
): JournalEntry {
  const amount = roundCents(input.amount)
  return finalizeCharge({ ...input, chargeDate: input.settledDate }, [
    { accountId: accts.cashAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.intercompanyAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ], 'intercompany_settlement')
}

export function buildPayerSettlementEntry(
  input: ChargeInput & { settledDate: string },
  accts: SideAccounts,
): JournalEntry {
  const amount = roundCents(input.amount)
  return finalizeCharge({ ...input, chargeDate: input.settledDate }, [
    { accountId: accts.intercompanyAccountId, amount, currency: 'USD', lpEntityId: null },
    { accountId: accts.cashAccountId, amount: -amount, currency: 'USD', lpEntityId: null },
  ], 'intercompany_settlement')
}

function finalizeCharge(
  input: ChargeInput,
  postings: JournalEntry['postings'],
  sourceType = 'intercompany',
): JournalEntry {
  return {
    fundId: input.fundId,
    entryDate: input.chargeDate,
    memo: input.memo ?? INTERCOMPANY_KIND_LABELS[input.kind],
    sourceType,
    sourceRef: sourceRef(input.chargeId),
    postings,
  }
}

// ── Chart plumbing ────────────────────────────────────────────────────────────────────────────

/**
 * Guarantee that a vehicle's chart can hold an intercompany balance with one named counterparty:
 * the 1900/2900 parents, and a `1900-<cp>` / `2900-<cp>` sub-account beneath each.
 *
 * The same shape as `ensureCapitalAccounts`, and for the same reason. A single pooled "due from
 * affiliates" is unreconcilable the moment there are two affiliates: each counterparty has to agree
 * to a matching balance on its own books, and it cannot agree to its share of a total. One account
 * per counterparty makes the confirmation a single number on both sides.
 *
 * Idempotent — it is called before every posting, and creates only what is missing. Returns the two
 * sub-account ids, which is all the caller wants.
 */
export async function ensureIntercompanyAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  counterparty: { vehicleId: string; name: string },
): Promise<{ receivableAccountId: string; payableAccountId: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) throw new Error(`Unknown vehicle "${group}"`)

  const receivableCode = intercompanyCode(INTERCOMPANY_RECEIVABLE_CODE, counterparty.vehicleId)
  const payableCode = intercompanyCode(INTERCOMPANY_PAYABLE_CODE, counterparty.vehicleId)

  const { data: existing } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const byCode = new Map(((existing as any[]) ?? []).map(a => [a.code as string, a.id as string]))

  const wanted = [
    // The parents. A vehicle whose chart already has them (a manco) keeps what it has; a fund's
    // chart gets them created the first time it is party to a charge, which is the only moment it
    // could possibly need them.
    { code: INTERCOMPANY_RECEIVABLE_CODE, name: 'Due from affiliates', type: 'asset', subtype: INTERCOMPANY_RECEIVABLE_SUBTYPE },
    { code: INTERCOMPANY_PAYABLE_CODE, name: 'Due to affiliates', type: 'liability', subtype: INTERCOMPANY_PAYABLE_SUBTYPE },
    { code: receivableCode, name: `Due from ${counterparty.name}`, type: 'asset', subtype: INTERCOMPANY_RECEIVABLE_SUBTYPE },
    { code: payableCode, name: `Due to ${counterparty.name}`, type: 'liability', subtype: INTERCOMPANY_PAYABLE_SUBTYPE },
  ].filter(a => !byCode.has(a.code))

  if (wanted.length > 0) {
    const { data: created, error } = await admin
      .from('chart_of_accounts' as any)
      .insert(wanted.map(a => ({
        fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
        code: a.code, name: a.name, type: a.type, subtype: a.subtype,
      })))
      .select('id, code')
    if (error) throw new Error(`Could not create intercompany accounts on ${group}: ${error.message}`)
    for (const a of ((created as any[]) ?? [])) byCode.set(a.code as string, a.id as string)
  }

  return {
    receivableAccountId: byCode.get(receivableCode)!,
    payableAccountId: byCode.get(payableCode)!,
  }
}

/**
 * The cash and P&L accounts one side needs, resolved from ITS chart by subtype.
 *
 * Returns an error string rather than throwing, because every one of these is a thing the user can
 * fix themselves — add the account, or seed the chart — and the route turns it straight into a
 * message that says which account is missing on which vehicle.
 */
export async function resolveSideAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  kind: IntercompanyKind,
  role: 'payee' | 'payer',
  intercompanyAccountId: string,
): Promise<SideAccounts | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, subtype')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const accounts = ((data as any[]) ?? []) as { id: string; code: string; subtype: string | null }[]

  const bySubtype = (wanted: string[]): string | null => {
    for (const s of wanted) {
      const hit = accounts.find(a => a.subtype === s)
      if (hit) return hit.id
    }
    return null
  }

  // Cash: the operating account. Prefer code 1000 over any other cash-subtyped account, so a firm
  // with an operating and a reserve account settles out of the operating one rather than whichever
  // row the database returned first.
  const cash = accounts.find(a => a.code === '1000' && a.subtype === 'cash')?.id
    ?? bySubtype(['cash'])
  if (!cash) return { error: `${group} has no cash account — seed its chart of accounts first.` }

  if (!isAccruingKind(kind)) {
    return { intercompanyAccountId, cashAccountId: cash, pnlAccountId: null }
  }

  const wanted = role === 'payee' ? INCOME_SUBTYPES[kind] : EXPENSE_SUBTYPES[kind]
  const pnl = bySubtype(wanted)
  if (!pnl) {
    const what = role === 'payee' ? 'income' : 'expense'
    return {
      error:
        `${group} has no ${what} account for a ${INTERCOMPANY_KIND_LABELS[kind].toLowerCase()} ` +
        `(looked for ${wanted.join(' or ')}). Add one to its chart of accounts and try again.`,
    }
  }
  return { intercompanyAccountId, cashAccountId: cash, pnlAccountId: pnl }
}

// ── Posting ───────────────────────────────────────────────────────────────────────────────────

export interface PostChargeArgs {
  fundId: string
  userId: string | null
  kind: IntercompanyKind
  chargeDate: string
  amount: number
  memo?: string | null
  payer: { vehicleId: string; name: string }
  payee: { vehicleId: string; name: string }
  /**
   * The payee's receivable is already on its books, line by line: a management company that paid
   * a fund's expenses booked each one to "Due from <fund>" as it paid. Only the payer's side is
   * posted, and the charge has no payee entry. Its settlement still clears both sides.
   */
  payeeAlreadyBooked?: boolean
}

/**
 * Record a charge and post both sides.
 *
 * ORDER MATTERS, and it is: create the row, post the payee, post the payer, then link. If the
 * payer's entry fails (a closed period on the fund's books is the realistic case), the payee's
 * entry is voided and the row is deleted, so a half-posted charge never survives. That rollback is
 * best-effort — supabase-js has no transaction — and the reason the row is created FIRST is that a
 * failure after the entries are written must still leave something that names them.
 */
export async function postIntercompanyCharge(
  admin: SupabaseClient,
  args: PostChargeArgs,
): Promise<{ id: string } | { error: string }> {
  const amount = roundCents(args.amount)
  if (!(amount > 0)) return { error: 'Amount must be greater than zero' }
  if (args.payer.vehicleId === args.payee.vehicleId) {
    return { error: 'A vehicle cannot charge itself' }
  }

  const { data: row, error: rowErr } = await admin
    .from('intercompany_transactions' as any)
    .insert({
      fund_id: args.fundId,
      from_vehicle_id: args.payer.vehicleId,
      to_vehicle_id: args.payee.vehicleId,
      kind: args.kind,
      charge_date: args.chargeDate,
      amount,
      memo: args.memo ?? null,
      status: 'accrued',
      created_by: args.userId,
    })
    .select('id')
    .single()
  if (rowErr) return { error: rowErr.message }
  const chargeId = (row as any).id as string

  const cleanup = async () => { await admin.from('intercompany_transactions' as any).delete().eq('id', chargeId) }

  // Each side's own intercompany sub-account for the OTHER side.
  let payeeAccts: SideAccounts | { error: string }
  let payerAccts: SideAccounts | { error: string }
  try {
    const payeeIc = await ensureIntercompanyAccounts(admin, args.fundId, args.payee.name, args.payer)
    const payerIc = await ensureIntercompanyAccounts(admin, args.fundId, args.payer.name, args.payee)
    payeeAccts = await resolveSideAccounts(admin, args.fundId, args.payee.name, args.kind, 'payee', payeeIc.receivableAccountId)
    payerAccts = await resolveSideAccounts(admin, args.fundId, args.payer.name, args.kind, 'payer', payerIc.payableAccountId)
  } catch (e) {
    await cleanup()
    return { error: (e as Error).message }
  }
  if ('error' in payeeAccts && !args.payeeAlreadyBooked) { await cleanup(); return payeeAccts }
  if ('error' in payerAccts) { await cleanup(); return payerAccts }

  const input: ChargeInput = {
    fundId: args.fundId, kind: args.kind, chargeDate: args.chargeDate,
    amount, memo: args.memo, chargeId,
  }

  let payeeEntryId: string | null = null
  if (!args.payeeAlreadyBooked) {
    const payeeRes = await persistEntry(
      admin, args.fundId, args.payee.name, args.userId, buildPayeeEntry(input, payeeAccts as SideAccounts),
    )
    if ('error' in payeeRes) { await cleanup(); return { error: `${args.payee.name}: ${payeeRes.error}` } }
    payeeEntryId = payeeRes.entryId
  }

  const payerRes = await persistEntry(
    admin, args.fundId, args.payer.name, args.userId, buildPayerEntry(input, payerAccts),
  )
  if ('error' in payerRes) {
    // Both sides or neither. A charge that exists on one ledger only is exactly the drift this
    // module was written to prevent, so unwind rather than report a partial success.
    if (payeeEntryId) {
      await admin.from('journal_postings' as any).delete().eq('journal_entry_id', payeeEntryId)
      await admin.from('journal_entries' as any).delete().eq('id', payeeEntryId)
    }
    await cleanup()
    return { error: `${args.payer.name}: ${payerRes.error}` }
  }

  await admin
    .from('intercompany_transactions' as any)
    .update({
      to_entry_id: payeeEntryId,
      from_entry_id: payerRes.entryId,
      // A cash kind moves the money as it is recorded; there is nothing left to settle.
      ...(isAccruingKind(args.kind) ? {} : { status: 'settled', settled_date: args.chargeDate }),
    })
    .eq('id', chargeId)

  return { id: chargeId }
}

/**
 * Settle an accrued charge: post the cash on both sides and mark the row settled.
 *
 * Refuses a charge that is already settled or void rather than posting a second pair of cash
 * entries, which would clear a balance that was already clear and leave the counterparty holding a
 * receivable that has now been paid twice on our books and once on theirs.
 */
export async function settleIntercompanyCharge(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  chargeId: string,
  settledDate: string,
): Promise<{ ok: true } | { error: string }> {
  const { data: row } = await admin
    .from('intercompany_transactions' as any)
    .select('*')
    .eq('id', chargeId).eq('fund_id', fundId).maybeSingle()
  if (!row) return { error: 'Charge not found' }
  const charge = row as any
  if (charge.status !== 'accrued') return { error: `That charge is already ${charge.status}.` }

  const names = await vehicleNames(admin, fundId, [charge.from_vehicle_id, charge.to_vehicle_id])
  const payer = names.get(charge.from_vehicle_id)
  const payee = names.get(charge.to_vehicle_id)
  if (!payer || !payee) return { error: 'One side of that charge is no longer a vehicle in this fund.' }

  const payeeIc = await ensureIntercompanyAccounts(admin, fundId, payee, { vehicleId: charge.from_vehicle_id, name: payer })
  const payerIc = await ensureIntercompanyAccounts(admin, fundId, payer, { vehicleId: charge.to_vehicle_id, name: payee })
  const payeeAccts = await resolveSideAccounts(admin, fundId, payee, charge.kind, 'payee', payeeIc.receivableAccountId)
  const payerAccts = await resolveSideAccounts(admin, fundId, payer, charge.kind, 'payer', payerIc.payableAccountId)
  if ('error' in payeeAccts) return payeeAccts
  if ('error' in payerAccts) return payerAccts

  const input = {
    fundId, kind: charge.kind as IntercompanyKind, chargeDate: charge.charge_date,
    amount: Number(charge.amount), memo: charge.memo, chargeId, settledDate,
  }

  const payeeRes = await persistEntry(admin, fundId, payee, userId, buildPayeeSettlementEntry(input, payeeAccts))
  if ('error' in payeeRes) return { error: `${payee}: ${payeeRes.error}` }
  const payerRes = await persistEntry(admin, fundId, payer, userId, buildPayerSettlementEntry(input, payerAccts))
  if ('error' in payerRes) {
    await admin.from('journal_postings' as any).delete().eq('journal_entry_id', payeeRes.entryId)
    await admin.from('journal_entries' as any).delete().eq('id', payeeRes.entryId)
    return { error: `${payer}: ${payerRes.error}` }
  }

  await admin.from('intercompany_transactions' as any).update({
    status: 'settled',
    settled_date: settledDate,
    to_settlement_entry_id: payeeRes.entryId,
    from_settlement_entry_id: payerRes.entryId,
  }).eq('id', chargeId)

  return { ok: true }
}

async function vehicleNames(
  admin: SupabaseClient,
  fundId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const { data } = await admin
    .from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId).in('id', ids)
  return new Map(((data as any[]) ?? []).map(v => [v.id as string, v.name as string]))
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────

export interface IntercompanyBalance {
  counterpartyVehicleId: string
  counterpartyName: string
  /** What this vehicle is owed by the counterparty (the 1900-<cp> balance). */
  dueFrom: number
  /** What this vehicle owes the counterparty (the 2900-<cp> balance). */
  dueTo: number
  /** dueFrom - dueTo. Shown alongside the two, never instead of them. */
  net: number
}

/**
 * Outstanding intercompany balances for one vehicle, per counterparty, FROM THE LEDGER.
 *
 * Reads the posted balance of each `1900-<cp>` / `2900-<cp>` account rather than summing the
 * register, so a manual correcting entry — the way half of all intercompany disputes are actually
 * resolved — is reflected here without anyone having to remember to also amend a row.
 *
 * `dueFrom` and `dueTo` are reported separately and only then netted. Netting first is how an
 * intercompany balance stops reconciling: the counterparty confirms a payable of X and a receivable
 * of Y, and a single net number matches neither.
 */
export async function intercompanyBalances(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<IntercompanyBalance[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []

  const { data: accts } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, subtype')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .in('subtype', [INTERCOMPANY_RECEIVABLE_SUBTYPE, INTERCOMPANY_PAYABLE_SUBTYPE])
  // The bare parents (1900 / 2900, no suffix) carry no counterparty, so they are not part of a
  // per-counterparty breakdown. Anything posted directly to them is a bookkeeping error the
  // statements will still show; this view is about who owes whom.
  const subAccounts = ((accts as any[]) ?? []).filter(a => (a.code as string).includes('-'))
  if (subAccounts.length === 0) return []

  // Entries and postings are loaded separately and joined here, the way every other reader in
  // lib/accounting does it — an embedded PostgREST join would be a second query shape for the same
  // data, and this one has to agree with the trial balance exactly.
  const [{ data: entries }, { data: postings }] = await Promise.all([
    admin.from('journal_entries' as any)
      .select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .eq('status', 'posted').eq('book', ACTUAL_BOOK),
    admin.from('journal_postings' as any)
      .select('journal_entry_id, account_id, amount')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK)
      .in('account_id', subAccounts.map(a => a.id)),
  ])
  const posted = new Set(((entries as any[]) ?? []).map(e => e.id as string))
  const balance = new Map<string, number>()
  for (const p of ((postings as any[]) ?? [])) {
    if (!posted.has(p.journal_entry_id)) continue
    balance.set(p.account_id, roundCents((balance.get(p.account_id) ?? 0) + Number(p.amount)))
  }

  // The 8-character id prefix in the code is what ties a sub-account back to a counterparty. Match
  // it against the fund's real vehicles so a stale account (a vehicle since merged away) still
  // reports its balance rather than vanishing with the money on it.
  const { data: vehicles } = await admin
    .from('fund_vehicles' as any).select('id, name').eq('fund_id', fundId)
  const byPrefix = new Map(((vehicles as any[]) ?? []).map(v => [(v.id as string).slice(0, 8), v]))

  const out = new Map<string, IntercompanyBalance>()
  for (const a of subAccounts) {
    const prefix = (a.code as string).split('-').slice(1).join('-')
    const vehicle = byPrefix.get(prefix)
    const key = (vehicle?.id as string) ?? prefix
    const row = out.get(key) ?? {
      counterpartyVehicleId: (vehicle?.id as string) ?? '',
      counterpartyName: (vehicle?.name as string) ?? 'Unknown counterparty',
      dueFrom: 0, dueTo: 0, net: 0,
    }
    const bal = balance.get(a.id as string) ?? 0
    // Postings are signed debit-positive. A receivable's natural balance is a debit; a payable's is
    // a credit, so its sign is flipped to report it as a positive amount owed.
    if (a.subtype === INTERCOMPANY_RECEIVABLE_SUBTYPE) row.dueFrom = roundCents(row.dueFrom + bal)
    else row.dueTo = roundCents(row.dueTo - bal)
    out.set(key, row)
  }

  return Array.from(out.values())
    .map(r => ({ ...r, net: roundCents(r.dueFrom - r.dueTo) }))
    .filter(r => r.dueFrom !== 0 || r.dueTo !== 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
}

/** The charge register for a vehicle — everything it is party to, either side. */
export async function listIntercompanyCharges(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  limit = 200,
) {
  const { data } = await admin
    .from('intercompany_transactions' as any)
    .select('*')
    .eq('fund_id', fundId)
    .or(`from_vehicle_id.eq.${vehicleId},to_vehicle_id.eq.${vehicleId}`)
    .order('charge_date', { ascending: false })
    .limit(limit)
  return ((data as any[]) ?? [])
}
