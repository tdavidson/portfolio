import type { SupabaseClient } from '@supabase/supabase-js'
import { draftEntryForTransaction } from '@/lib/accounting/from-portfolio'
import { vehicleNameById } from '@/lib/accounting/vehicle-id'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

/**
 * The register produces ordinary investment_transactions rows. It is the ONLY thing that
 * distinguishes a fund holding from a company holding below the register — everything after
 * this point (ledger posting, marks, exits, capital accounts, SOI, close) is the existing path.
 *
 * WHY A CALL CAPITALIZES IN FULL. An underlying manager calls capital for investments, its own
 * management fee, and partnership expenses. Under ASC 946 all of it is our cost basis in the
 * fund — the manager's fee is not our expense. The purpose split is captured for disclosure,
 * not to route different amounts to different accounts.
 */

export interface RegisterEvent {
  companyId: string
  kind: 'call' | 'distribution'
  eventDate: string
  amount: number
  recallableAmount: number
  charReturnOfCapital: number
  charRealizedGain: number
  charIncome: number
  purposeInvestments: number
  purposeFees: number
  purposeExpenses: number
}

export interface RegisterNav {
  companyId: string
  asOfDate: string
  reportedNav: number
  basis: 'final' | 'preliminary' | 'estimate'
}

export interface TransactionDraft {
  company_id: string
  transaction_type: 'investment' | 'proceeds' | 'unrealized_gain_change'
  transaction_date: string
  investment_cost?: number
  proceeds_received?: number
  cost_basis_exited?: number
  unrealized_value_change?: number
  notes?: string
}

/** Events before the cut-over were already posted by the migrated system — see Plan 3. */
const posts = (date: string, ledgerStartDate: string | null) =>
  !ledgerStartDate || date >= ledgerStartDate

const CENT = 0.005

export function transactionForEvent(
  e: RegisterEvent,
  opts: { ledgerStartDate: string | null },
): TransactionDraft | null {
  if (!posts(e.eventDate, opts.ledgerStartDate)) return null

  if (e.kind === 'call') {
    const split = e.purposeInvestments + e.purposeFees + e.purposeExpenses
    // A split that does not add up means a mistyped notice. Refuse it here rather than
    // capitalizing a number nobody can trace back to the manager's letter.
    if (Math.abs(split - e.amount) > CENT) {
      throw new Error(`Call purpose split (${split}) does not sum to the amount (${e.amount}).`)
    }
    return {
      company_id: e.companyId,
      transaction_type: 'investment',
      transaction_date: e.eventDate,
      investment_cost: e.amount,
    }
  }

  const split = e.charReturnOfCapital + e.charRealizedGain + e.charIncome
  if (Math.abs(split - e.amount) > CENT) {
    throw new Error(`Distribution character split (${split}) does not sum to the amount (${e.amount}).`)
  }
  return {
    company_id: e.companyId,
    transaction_type: 'proceeds',
    transaction_date: e.eventDate,
    proceeds_received: e.amount,
    // Only the return-of-capital character retires basis; gain and income do not.
    cost_basis_exited: e.charReturnOfCapital,
  }
}

/**
 * The mark a NAV statement implies, dated AT the statement's as-of date.
 *
 * No roll-forward here, deliberately: at the as-of date itself there are no later cash flows to
 * roll, so marking to the reported NAV is exact. lib/portfolio/fof-nav.ts calls this when a
 * statement is saved, with the ledger's carrying value at that date.
 */
export function transactionForNav(
  n: RegisterNav,
  opts: { carriedValue: number; ledgerStartDate: string | null },
): TransactionDraft | null {
  if (!posts(n.asOfDate, opts.ledgerStartDate)) return null
  const delta = n.reportedNav - opts.carriedValue
  if (Math.abs(delta) < CENT) return null      // ledger already agrees — no empty entry
  return {
    company_id: n.companyId,
    transaction_type: 'unrealized_gain_change',
    transaction_date: n.asOfDate,
    unrealized_value_change: delta,
  }
}

export interface ConfirmResult {
  ok: boolean
  transactionId?: string
  skipped?: 'before_ledger_start' | 'no_change'
  /**
   * Why the LEDGER entry was not drafted, when the transaction itself was written. Surfaced
   * rather than swallowed: a confirm that produces a transaction but no entry looks like a
   * success and silently leaves the position off the books.
   */
  ledgerSkipped?: string
  error?: string
}

/**
 * Confirm a draft register row: produce its transaction, draft the ledger entry through the
 * existing path, and back-link the two. Idempotent — a row already carrying a transaction id
 * returns it rather than producing a second one.
 */
export async function confirmFundCapitalEvent(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  eventId: string,
): Promise<ConfirmResult> {
  const { data: row } = await (admin as any)
    .from('fund_capital_events')
    .select('*').eq('id', eventId).eq('fund_id', fundId).maybeSingle()
  if (!row) return { ok: false, error: 'Event not found.' }
  if (row.investment_transaction_id) {
    return { ok: true, transactionId: row.investment_transaction_id }
  }

  const { data: settings } = await (admin as any)
    .from('vehicle_accounting_settings')
    .select('ledger_start_date')
    .eq('fund_id', fundId).eq('vehicle_id', row.vehicle_id)
    .maybeSingle()

  let draft: TransactionDraft | null
  try {
    draft = transactionForEvent(toRegisterEvent(row), {
      ledgerStartDate: settings?.ledger_start_date ?? null,
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  if (!draft) {
    // Memo-only history. Confirmed, but nothing posts.
    await (admin as any).from('fund_capital_events')
      .update({ status: 'confirmed' }).eq('id', eventId).eq('fund_id', fundId)
    return { ok: true, skipped: 'before_ledger_start' }
  }

  // The vehicle NAME, not the id: investment_transactions.portfolio_group is the text name,
  // and draftEntryForTransaction SKIPS any row without one ("no vehicle, so this is
  // company-wide pricing"). Omitting it produced a transaction with no ledger entry — a
  // silent half-write that reads as success.
  const group = row.vehicle_id ? await vehicleNameById(admin, fundId, row.vehicle_id) : null
  if (!group) {
    return { ok: false, error: 'This register row has no vehicle, so the entry has no books to post to.' }
  }

  const { data: txn, error } = await (admin as any)
    .from('investment_transactions')
    .insert({ ...draft, fund_id: fundId, portfolio_group: group })
    .select('*').single()
  if (error || !txn) return { ok: false, error: error?.message ?? 'Insert failed.' }

  await (admin as any).from('fund_capital_events')
    .update({ status: 'confirmed', investment_transaction_id: txn.id })
    .eq('id', eventId).eq('fund_id', fundId)

  const { data: holding } = await admin
    .from('companies').select('name').eq('id', row.company_id).maybeSingle()
  const drafted = await draftEntryForTransaction(admin, fundId, userId, txn, (holding as any)?.name ?? 'Fund')

  return {
    ok: true,
    transactionId: txn.id,
    ...(drafted?.drafted ? {} : { ledgerSkipped: drafted?.reason ?? 'No ledger entry was drafted.' }),
  }
}

function toRegisterEvent(row: any): RegisterEvent {
  return {
    companyId: row.company_id,
    kind: row.kind,
    eventDate: row.event_date,
    amount: Number(row.amount),
    recallableAmount: Number(row.recallable_amount ?? 0),
    charReturnOfCapital: Number(row.char_return_of_capital ?? 0),
    charRealizedGain: Number(row.char_realized_gain ?? 0),
    charIncome: Number(row.char_income ?? 0),
    purposeInvestments: Number(row.purpose_investments ?? 0),
    purposeFees: Number(row.purpose_fees ?? 0),
    purposeExpenses: Number(row.purpose_expenses ?? 0),
  }
}

/**
 * Which of our entities holds this fund, from its register OR its ledger accounts.
 *
 * A fund holding can be held by several of our entities (terms per (company, vehicle), NAVs per
 * (company, vehicle, date)). When it has exactly one, every later notice and NAV can infer it rather
 * than asking again; with none or several, the caller must say — nothing lands with a null vehicle,
 * which is what made these holdings unconfirmable and unscopeable.
 *
 * Returns every distinct vehicle found, so a caller can tell "none yet" from "ambiguous".
 */
export async function holdingVehicleIds(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
): Promise<string[]> {
  const [{ data: events }, { data: navs }, { data: accounts }] = await Promise.all([
    (admin as any).from('fund_capital_events').select('vehicle_id')
      .eq('fund_id', fundId).eq('company_id', companyId).not('vehicle_id', 'is', null),
    (admin as any).from('fund_nav_statements').select('vehicle_id')
      .eq('fund_id', fundId).eq('company_id', companyId).not('vehicle_id', 'is', null),
    // And the ledger, which usually knows first: a holding imported from a general ledger has
    // its own per-company investment accounts on one vehicle before any notice is recorded.
    (admin as any).from('chart_of_accounts').select('vehicle_id')
      .eq('fund_id', fundId).eq('company_id', companyId).not('vehicle_id', 'is', null),
  ])
  const ids = new Set<string>()
  for (const row of [...((events as any[]) ?? []), ...((navs as any[]) ?? []), ...((accounts as any[]) ?? [])]) {
    if (row.vehicle_id) ids.add(row.vehicle_id as string)
  }
  return Array.from(ids)
}

/**
 * The vehicle a new notice or NAV for this holding belongs to: the one the caller named, else the
 * one the holding already uses. Returns an error message rather than throwing, because every
 * caller turns it into a 400.
 */
export async function resolveHoldingVehicle(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  requested: unknown,
  /**
   * The caller's entities. Required: a holding two funds commit to is one company row, so the
   * company-level gate admits a member of either — this is what keeps one fund's member from
   * writing into, or inferring, the other's register.
   */
  access: Pick<AccessContext, 'vehicles'>,
): Promise<{ vehicleId: string } | { error: string }> {
  if (typeof requested === 'string' && requested) {
    const { data } = await admin
      .from('fund_vehicles' as any).select('id')
      .eq('fund_id', fundId).eq('id', requested).maybeSingle()
    if (!data) return { error: 'That entity is not in this fund.' }
    if (!canSeeVehicle(access, requested)) return { error: "You don't have access to that entity." }
    return { vehicleId: requested }
  }
  const existing = (await holdingVehicleIds(admin, fundId, companyId)).filter(id => canSeeVehicle(access, id))
  if (existing.length === 1) return { vehicleId: existing[0] }
  if (existing.length === 0) {
    return { error: 'Choose which entity holds this fund. A notice with no entity cannot be confirmed or reported.' }
  }
  return { error: 'This holding has activity under more than one entity. Say which one this belongs to.' }
}
