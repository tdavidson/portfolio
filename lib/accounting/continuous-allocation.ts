import { adoptEntry, removeAdopted, settleLostRace } from './adoption'
import { loadResolvedCommitments } from './terms'
import type { SupabaseClient } from '@supabase/supabase-js'
import { allocateAmountCumulatively } from './allocation'
import { computeCapitalAccounts } from './capital-account'
import { ACTUAL_BOOK } from './books'
import { closesToOwnerEquity } from '@/lib/vehicle-kinds'
import { loadPostedLedger, loadEntityNames, loadOwnership } from './load'
import { roundCents } from './ledger'
import { ensureCapitalAccounts, accountIdByCode, persistEntry } from './persist'
import {
  allocationWeights, loadAllocationBasis, loadCommitmentEvents, loadPartnerTerms,
  resolveCommitmentMap, type AllocationCategory,
} from './terms'
import type { Account, JournalEntry, Posting } from './types'
import { vehicleKindByName } from './vehicle-domain'
import { vehicleIdByName } from './vehicle-id'

const BRIDGE_CODE = '3200'

const SUBTYPE_TO_SOURCE: Record<string, AllocationCategory> = {
  management_fee: 'management_fee', partnership_expense: 'partnership_expense',
  organizational_expense: 'organizational_expense', interest_expense: 'partnership_expense',
  operating_expense: 'partnership_expense', realized_gain: 'realized_gain',
  unrealized: 'valuation', interest_income: 'income', portfolio_income: 'income',
  equity_method: 'income',
}

function categoryFor(account: Account): AllocationCategory {
  return (account.subtype && SUBTYPE_TO_SOURCE[account.subtype])
    || (account.type === 'expense' ? 'partnership_expense' : 'income')
}

/** Generated allocation entries are balance-sheet-only, but the explicit tag is the recursion guard. */
export function isGeneratedAllocation(sourceRef?: string | null): boolean {
  return Boolean(sourceRef?.startsWith('allocation:'))
}

/** Allocate one newly-posted source entry using the partner basis effective on its transaction date. */
export async function allocatePostedEntry(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  sourceEntryId: string, entry: JournalEntry,
): Promise<{ allocationEntryIds: string[] } | { error: string }> {
  if (isGeneratedAllocation(entry.sourceRef)) return { allocationEntryIds: [] }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const { data: existing } = await admin.from('journal_entry_allocations' as any)
    .select('allocation_entry_id').eq('source_entry_id', sourceEntryId)
  if (((existing as any[]) ?? []).length > 0) {
    const ids = Array.from(new Set(((existing as any[]) ?? []).map(row => row.allocation_entry_id as string)))
    await admin.from('journal_entries' as any).update({ status: 'posted', posted_at: new Date().toISOString() })
      .eq('fund_id', fundId).in('id', ids)
    return { allocationEntryIds: ids }
  }

  const { accounts, capitalPostings } = await loadPostedLedger(admin, fundId, group, entry.entryDate)
  const accountById = new Map(accounts.map(account => [account.id, account]))
  const byCategory = new Map<AllocationCategory, number>()
  for (const posting of entry.postings) {
    const account = accountById.get(posting.accountId)
    if (!account || (account.type !== 'income' && account.type !== 'expense')) continue
    const category = categoryFor(account)
    byCategory.set(category, roundCents((byCategory.get(category) ?? 0) - posting.amount))
  }
  for (const [category, amount] of Array.from(byCategory)) if (amount === 0) byCategory.delete(category)
  if (byCategory.size === 0) return { allocationEntryIds: [] }

  const kind = await vehicleKindByName(admin, fundId, group)
  const ownerMode = closesToOwnerEquity(kind)
  const codes = await accountIdByCode(admin, fundId, group)
  const bridgeId = codes.get(BRIDGE_CODE)
  if (!bridgeId) return { error: `Missing account ${BRIDGE_CODE} (Undistributed earnings)` }

  const [owners, names, basis, terms, events] = await Promise.all([
    loadOwnership(admin, fundId, group), loadEntityNames(admin, fundId, group),
    loadAllocationBasis(admin, fundId, group), loadPartnerTerms(admin, fundId, group),
    loadCommitmentEvents(admin, fundId, group),
  ])
  let basisAmounts: { lpEntityId: string; basisAmount: number }[] = []
  if (!ownerMode && basis === 'capital_balance') {
    const balances = computeCapitalAccounts(capitalPostings, { end: entry.entryDate })
    basisAmounts = Array.from(balances, ([lpEntityId, account]) => ({ lpEntityId, basisAmount: account.ending }))
  } else if (!ownerMode) {
    basisAmounts = Array.from((await loadResolvedCommitments(admin, fundId, group, entry.entryDate)),
      ([lpEntityId, basisAmount]) => ({ lpEntityId, basisAmount }))
  }

  let ownerCapitalId: string | undefined
  if (ownerMode) {
    const owner = accounts.find(account => account.subtype === 'members_capital')
    ownerCapitalId = owner?.id
    if (!ownerCapitalId) return { error: 'No owner capital account is configured' }
  }

  const allocationEntryIds: string[] = []
  for (const [category, capitalEffect] of byCategory) {
    const sourceRef = `allocation:${sourceEntryId}:${category}`
    let lines: { lpEntityId: string; exactAmount: number; amount: number }[] = []
    let postings: Posting[]
    if (ownerMode) {
      postings = [
        { accountId: bridgeId, amount: capitalEffect, currency: 'USD' },
        { accountId: ownerCapitalId!, amount: -capitalEffect, currency: 'USD' },
      ]
    } else {
      const weights = allocationWeights(basisAmounts.filter(row => row.basisAmount > 0), terms, category)
      if (weights.length === 0) return { error: `No partner participates in ${category}` }
      const { data: history } = await admin.from('journal_entry_allocations' as any)
        .select('lp_entity_id, exact_amount, posted_amount, journal_entries!journal_entry_allocations_allocation_entry_id_fkey(status)')
        .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source_type', category)
      const residuals = new Map<string, number>()
      for (const row of ((history as any[]) ?? [])) {
        if (!row.lp_entity_id || row.journal_entries?.status !== 'posted') continue
        residuals.set(row.lp_entity_id, (residuals.get(row.lp_entity_id) ?? 0) + Number(row.exact_amount) - Number(row.posted_amount))
      }
      lines = allocateAmountCumulatively(capitalEffect, weights, residuals)
      const capMap = await ensureCapitalAccounts(admin, fundId, group, lines.map(line => line.lpEntityId))
      postings = [{ accountId: bridgeId, amount: capitalEffect, currency: 'USD' }]
      for (const line of lines) if (line.amount !== 0) postings.push({
        accountId: capMap.get(line.lpEntityId)!, amount: -line.amount, currency: 'USD', lpEntityId: line.lpEntityId,
      })
    }

    const allocation: JournalEntry = {
      fundId, entryDate: entry.entryDate, sourceType: category, sourceRef,
      memo: `${entry.memo || 'Journal entry'} — ${ownerMode ? 'owner equity' : 'partner'} allocation`, postings,
    }
    const saved = await persistEntry(admin, fundId, group, userId, allocation, 'posted', ACTUAL_BOOK, false)
    if ('error' in saved) return saved
    allocationEntryIds.push(saved.entryId)
    {
      const evidenceLines: { lpEntityId: string | null; exactAmount: number; amount: number }[] = lines.length > 0
        ? lines
        : [{ lpEntityId: null, exactAmount: capitalEffect, amount: capitalEffect }]
      const { error } = await admin.from('journal_entry_allocations' as any).insert(evidenceLines.map(line => ({
        fund_id: fundId, vehicle_id: vehicleId, source_entry_id: sourceEntryId,
        allocation_entry_id: saved.entryId, source_type: category, lp_entity_id: line.lpEntityId,
        exact_amount: line.exactAmount, posted_amount: line.amount,
      })))
      if (error) {
        await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', saved.entryId)
        return { error: `Could not preserve allocation evidence: ${error.message}` }
      }
    }
  }
  return { allocationEntryIds }
}

/** Keep generated allocations in step when a source entry is unposted or voided. */
export async function setGeneratedAllocationStatus(
  admin: SupabaseClient, fundId: string, sourceEntryId: string, status: 'draft' | 'void',
): Promise<{ error?: string }> {
  const { data } = await admin.from('journal_entry_allocations' as any)
    .select('allocation_entry_id').eq('fund_id', fundId).eq('source_entry_id', sourceEntryId)
  const ids = Array.from(new Set(((data as any[]) ?? []).map(row => row.allocation_entry_id as string)))
  if (ids.length === 0) return {}
  const { error } = await admin.from('journal_entries' as any)
    .update({ status, posted_at: null }).eq('fund_id', fundId).in('id', ids)
  return error ? { error: error.message } : {}
}

/** Remove a failed, never-committed allocation attempt so retrying starts cleanly. */
export async function rollbackGeneratedAllocations(
  admin: SupabaseClient, fundId: string, sourceEntryId: string,
): Promise<void> {
  // Allocations are only ever posted to the actual book (allocatePostedEntry), so that is the
  // only book to clear; a tax-book entry is never one of them.
  const { data } = await admin.from('journal_entries' as any).select('id')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).like('source_ref', `allocation:${sourceEntryId}:%`)
  const ids = ((data as any[]) ?? []).map(row => row.id as string)
  if (ids.length > 0) await admin.from('journal_entries' as any).delete().eq('fund_id', fundId).in('id', ids)
  await admin.from('journal_entry_allocations' as any).delete().eq('fund_id', fundId).eq('source_entry_id', sourceEntryId)
}

/** The canonical draft -> posted transition for entries that already exist. */
export async function postExistingEntryWithAllocation(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, entryId: string,
): Promise<{ allocationEntryIds: string[] } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [{ data: header }, { data: rows }] = await Promise.all([
    admin.from('journal_entries' as any).select('entry_date, memo, source_type, source_ref, status')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', entryId).maybeSingle(),
    admin.from('journal_postings' as any).select('account_id, amount, currency, lp_entity_id')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('journal_entry_id', entryId),
  ])
  if (!header) return { error: 'Entry not found' }
  if ((header as any).status !== 'draft') return { error: 'Only a draft entry can be posted' }
  const postings = ((rows as any[]) ?? []).map(row => ({
    accountId: row.account_id as string, amount: Number(row.amount), currency: row.currency, lpEntityId: row.lp_entity_id,
  }))
  // Adopt BEFORE the flip, so the entry is owned when it becomes posted (spec §1). A request that
  // loses the flip below settles its adopted rows against the winner's.
  const adoption = await adoptEntry(admin, fundId, {
    entryId, vehicleId: vehicleId!, entryDate: (header as any).entry_date, memo: (header as any).memo ?? null,
    sourceRef: (header as any).source_ref ?? null, postings,
  })
  if ('refused' in adoption) return { error: adoption.refused }
  const adopted = adoption.adoptedIds
  // Compare-and-set: flip it only if it is STILL a draft. Two requests that both read the draft
  // (a bank match racing a "post without a bank match") would otherwise both post and both run
  // the partner allocation, doubling it. The loser finds no draft and stops here.
  const { data: flipped, error: statusError } = await admin.from('journal_entries' as any)
    .update({ status: 'posted', posted_at: new Date().toISOString() })
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).eq('status', 'draft').select('id')
  if (statusError) { await removeAdopted(admin, fundId, adopted); return { error: statusError.message } }
  if (!((flipped as any[]) ?? []).length) {
    await settleLostRace(admin, fundId, entryId, adopted)
    return { error: 'Only a draft entry can be posted' }
  }
  const entry: JournalEntry = {
    fundId, entryDate: (header as any).entry_date, memo: (header as any).memo,
    sourceType: (header as any).source_type, sourceRef: (header as any).source_ref,
    postings,
  }
  const allocated = await allocatePostedEntry(admin, fundId, group, userId, entryId, entry)
  if ('error' in allocated) {
    await rollbackGeneratedAllocations(admin, fundId, entryId)
    await removeAdopted(admin, fundId, adopted)
    await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('fund_id', fundId).eq('id', entryId)
    return allocated
  }
  return allocated
}
