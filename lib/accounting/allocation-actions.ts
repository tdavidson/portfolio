// Entry-building for the agent/MCP `allocation` tool. Builds (but does not persist)
// the balanced entry for an action; the caller decides preview vs post.
//
// NOTE — despite the name, these actions no longer ALLOCATE to partners' capital.
// Booking an expense, fee, gain, or mark posts P&L only; allocation to capital
// accounts happens in exactly one place, the period close (`./close.ts`). The two
// used to both allocate, which would have double-counted. Distributions and carry
// still move capital directly — they are capital movements, not P&L.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOwnership } from './load'
import { accountIdByCode, ensureCapitalAccounts } from './persist'
import { ensureVehicleAccounts } from './provision-accounts'
import { computeManagementFee } from './fees'
import { scheduledFee } from './fee-schedule'
import { loadPartnerTerms } from './terms'
import {
  buildManagementFeeEntry,
  buildExpenseEntry,
  buildGainEntry,
  buildDistributionPaymentEntry,
  buildCarryEntry,
  buildPeriodCloseEntry,
  type CapitalAccountMap,
  type PnlAccounts,
} from './entries'
import type { JournalEntry } from './types'
import { lpPayableBalances } from './capital-calls'
import { DISTRIBUTION_PAYABLE_CODE } from './chart'

export const CODE = {
  cash: '1000',
  dueToGp: '2100',
  gpCapital: '3000',
  bridge: '3200',
  realizedGains: '4000',
  unrealizedIncome: '4200',
  mgmtFeeExpense: '5000',
  mgmtFeeOffsets: '5010',
  partnershipExpense: '5100',
}

export interface AllocationBody {
  action: string
  entryDate: string
  memo?: string
  annualRate?: number
  periodFraction?: number
  /** Charge the fee the vehicle's schedule sets for the period `entryDate` falls in (fee-schedule.ts). */
  fromSchedule?: boolean
  amount?: number
  overrides?: Record<string, { rateOverride?: number; exempt?: boolean }>
  perLp?: Record<string, number>
}

export async function buildAllocationEntry(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  body: AllocationBody
): Promise<{ entry: JournalEntry } | { error: string }> {
  const { action, entryDate } = body
  if (!action || !entryDate) return { error: 'action and entryDate are required' }

  let codes = await accountIdByCode(admin, fundId, group)
  const need = (code: string): string => {
    const id = codes.get(code)
    if (!id) throw new Error(`The chart is missing account ${code} — add it under the entity's Admin → Chart of accounts.`)
    return id
  }
  const base = { fundId, entryDate, memo: body.memo }

  try {
    if (action === 'close_period') {
      // REMOVED, deliberately — it was incompatible with the close model and silently broke it.
      //
      // It zeroed INCEPTION-TO-DATE P&L into the 3200 bridge. But the current model requires
      // P&L accounts to stay open (close.ts), because the close measures each period's activity
      // from them. Once an agent ran this, `previewClose` for the window containing the zeroing
      // entry saw P&L netting to ~0, so the real close allocated nothing at all — and
      // `unallocatedEarnings` went nonsensical.
      //
      // The close is the only allocation path. Point callers at it rather than leaving a
      // loaded gun on the table.
      return {
        error:
          'close_period is not an allocation action. Use the `close_period` tool (or POST /api/accounting/close), ' +
          'which closes through a date and allocates each month to the partners. This action zeroed P&L ' +
          'inception-to-date and prevented the real close from allocating anything.',
      }
    }

    if (action === 'management_fee' && body.fromSchedule) {
      const scheduled = await scheduledFee(admin, fundId, group, entryDate, body.overrides)
      if (!scheduled) return { error: `${entryDate} is outside ${group}'s fee schedule, so it charges no fee for it.` }
      if ('error' in scheduled) return { error: scheduled.error }
      const accts: PnlAccounts = { pnlAccountId: need(CODE.mgmtFeeExpense), offsetAccountId: need(CODE.dueToGp) }
      const p = scheduled.period
      // The offset is booked to its own contra account, so a chart set up before that account
      // existed gets it now (creating standard accounts is idempotent and never edits one).
      if (p.offset > 0 && !codes.has(CODE.mgmtFeeOffsets)) {
        await ensureVehicleAccounts(admin, fundId, group)
        codes = await accountIdByCode(admin, fundId, group)
      }
      const memo = body.memo ?? `Management fee ${p.start} to ${p.end}` + (p.offset > 0 ? ` (${p.gross.toFixed(2)} less ${p.offset.toFixed(2)} of offsets)` : '')
      const offset = p.offset > 0 ? { amount: p.offset, accountId: need(CODE.mgmtFeeOffsets) } : undefined
      return { entry: buildManagementFeeEntry({ ...base, memo }, scheduled.fee, accts, 'USD', offset) }
    }
    if (action === 'management_fee') {
      const [owners, terms] = await Promise.all([
        loadOwnership(admin, fundId, group),
        loadPartnerTerms(admin, fundId, group),
      ])

      // SIDE LETTERS COME FROM THE TERMS TABLE, not just the request body.
      //
      // `partner_allocation_terms.rate_override` and `participates` are what the Allocation
      // terms page writes — a GP configuring "this LP pays 1.5%, the GP entity pays nothing"
      // sets them there. But this function only ever read overrides handed to it in the
      // request body (which in practice only the external agent supplies), so a configured
      // side letter changed absolutely nothing. It does now.
      //
      // An explicit body override still wins: a caller asking for a specific rate on a
      // specific run is being deliberate, and shouldn't be silently overruled by config.
      const feeTerms = new Map(
        terms.filter(t => t.category === 'management_fee').map(t => [t.lpEntityId, t])
      )
      const overrides = body.overrides ?? {}

      const feeOwners = owners.map(o => {
        const configured = feeTerms.get(o.lpEntityId)
        return {
          lpEntityId: o.lpEntityId,
          basisAmount: o.commitment,
          rateOverride: overrides[o.lpEntityId]?.rateOverride ?? configured?.rateOverride ?? null,
          exempt: overrides[o.lpEntityId]?.exempt ?? (configured ? !configured.participates : false),
        }
      })
      const fee = computeManagementFee(
        { annualRate: Number(body.annualRate), basis: 'committed', periodFraction: Number(body.periodFraction) },
        feeOwners
      )
      const accts: PnlAccounts = { pnlAccountId: need(CODE.mgmtFeeExpense), offsetAccountId: need(CODE.dueToGp) }
      return { entry: buildManagementFeeEntry(base, fee, accts) }
    }
    if (action === 'expense') {
      const accts: PnlAccounts = { pnlAccountId: need(CODE.partnershipExpense), offsetAccountId: need(CODE.cash) }
      return { entry: buildExpenseEntry(base, Number(body.amount), accts) }
    }
    if (action === 'gain') {
      const accts: PnlAccounts = { pnlAccountId: need(CODE.realizedGains), offsetAccountId: need(CODE.cash) }
      return { entry: buildGainEntry(base, Number(body.amount), accts) }
    }
    // Distributions and carry DO move capital directly — they aren't P&L.
    const capMap: CapitalAccountMap = await ensureCapitalAccounts(admin, fundId, group, Object.keys(body.perLp ?? {}))

    if (action === 'distribution') {
      // A partner with a declared distribution outstanding is PAID from the payable: their capital
      // came down when it was declared. Debiting capital again (what this did for every line)
      // double-counted the distribution and left 2300 standing. Only an amount beyond what they
      // are owed is a new distribution out of capital.
      const perLp = new Map<string, number>(Object.entries(body.perLp ?? {}).map(([k, v]) => [k, Number(v)]))
      const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE) ?? null
      const openPayable = payableId ? await lpPayableBalances(admin, fundId, group) : new Map<string, number>()
      return { entry: buildDistributionPaymentEntry(base, perLp, openPayable, capMap, need(CODE.cash), payableId) }
    }
    if (action === 'carry') {
      const perLp = new Map<string, number>(Object.entries(body.perLp ?? {}).map(([k, v]) => [k, Number(v)]))
      return { entry: buildCarryEntry(base, perLp, capMap, need(CODE.gpCapital)) }
    }
    return { error: `Unknown action ${action}` }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** The source_ref namespace of entries the agent `allocation` tool posts. Unique while live
 *  (20261013141500_agent_allocation_source_ref_once.sql). Not `allocation:` — that prefix marks the
 *  entries the ledger GENERATES when it allocates a posted entry (continuous-allocation.ts). */
export const AGENT_ALLOCATION_REF_PREFIX = 'agent-allocation:'

/**
 * A deterministic source_ref for an allocation-tool entry: the action, the date and the entry's
 * lines (account, partner, amount in cents — summed per account and partner, sorted). Two chats
 * asking for the same carry reallocation get the same ref, so the second is refused instead of
 * booked. The memo is left out on purpose: two sessions describe the same entry in different words.
 * The vehicle and book are not in the hash because the uniqueness is already scoped to them.
 */
export function allocationSourceRef(action: string, entry: Pick<JournalEntry, 'entryDate' | 'postings'>): string {
  const cents = new Map<string, number>()
  for (const p of entry.postings) {
    const k = `${p.accountId}|${p.lpEntityId ?? ''}`
    cents.set(k, (cents.get(k) ?? 0) + Math.round(Number(p.amount) * 100))
  }
  const lines = Array.from(cents.entries()).filter(([, c]) => c !== 0).map(([k, c]) => `${k}|${c}`).sort()
  const digest = createHash('sha256').update(JSON.stringify([action, entry.entryDate, lines])).digest('hex').slice(0, 32)
  return `${AGENT_ALLOCATION_REF_PREFIX}${action}:${digest}`
}
