// Cost transfers between holdings: recording a new one, and converting an entry the reader adopted
// before transfers existed (as proceeds on the source plus an investment in the target).
//
// A cost transfer moves basis from one holding to another inside one entity with no cash and no
// gain: ONE journal entry, Dr Investment — target / Cr Investment — source, owning TWO
// `cost_transfer` rows (source −amount, target +amount). Readers: lib/portfolio/cost-transfer-math.ts.
//
// Recording posts the entry; adoption at posting (adoption.ts → readCostTransfer) writes the two
// rows, so a transfer typed here, posted by hand in the journal or imported from QuickBooks all end
// up the same. Converting never touches the journal: the entry is already right, only its rows are
// wrong, so they are replaced in place and the trial balance is unchanged.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { groupWriteDenial } from '@/lib/access/scope'
import { persistEntry } from '@/lib/accounting/persist'
import { ensureInvestmentAccounts } from '@/lib/accounting/investments'
import { loadVehicleChart } from '@/lib/accounting/investment-accounts'
import { readCostTransfer } from '@/lib/accounting/adopt'
import { closedPeriodRanges, dateInAnyClosedPeriod } from '@/lib/accounting/periods'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { vehicleKindByName } from '@/lib/accounting/vehicle-domain'
import { roundCents } from '@/lib/accounting/ledger'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { remainingCostAt } from '@/lib/portfolio/distribution-cost-recovery'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export interface CostTransferEditor {
  fundId: string
  userId: string | null
  /** The caller's writable entity names; null = every entity. */
  vehicleNames: string[] | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

async function companyNames(admin: SupabaseClient, fundId: string, ids: string[]): Promise<Map<string, string>> {
  const { data, error } = await (admin as any).from('companies').select('id, name').eq('fund_id', fundId).in('id', ids)
  if (error) throw new Error(`The holdings could not be read: ${error.message}`)
  return new Map(((data as any[]) ?? []).map(c => [c.id as string, c.name as string]))
}

// ---------------------------------------------------------------------------------------------
// Record a new transfer
// ---------------------------------------------------------------------------------------------

export interface RecordCostTransferInput {
  fromCompanyId: string
  toCompanyId: string
  amount: number
  date: string
  /** The entity that holds both (its name). */
  vehicle: string
  memo?: string | null
}

export interface RecordedCostTransfer {
  entryId: string
  vehicle: string
  date: string
  amount: number
  from: { id: string; name: string }
  to: { id: string; name: string }
  transactions: { id: string; company_id: string; investment_cost: number }[]
}

/** Checks a transfer could be recorded, without writing anything. Shared by the preview and the write. */
async function checkTransfer(
  admin: SupabaseClient, who: CostTransferEditor, input: RecordCostTransferInput,
): Promise<Outcome<{ amount: number; vehicle: string; names: Map<string, string> }>> {
  const amount = roundCents(n(input.amount))
  if (!(amount > 0)) return fail(400, 'amount must be a positive number: the cost moved from one holding to the other.')
  if (!DATE.test(String(input.date ?? ''))) return fail(400, 'date must be YYYY-MM-DD.')
  if (!input.fromCompanyId || !input.toCompanyId) return fail(400, 'Both holdings are required.')
  if (input.fromCompanyId === input.toCompanyId) return fail(400, 'The two holdings are the same; a transfer moves cost between two different holdings.')
  const vehicle = String(input.vehicle ?? '').trim()
  if (!vehicle) return fail(400, 'Name the entity that holds both holdings.')
  const denied = groupWriteDenial(who.vehicleNames, vehicle)
  if (denied) return fail(403, denied)
  if (!(await vehicleIdByName(admin, who.fundId, vehicle))) return fail(404, `No entity named "${vehicle}".`)
  const kind = await vehicleKindByName(admin, who.fundId, vehicle)
  if (kind === 'manco' || kind === 'associate') return fail(400, `${vehicle} holds no investments; record the transfer in the fund that holds them.`)
  const closed = await closedPeriodRanges(admin, who.fundId, vehicle)
  if (dateInAnyClosedPeriod(closed, input.date)) return fail(409, `The period covering ${input.date} is closed. Reopen it to record a transfer there.`)

  let names: Map<string, string>
  try { names = await companyNames(admin, who.fundId, [input.fromCompanyId, input.toCompanyId]) } catch (e) { return fail(500, (e as Error).message) }
  if (!names.has(input.fromCompanyId) || !names.has(input.toCompanyId)) return fail(404, 'Holding not found.')

  // The source must carry the cost it gives up, on this entity, on that date.
  let remaining: number
  try { remaining = await remainingCostAt(admin, who.fundId, input.fromCompanyId, vehicle, input.date) } catch (e) { return fail(500, (e as Error).message) }
  if (remaining + 0.005 < amount) {
    return fail(400, `${names.get(input.fromCompanyId)} carries ${remaining.toFixed(2)} of cost on ${vehicle} on ${input.date}, less than the ${amount.toFixed(2)} to transfer.`)
  }
  return done({ amount, vehicle, names })
}

export async function previewCostTransfer(admin: SupabaseClient, who: CostTransferEditor, input: RecordCostTransferInput) {
  const checked = await checkTransfer(admin, who, input)
  if (!checked.ok) return checked
  const { amount, vehicle, names } = checked.value
  return done({
    summary: `Transfer ${amount.toFixed(2)} of cost from ${names.get(input.fromCompanyId)} to ${names.get(input.toCompanyId)} on ${vehicle}, dated ${input.date}. `
      + 'One journal entry, no cash and no gain: the source\'s invested capital and cost go down, the target\'s start on that date.',
  })
}

export async function recordCostTransfer(
  admin: SupabaseClient, who: CostTransferEditor, input: RecordCostTransferInput,
): Promise<Outcome<RecordedCostTransfer>> {
  const checked = await checkTransfer(admin, who, input)
  if (!checked.ok) return checked
  const { amount, vehicle, names } = checked.value
  const from = { id: input.fromCompanyId, name: names.get(input.fromCompanyId)! }
  const to = { id: input.toCompanyId, name: names.get(input.toCompanyId)! }

  const accounts = await ensureInvestmentAccounts(admin, who.fundId, vehicle, [from, to])
  const fromAcct = accounts.get(from.id)
  const toAcct = accounts.get(to.id)
  if (!fromAcct || !toAcct) return fail(500, 'The holdings\' investment accounts could not be found or created.')

  const memo = (input.memo ?? '').trim() || `Cost transfer: ${from.name} to ${to.name}`
  // Posting adopts it: readCostTransfer reads exactly this shape as the two cost_transfer rows.
  const posted = await persistEntry(admin, who.fundId, vehicle, who.userId, {
    fundId: who.fundId,
    entryDate: input.date,
    memo,
    postings: [
      { accountId: toAcct.costId, amount, currency: 'USD' },
      { accountId: fromAcct.costId, amount: -amount, currency: 'USD' },
    ],
  }, 'posted', ACTUAL_BOOK, true, { investments: true })
  if ('error' in posted) return fail(409, `The transfer was not recorded: ${posted.error}`)

  const { data, error } = await (admin as any).from('investment_transactions')
    .select('id, company_id, investment_cost').eq('fund_id', who.fundId).eq('adopted_entry_id', posted.entryId)
  if (error) return dbFail(error, 'cost-transfer-record')
  if (who.userId) logActivity(admin, who.fundId, who.userId, 'investment.cost_transfer', { entryId: posted.entryId, fromCompanyId: from.id, toCompanyId: to.id })
  return done({
    entryId: posted.entryId, vehicle, date: input.date, amount, from, to,
    transactions: ((data as any[]) ?? []).map(t => ({ id: t.id, company_id: t.company_id, investment_cost: n(t.investment_cost) })),
  })
}

// ---------------------------------------------------------------------------------------------
// Convert an entry adopted as proceeds + an investment
// ---------------------------------------------------------------------------------------------

export interface CostTransferConversion {
  entryId: string
  entryDate: string
  vehicle: string
  amount: number
  from: { id: string; name: string }
  to: { id: string; name: string }
  /** The rows replaced: the proceeds on the source and the investment in the target. */
  replaced: { id: string; company_id: string; transaction_type: string }[]
  /** The cost_transfer rows written (empty on a dry run). */
  created: { id: string; company_id: string; investment_cost: number }[]
  dryRun: boolean
}

/**
 * Replace the proceeds and investment rows adopted from a transfer-shaped entry with the two
 * cost_transfer rows it should have been read as. The journal entry is not touched. Refuses unless
 * the entry is a posted cost transfer (readCostTransfer) owning exactly a proceeds row on the source
 * (basis = proceeds = the amount, nothing in escrow or written off) and an investment row in the
 * target at that cost, neither linked to the fund register or a conversion.
 */
export async function convertToCostTransfer(
  admin: SupabaseClient, who: CostTransferEditor, entryId: string, opts: { dryRun?: boolean } = {},
): Promise<Outcome<CostTransferConversion>> {
  if (!entryId) return fail(400, 'entry_id is required: the journal entry the transfer was adopted from.')
  const { data: entry, error: entryError } = await (admin as any).from('journal_entries')
    .select('id, fund_id, book, status, entry_date, vehicle_id, source_ref, memo, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', who.fundId).eq('id', entryId).maybeSingle()
  if (entryError) return dbFail(entryError, 'cost-transfer-convert')
  if (!entry) return fail(404, 'Journal entry not found.')
  if (entry.status !== 'posted') return fail(409, `That entry is ${entry.status}, not posted. Only a posted entry's transactions are converted.`)

  const vehicle = entry.vehicle_id ? await vehicleNameById(admin, who.fundId, entry.vehicle_id) : null
  if (!vehicle) return fail(404, 'The entry\'s entity could not be found.')
  const denied = groupWriteDenial(who.vehicleNames, vehicle)
  if (denied) return fail(403, denied)
  const closed = await closedPeriodRanges(admin, who.fundId, vehicle)
  if (dateInAnyClosedPeriod(closed, entry.entry_date)) {
    return fail(409, `The entry is dated ${entry.entry_date}, inside a closed period. Reopen the period to convert it.`)
  }

  const chart = await loadVehicleChart(admin, who.fundId, entry.vehicle_id)
  const pair = readCostTransfer(((entry.journal_postings ?? []) as any[]).map(p => ({ accountId: p.account_id, amount: n(p.amount) })), chart)
  if (!pair) {
    return fail(400, 'That entry is not a cost transfer: its only lines must be a credit to one holding\'s investment account and an equal '
      + 'debit to another\'s, with no cash and no gain or loss. A real exit stays as proceeds.')
  }
  const [source, target] = pair
  const amount = n(target.investment_cost)

  const { data: owned, error: ownedError } = await (admin as any).from('investment_transactions')
    .select('*').eq('fund_id', who.fundId).eq('adopted_entry_id', entryId)
  if (ownedError) return dbFail(ownedError, 'cost-transfer-convert')
  const rows = (owned as any[]) ?? []
  if (rows.length === 2 && rows.every(r => r.transaction_type === 'cost_transfer')) return fail(409, 'That entry is already a cost transfer.')

  const proceeds = rows.find(r => r.transaction_type === 'proceeds' && r.company_id === source.company_id)
  const investment = rows.find(r => r.transaction_type === 'investment' && r.company_id === target.company_id)
  const matches = rows.length === 2 && proceeds && investment
    && roundCents(Math.abs(n(proceeds.cost_basis_exited))) === amount
    && roundCents(n(proceeds.proceeds_received)) === amount
    && n(proceeds.proceeds_escrow) === 0 && n(proceeds.proceeds_written_off) === 0
    && roundCents(n(investment.investment_cost)) === amount
    && n(investment.fee_amount) === 0 && !investment.converts_from_txn_id
  if (!matches) {
    const found = rows.length === 0 ? 'no transactions' : rows.map(r => r.transaction_type).join(' and ')
    return fail(409, `That entry owns ${found}, not the proceeds on the source and the investment in the target at ${amount.toFixed(2)} each that a `
      + 'mislabeled transfer leaves. Nothing was changed.')
  }
  const oldIds = [proceeds.id as string, investment.id as string]

  // Anything pointing at the rows being replaced would lose its link: refuse rather than orphan it.
  const [navs, events, conversions] = await Promise.all([
    (admin as any).from('fund_nav_statements').select('id').eq('fund_id', who.fundId).in('investment_transaction_id', oldIds).limit(1),
    (admin as any).from('fund_capital_events').select('id').eq('fund_id', who.fundId).in('investment_transaction_id', oldIds).limit(1),
    (admin as any).from('investment_transactions').select('id').eq('fund_id', who.fundId).in('converts_from_txn_id', oldIds).limit(1),
  ])
  if (navs.error || events.error || conversions.error) return fail(500, 'Links to these transactions could not be checked, so nothing was changed. Try again.')
  if ((navs.data ?? []).length || (events.data ?? []).length) {
    return fail(409, 'The fund register (a capital notice or NAV statement) points at one of these transactions. Change it there first.')
  }
  if ((conversions.data ?? []).length) return fail(409, 'A conversion converts from one of these transactions. Re-point it first.')

  let names: Map<string, string>
  try { names = await companyNames(admin, who.fundId, [source.company_id, target.company_id]) } catch (e) { return fail(500, (e as Error).message) }
  const plan: CostTransferConversion = {
    entryId, entryDate: entry.entry_date, vehicle, amount,
    from: { id: source.company_id, name: names.get(source.company_id) ?? 'Investment' },
    to: { id: target.company_id, name: names.get(target.company_id) ?? 'Investment' },
    replaced: rows.map(r => ({ id: r.id, company_id: r.company_id, transaction_type: r.transaction_type })),
    created: [],
    dryRun: !!opts.dryRun,
  }
  if (opts.dryRun) return done(plan)

  // Write the new rows first, so the entry is never without an owner; then remove the old ones.
  const label = entry.memo ? `"${entry.memo}"` : entryId
  const note = `Cost transfer adopted from journal entry ${label} (${entry.entry_date}); replaced the proceeds and investment it was first read as.`
  const { data: created, error: insertError } = await (admin as any).from('investment_transactions').insert([
    { ...source, round_name: proceeds.round_name ?? null, shares_acquired: proceeds.shares_acquired == null ? null : -Math.abs(n(proceeds.shares_acquired)) },
    { ...target, round_name: investment.round_name ?? null, shares_acquired: investment.shares_acquired ?? null, security_type: investment.security_type ?? null },
  ].map(t => ({
    ...t,
    fund_id: who.fundId,
    transaction_date: entry.entry_date,
    portfolio_group: vehicle,
    adopted_entry_id: entryId,
    notes: note,
  }))).select('id, company_id, investment_cost')
  if (insertError) return dbFail(insertError, 'cost-transfer-convert-insert')
  const createdRows = (created as any[]) ?? []

  const { error: deleteError } = await (admin as any).from('investment_transactions').delete().eq('fund_id', who.fundId).in('id', oldIds)
  if (deleteError) {
    await (admin as any).from('investment_transactions').delete().eq('fund_id', who.fundId).in('id', createdRows.map(r => r.id))
    return dbFail(deleteError, 'cost-transfer-convert-delete')
  }
  if (who.userId) logActivity(admin, who.fundId, who.userId, 'investment.cost_transfer_convert', { entryId, replaced: oldIds })
  return done({ ...plan, created: createdRows.map(r => ({ id: r.id, company_id: r.company_id, investment_cost: n(r.investment_cost) })) })
}
