// Marry bank inflows to capital calls. Two paths:
//   allocate — attribute the inflow to ONE named partner, funding their open call if they
//              have one, replacing the auto-drafted two-line entry.
//   link     — match the inflow to a call the GP already recorded from a notice
//              (e.g. via the allocations page or draft-from-document): post that
//              entry, drop the auto-draft, and mark the transaction reconciled.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOwnership, loadEntityNames } from './load'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { buildCapitalCallEntry, buildFundingEntry, buildDistributionEntry, buildDistributionSettlementEntry } from './entries'
import { computeCapitalAccounts } from './capital-account'
import { allocateAmount } from './allocation'
import { lpReceivableBalances, lpPayableBalances, RECEIVABLE_CODE } from './capital-calls'
import { DISTRIBUTION_PAYABLE_CODE } from './chart'
import { roundCents } from './ledger'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import type { JournalEntry } from './types'
import { ACTUAL_BOOK } from './books'
import { postExistingEntryWithAllocation } from './continuous-allocation'
import { underReview } from './bank-review'

async function getTxn(admin: SupabaseClient, fundId: string, group: string, txnId: string) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('bank_transactions' as any)
    .select('id, journal_entry_id, amount, txn_date, description, status, raw')
    .eq('id', txnId)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  return data as any
}

/**
 * Turn an inflow into a capital-call entry. With `lpEntityId`, the whole inflow
 * is attributed to one LP: if that LP has an open (called-but-unfunded) balance
 * it FUNDS the call — Dr Cash / Cr the receivable, clearing it — otherwise there's
 * no open call, so it recognizes AND funds one in a single step (Dr Cash / Cr the
 * LP's capital). WITHOUT `lpEntityId` it refuses: a deposit is one partner's money, and
 * splitting it across everyone by commitment is never what a single wire means.
 */
export async function bookCapitalCallFromInflow(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  txnId: string,
  lpEntityId?: string | null
): Promise<{ entryId: string } | { error: string }> {
  const txn = await getTxn(admin, fundId, group, txnId)
  if (!txn) return { error: 'Transaction not found' }
  if (underReview(txn.raw)) return { error: 'This bank transaction is linked to, or awaiting a match with, an existing entry. Resolve it on the bank page before booking another.' }
  const total = Number(txn.amount)
  if (total <= 0) return { error: 'Only an inflow (deposit) can be booked as a capital call' }

  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')
  if (!cashId) return { error: "The chart is missing account 1000 Cash — add it under the entity's Admin → Chart of accounts." }

  let entry: JournalEntry
  let suggestedCode = '3100'
  if (lpEntityId) {
    const names = await loadEntityNames(admin, fundId, group)
    if (!names.has(lpEntityId)) return { error: 'That LP has no position in this vehicle' }
    const lpName = names.get(lpEntityId)
    const openReceivable = (await lpReceivableBalances(admin, fundId, group)).get(lpEntityId) ?? 0
    const receivableId = codes.get(RECEIVABLE_CODE)

    if (openReceivable > 0.005 && receivableId) {
      // There's an open call — fund it: Dr Cash / Cr the receivable (no new capital).
      entry = buildFundingEntry(
        { fundId, entryDate: txn.txn_date, memo: `Funding — ${lpName}${txn.description ? ` — ${txn.description}` : ''}` },
        lpEntityId,
        total,
        cashId,
        receivableId
      )
      suggestedCode = RECEIVABLE_CODE
    } else {
      // No open call — recognize and fund it at once: Dr Cash / Cr LP capital.
      const capMap = await ensureCapitalAccounts(admin, fundId, group, [lpEntityId])
      const capId = capMap.get(lpEntityId)
      if (!capId) return { error: 'Could not resolve the LP capital account' }
      entry = {
        fundId,
        entryDate: txn.txn_date,
        memo: `Capital call — ${lpName}${txn.description ? ` — ${txn.description}` : ''}`,
        sourceType: 'capital_call',
        postings: [
          { accountId: cashId, amount: roundCents(total), currency: 'USD', lpEntityId: null },
          { accountId: capId, amount: roundCents(-total), currency: 'USD', lpEntityId },
        ],
      }
    }
  } else {
    // Same rule as the outflow: a deposit is one partner's money. Splitting it across every LP
    // by commitment made a single wire look like a fund-wide call, and credited the partner who
    // actually paid with a fraction of what they sent.
    return { error: 'Name the partner this deposit came from. If it really is a fund-wide call, issue the call on the Capital accounts page first — the deposit then settles it.' }
  }

  const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
  if ('error' in result) return { error: result.error }

  // Point the transaction at the new entry, then retire the old two-line draft.
  const oldEntryId = txn.journal_entry_id
  await admin.from('bank_transactions' as any).update({ journal_entry_id: result.entryId, suggested_account_code: suggestedCode }).eq('id', txnId).eq('fund_id', fundId)
  if (oldEntryId && oldEntryId !== result.entryId) {
    const retired = await retireEntry(admin, fundId, oldEntryId)
    if ('error' in retired) return { error: retired.error }
  }
  return { entryId: result.entryId }
}

/**
 * Retire the entry a bank transaction used to point at.
 *
 * A DRAFT is deleted — it was never part of the books, so there is nothing to preserve.
 * A POSTED entry is VOIDED, never deleted. This used to `delete()` unconditionally, which
 * meant re-running "book as call" on an already-reconciled inflow silently erased a posted
 * ledger entry with no audit trail — the exact immutability the journal route enforces
 * everywhere else.
 */
async function retireEntry(
  admin: SupabaseClient,
  fundId: string,
  entryId: string
): Promise<{ ok: true } | { error: string }> {
  const { data: entry } = await admin
    .from('journal_entries' as any)
    .select('status')
    .eq('book', ACTUAL_BOOK)
    .eq('id', entryId)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!entry) return { ok: true } // already gone

  const status = (entry as any).status
  if (status === 'draft') {
    const { error } = await admin.from('journal_entries' as any).delete().eq('id', entryId).eq('fund_id', fundId)
    if (error) return { error: error.message }
    return { ok: true }
  }

  // Posted or already void — void it (idempotent) and keep the record.
  const { error } = await admin
    .from('journal_entries' as any)
    .update({ status: 'void', posted_at: null })
    .eq('id', entryId)
    .eq('fund_id', fundId)
  if (error) return { error: error.message }
  return { ok: true }
}

/**
 * Who gets how much of a distribution — the precedence rules, pulled out so they can be
 * pinned by a test.
 *
 * A named partner takes the whole amount; explicit per-LP amounts are used as given (and must
 * total the transaction). There is deliberately NO pro-rata fallback.
 *
 * There used to be, and it was the bug: an unnamed outflow was split across every partner by
 * capital balance, so a $500 wire to ONE partner debited all twenty — the recipient credited
 * with $12.50 of their own money. A bank wire is a single payment to a single party. Pro-rata
 * is a property of DECLARING a distribution (`proRataDistribution`), which happens before any
 * money moves; it cannot be inferred from the fact that money moved.
 */
export function resolveDistributionSplit(
  total: number,
  opts: {
    lpEntityId?: string | null
    perLpOverride?: Map<string, number> | null
  },
): { perLp: Map<string, number> } | { error: string } {
  const { lpEntityId, perLpOverride } = opts

  if (lpEntityId) {
    // The amount comes from the transaction, so the client never computes it and can't
    // disagree with the bank.
    return { perLp: new Map([[lpEntityId, total]]) }
  }

  if (perLpOverride && perLpOverride.size > 0) {
    const sum = roundCents(Array.from(perLpOverride.values()).reduce((s, v) => s + v, 0))
    if (Math.abs(sum - total) > 0.01) {
      return { error: `The per-LP amounts total ${sum}, but the transaction is ${total}.` }
    }
    return { perLp: perLpOverride }
  }

  return { error: 'Name the partner this payment went to. If it really is a fund-wide distribution, declare it on the Capital accounts page first — the wire then settles that declaration.' }
}

/**
 * Turn an outflow into a DISTRIBUTION entry: Dr each LP's capital, Cr cash.
 *
 * The counterpart to `bookCapitalCallFromInflow`, and the fix for a real hole: the bank
 * categorizer's distribution rule posts to the pooled `3100 Partners' capital (unallocated)`
 * with `lp_entity_id = null`. But `loadPostedLedger` only counts a posting as a capital
 * movement when BOTH the account and the posting carry an lp_entity_id — so a
 * bank-categorized distribution reduced fund NAV while appearing in NOBODY's capital account,
 * statement, or roll-forward. The money left and no LP was recorded as having received it.
 *
 * SPLIT BASIS: capital balance, not commitment. You distribute what a partner OWNS, not what
 * they promised — an LP who has funded 10% of the capital but committed 20% is owed a share
 * of the proceeds proportional to the former. (A capital CALL is the mirror image, and
 * correctly splits by commitment.) Pass `perLp` to override with explicit amounts, which is
 * what a waterfall would supply.
 *
 * `lpEntityId` books the WHOLE outflow to one partner — the mirror of naming a single LP on a
 * capital call, and the common case when a wire went to one person. It takes precedence over
 * the pro-rata split and, unlike it, does not require a positive capital balance: naming the
 * partner is the operator asserting who received the money.
 */
export async function bookDistributionFromOutflow(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  txnId: string,
  perLpOverride?: Map<string, number> | null,
  lpEntityId?: string | null
): Promise<{ entryId: string } | { error: string }> {
  const txn = await getTxn(admin, fundId, group, txnId)
  if (!txn) return { error: 'Transaction not found' }
  if (underReview(txn.raw)) return { error: 'This bank transaction is linked to, or awaiting a match with, an existing entry. Resolve it on the bank page before booking another.' }
  const amount = Number(txn.amount)
  if (amount >= 0) return { error: 'Only an outflow (withdrawal) can be booked as a distribution' }
  const total = Math.abs(amount)

  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')
  if (!cashId) return { error: "The chart is missing account 1000 Cash — add it under the entity's Admin → Chart of accounts." }

  // A named partner with a DECLARED distribution outstanding settles it, rather than reducing
  // their capital a second time. Exactly the shape `bookCapitalCallFromInflow` already uses for
  // an open call: recognition happened at declaration, so settlement carries no capital effect.
  if (lpEntityId) {
    const openPayable = (await lpPayableBalances(admin, fundId, group)).get(lpEntityId) ?? 0
    const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE)
    if (openPayable > 0.005 && payableId) {
      const names = await loadEntityNames(admin, fundId, group)
      const entry = buildDistributionSettlementEntry(
        { fundId, entryDate: txn.txn_date, memo: `Distribution paid — ${names.get(lpEntityId) ?? ''}${txn.description ? ` — ${txn.description}` : ''}` },
        lpEntityId, total, cashId, payableId,
      )
      const saved = await persistEntry(admin, fundId, group, userId, entry, 'draft')
      if ('error' in saved) return { error: saved.error }
      const prior = txn.journal_entry_id
      await (admin as any).from('bank_transactions')
        .update({ journal_entry_id: saved.entryId, suggested_account_code: DISTRIBUTION_PAYABLE_CODE })
        .eq('id', txnId).eq('fund_id', fundId)
      if (prior && prior !== saved.entryId) {
        const retired = await retireEntry(admin, fundId, prior)
        if ('error' in retired) return { error: retired.error }
      }
      return { entryId: saved.entryId }
    }
  }

  const split = resolveDistributionSplit(total, { lpEntityId, perLpOverride })
  if ('error' in split) return split
  const perLp = split.perLp

  const capMap = await ensureCapitalAccounts(admin, fundId, group, Array.from(perLp.keys()))
  const entry = buildDistributionEntry(
    { fundId, entryDate: txn.txn_date, memo: `Distribution${txn.description ? ` — ${txn.description}` : ''}` },
    perLp,
    capMap,
    cashId
  )

  const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
  if ('error' in result) return { error: result.error }

  const oldEntryId = txn.journal_entry_id
  await admin.from('bank_transactions' as any)
    .update({ journal_entry_id: result.entryId, suggested_account_code: '3100' })
    .eq('id', txnId).eq('fund_id', fundId)
  if (oldEntryId && oldEntryId !== result.entryId) {
    const retired = await retireEntry(admin, fundId, oldEntryId)
    if ('error' in retired) return { error: retired.error }
  }
  return { entryId: result.entryId }
}

/** Link an inflow to an existing recorded entry (post it, mark reconciled). */
export async function linkInflowToEntry(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  txnId: string,
  entryId: string,
  userId: string | null = null,
): Promise<{ ok: true } | { error: string }> {
  const txn = await getTxn(admin, fundId, group, txnId)
  if (!txn) return { error: 'Transaction not found' }
  if (underReview(txn.raw)) return { error: 'This bank transaction is linked to, or awaiting a match with, an existing entry. Resolve it on the bank page before booking another.' }

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: target } = await admin
    .from('journal_entries' as any)
    .select('id, status, entry_date')
    .eq('book', ACTUAL_BOOK)
    .eq('id', entryId).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!target) return { error: 'Entry not found' }

  // Only a draft may be posted. Without this, linking to a VOIDED entry resurrected it
  // straight to `posted` — a transition the journal route explicitly forbids — and linking to
  // an already-posted entry let two bank transactions both claim it, each reading
  // "reconciled" while the ledger was short one deposit.
  const status = (target as any).status
  if (status === 'void') return { error: 'That entry was voided. Pick another, or create a new one.' }
  if (status === 'posted') {
    const { data: claimed } = await admin
      .from('bank_transactions' as any)
      .select('id')
      .eq('fund_id', fundId)
      .eq('journal_entry_id', entryId)
      .neq('id', txnId)
      .maybeSingle()
    if (claimed) return { error: 'Another bank transaction is already reconciled against that entry.' }
  }

  // Refuse to post into a closed period. The database now refuses this too
  // (20260714000004), but a clear message beats a constraint violation.
  const closed = await closedPeriodRanges(admin, fundId, group)
  if (dateInAnyClosedPeriod(closed, (target as any).entry_date)) {
    return { error: `That entry is dated ${(target as any).entry_date}, inside a closed period — reopen it first.` }
  }

  // Retire the auto-drafted entry (if any), then link + post the target.
  const oldEntryId = txn.journal_entry_id
  if (oldEntryId && oldEntryId !== entryId) {
    const retired = await retireEntry(admin, fundId, oldEntryId)
    if ('error' in retired) return { error: retired.error }
  }
  if (status === 'draft') {
    const posted = await postExistingEntryWithAllocation(admin, fundId, group, userId, entryId)
    if ('error' in posted) return posted
  }
  await admin.from('bank_transactions' as any).update({ journal_entry_id: entryId, status: 'reconciled' }).eq('id', txnId).eq('fund_id', fundId)
  return { ok: true }
}

export interface CallCandidate {
  entryId: string
  amount: number
  entryDate: string
  memo: string | null
  status: string
}

/**
 * Recorded capital-call entries not yet linked to a bank transaction, with the
 * cash amount of each — the candidates an inflow can be matched to.
 */
export async function capitalCallCandidates(admin: SupabaseClient, fundId: string, group: string): Promise<CallCandidate[]> {
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')
  if (!cashId) return []

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: entries } = await admin
    .from('journal_entries' as any)
    .select('id, entry_date, memo, status, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('source_type', 'capital_call')
    .neq('status', 'void')
    .order('entry_date', { ascending: false })
    .limit(200)

  const { data: linkedRows } = await admin
    .from('bank_transactions' as any)
    .select('journal_entry_id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .not('journal_entry_id', 'is', null)
  const linked = new Set(((linkedRows as any[]) ?? []).map(r => r.journal_entry_id))

  return ((entries as any[]) ?? [])
    .filter(e => !linked.has(e.id))
    .map(e => {
      const cash = (e.journal_postings ?? []).filter((p: any) => p.account_id === cashId).reduce((s: number, p: any) => s + Number(p.amount), 0)
      return { entryId: e.id, amount: cash, entryDate: e.entry_date, memo: e.memo, status: e.status }
    })
    .filter(c => c.amount > 0)
}
