import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts).
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fetchAllRows } from '@/lib/accounting/load'
import { trialBalance } from '@/lib/accounting/statements'
import { parseQbTrialBalance, compareTrialBalance } from '@/lib/accounting/quickbooks/tie-out'
import type { Account, Posting } from '@/lib/accounting/types'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

/**
 * Step 4: our trial balance against QuickBooks', account by account, at one period end.
 *
 * The migration is done when EVERY period ties — not when the import runs without errors.
 *
 * Includes DRAFT entries deliberately: imported entries are drafts until reviewed and bulk
 * posted, so a posted-only trial balance would read zero all the way through the migration
 * and the tie-out would be useless exactly when it is needed. The response says so, and the
 * UI labels it.
 *
 * Compares the ACTUAL book. Transactions the import routed to the tax book (a tax-basis file's
 * K-1 entries, book-routing.ts) are in the QuickBooks trial balance but deliberately not in ours,
 * so the imported tax-book entries are taken out of the QuickBooks side and reported separately
 * as `taxRouted` (compareTrialBalance). Only imported ones: the tax run's own adjustments were
 * never in QuickBooks.
 *
 * POST — { text, asOf, group? }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.text !== 'string' || !body.text.trim()) {
    return NextResponse.json({ error: 'Paste the QuickBooks trial balance first.' }, { status: 400 })
  }
  if (typeof body?.asOf !== 'string') {
    return NextResponse.json({ error: 'asOf (YYYY-MM-DD) is required' }, { status: 400 })
  }

  const group = await resolveGroupOr400(admin, gate, body?.group ?? null)
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const { rows: theirs, errors } = parseQbTrialBalance(body.text)
  if (errors.length > 0) return NextResponse.json({ error: errors.join(' ') }, { status: 400 })

  // Paginated: a migrated vehicle can hold far more than the PostgREST 1000-row default, and a
  // truncated ledger produces a tie-out that fails for the wrong reason.
  const [acctRows, entryRows, postingRows, mappingRows, taxEntryRows, taxPostingRows] = await Promise.all([
    fetchAllRows((f, t) => admin.from('chart_of_accounts' as any)
      .select('id, code, name, type, subtype, company_id, lp_entity_id')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
    fetchAllRows((f, t) => admin.from('journal_entries' as any)
      .select('id, status, entry_date, source_type, memo')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
      .in('status', ['posted', 'draft'])
      .lte('entry_date', body.asOf).order('id').range(f, t)),
    fetchAllRows((f, t) => admin.from('journal_postings' as any)
      .select('journal_entry_id, account_id, amount, currency')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
    (admin as any).from('qb_account_mappings')
      .select('qb_account, account_code, excluded')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('source', 'quickbooks'),
    fetchAllRows((f, t) => admin.from('journal_entries' as any)
      .select('id')
      .eq('book', 'tax').eq('source_type', 'quickbooks')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
      .in('status', ['posted', 'draft'])
      .lte('entry_date', body.asOf).order('id').range(f, t)),
    fetchAllRows((f, t) => admin.from('journal_postings' as any)
      .select('journal_entry_id, account_id, amount, currency')
      .eq('book', 'tax')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
  ])

  const inWindow = new Set(((entryRows as any[]) ?? []).map(e => e.id))
  const accounts: Account[] = ((acctRows as any[]) ?? []).map(a => ({
    id: a.id, fundId: gate.fundId, code: a.code, name: a.name,
    type: a.type, subtype: a.subtype, lpEntityId: a.lp_entity_id, companyId: a.company_id ?? null,
  }))
  const postings: Posting[] = ((postingRows as any[]) ?? [])
    .filter(p => inWindow.has(p.journal_entry_id))
    .map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency }))

  const mapping = new Map<string, string>()
  for (const r of ((mappingRows as any)?.data ?? [])) {
    if (!r.excluded && r.account_code) mapping.set(r.qb_account, r.account_code)
  }

  const pooledCapital = accounts.find(a => a.type === 'equity' && a.subtype === 'lp_capital' && !a.lpEntityId)
  const capitalRollups = new Map(accounts.filter(a => a.type === 'equity' && a.subtype === 'lp_capital' && a.lpEntityId && pooledCapital)
    .map(a => [a.code, pooledCapital!.code]))
  const ours = trialBalance(accounts, postings)
  const taxIds = new Set(((taxEntryRows as any[]) ?? []).map(e => e.id))
  const taxRouted = trialBalance(accounts, ((taxPostingRows as any[]) ?? [])
    .filter(p => taxIds.has(p.journal_entry_id))
    .map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency })))
  const result = compareTrialBalance(ours, theirs, mapping, capitalRollups, taxRouted)
  const qbEntryIds = new Set((entryRows as any[]).filter(e => e.source_type === 'quickbooks').map(e => e.id))
  const qbPostings = (postingRows as any[]).filter(p => qbEntryIds.has(p.journal_entry_id))
    .map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency }))
  const quickBooksOnly = compareTrialBalance(trialBalance(accounts, qbPostings), theirs, mapping, capitalRollups, taxRouted)
  const cashIds = new Set(accounts.filter(a => a.code === '1000' || a.subtype === 'cash').map(a => a.id))
  const openingEntries = (entryRows as any[]).filter(e => e.source_type === 'opening_balance').map(e => ({
    id: e.id, date: e.entry_date, memo: e.memo, status: e.status,
    cash: Math.round((postingRows as any[]).filter(p => p.journal_entry_id === e.id && cashIds.has(p.account_id))
      .reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100,
  }))

  return NextResponse.json({
    asOf: body.asOf,
    ...result,
    includesDrafts: true,
    taxRoutedEntryCount: taxIds.size,
    quickBooksOnly: { ties: quickBooksOnly.ties, differenceCount: quickBooksOnly.lines.length },
    openingEntries,
    unmappedAccounts: theirs.filter(r => !mapping.has(r.account)).map(r => r.account),
  })
}
