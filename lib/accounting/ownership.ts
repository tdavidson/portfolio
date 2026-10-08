// lib/accounting/ownership.ts
//
// Acting on an OWNED entry in the journal — voiding, unposting, editing or reversing it — is
// deleting the investment transactions that own it (plans/spec-ledger-one-writer.md §1, "Owned
// entries in the journal"). Otherwise the tracker keeps a transaction the books no longer carry,
// and a reversal of a purchase would be adopted as an exit at cost.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'

const TXN = 'txn:'

export interface OwningTransaction { id: string; companyId: string; company: string; type: string; date: string | null }

export async function owningTransactions(
  admin: SupabaseClient, fundId: string, entry: { id: string; source_ref: string | null },
): Promise<OwningTransaction[]> {
  const ref = entry.source_ref ?? ''
  const [{ data: adopted }, { data: derived }] = await Promise.all([
    admin.from('investment_transactions' as any).select('id, company_id, transaction_type, transaction_date')
      .eq('fund_id', fundId).eq('adopted_entry_id', entry.id),
    ref.startsWith(TXN)
      ? admin.from('investment_transactions' as any).select('id, company_id, transaction_type, transaction_date')
          .eq('fund_id', fundId).eq('id', ref.slice(TXN.length))
      : Promise.resolve({ data: [] as any[] }),
  ])
  const rows = [...((derived as any[]) ?? []), ...((adopted as any[]) ?? [])]
  if (rows.length === 0) return []
  const { data: companies } = await admin.from('companies' as any).select('id, name')
    .eq('fund_id', fundId).in('id', Array.from(new Set(rows.map(r => r.company_id))))
  const name = new Map(((companies as any[]) ?? []).map(c => [c.id as string, c.name as string]))
  return rows.map(r => ({
    id: r.id, companyId: r.company_id, company: name.get(r.company_id) ?? 'Investment',
    type: r.transaction_type, date: r.transaction_date ?? null,
  }))
}

export async function releaseOwnership(
  admin: SupabaseClient, fundId: string, entry: { id: string; source_ref: string | null },
): Promise<{ removed: OwningTransaction[]; unlinked: string[] } | { error: string }> {
  const removed = await owningTransactions(admin, fundId, entry)
  if (removed.length === 0) return { removed, unlinked: [] }
  const ids = removed.map(t => t.id)

  // A conversion's basis is its source instrument; deleting the source would orphan it.
  const { data: dependents } = await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).in('converts_from_txn_id', ids)
  if (((dependents as any[]) ?? []).length > 0) {
    return { error: 'A conversion on this company converts from a transaction this entry records. Delete or re-point the conversion first.' }
  }

  // The register keeps its rows; they only lose the link (on delete set null). Say which.
  const [{ data: events }, { data: navs }] = await Promise.all([
    admin.from('fund_capital_events' as any).select('kind, event_date').eq('fund_id', fundId).in('investment_transaction_id', ids),
    admin.from('fund_nav_statements' as any).select('as_of_date').eq('fund_id', fundId).in('investment_transaction_id', ids),
  ])
  const unlinked = [
    ...((events as any[]) ?? []).map(e => `the ${e.kind} of ${e.event_date}`),
    ...((navs as any[]) ?? []).map(n => `the NAV as of ${n.as_of_date}`),
  ]

  const { error } = await admin.from('investment_transactions' as any).delete().eq('fund_id', fundId).in('id', ids)
  if (error) return { error: `Its investment transactions could not be deleted: ${error.message}` }
  if ((entry.source_ref ?? '').startsWith(TXN)) {
    await admin.from('journal_entries' as any).update({ source_ref: null }).eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entry.id)
  }
  return { removed, unlinked }
}
