// Keep a bank draft's source type in step with the account it posts to.
//
// A bank row's draft entry takes its source type from the first suggestion at import. When nothing
// is recognised, an inflow falls back to members' / LP capital and the entry is a capital call.
// Re-pointing the row on the bank page or through the agent fixes the type
// (setBankTransactionAccount), but other edits to the account do not, such as a line changed in the
// Journal or a re-point made before that fix shipped. An interest receipt then posted as a capital
// call, and anything that groups or filters by source type counted it as one.
//
// Run from the posting choke point (postExistingEntryWithAllocation) so every path that posts a
// bank draft gets the same answer before the entry becomes posted.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'
import { counterPosting } from './bank'
import { sourceTypeFollowingAccount } from './bank-categorize'

/**
 * Correct the source type of a draft linked to a bank row when it contradicts the account of the
 * draft's one non-cash line (see sourceTypeFollowingAccount). Entries with no bank row, split
 * entries and drafts already consistent are left alone. Never throws: a failed read leaves the
 * entry as it was, which is how it would have posted before.
 */
export async function alignBankEntrySourceType(
  admin: SupabaseClient, fundId: string, vehicleId: string | null, entryId: string,
): Promise<{ from: string; to: string } | null> {
  try {
    const { data: bank } = await admin.from('bank_transactions' as any).select('amount')
      .eq('fund_id', fundId).eq('journal_entry_id', entryId).limit(1).maybeSingle()
    const bankAmount = Number((bank as any)?.amount ?? 0)
    if (!bank || !bankAmount) return null

    const [{ data: entry }, { data: postings }, { data: cash }] = await Promise.all([
      admin.from('journal_entries' as any).select('source_type, status')
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).maybeSingle(),
      admin.from('journal_postings' as any).select('account_id, amount')
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('journal_entry_id', entryId),
      admin.from('chart_of_accounts' as any).select('id')
        .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('code', '1000').maybeSingle(),
    ])
    const current = (entry as any)?.source_type as string | undefined
    if (!current || (entry as any)?.status !== 'draft') return null

    const counter = counterPosting((postings as any[]) ?? [], (cash as any)?.id, bankAmount)
    if (!counter) return null
    const { data: acct } = await admin.from('chart_of_accounts' as any).select('code, name, type, subtype')
      .eq('fund_id', fundId).eq('id', counter.account_id).maybeSingle()
    if (!acct) return null

    const next = sourceTypeFollowingAccount(current, acct as any, bankAmount > 0)
    if (next === current) return null
    const { error } = await admin.from('journal_entries' as any).update({ source_type: next })
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).eq('status', 'draft')
    return error ? null : { from: current, to: next }
  } catch {
    return null
  }
}
