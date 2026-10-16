// Deleting a company (or digital asset), shared by DELETE /api/companies/[id] and the `delete_company`
// agent tool, so both refuse the same things in the same words.
//
// The caller has checked the grant and, where the web requires it, the role (admin-only:
// lib/access/admin-only.ts). What is checked here is what the record decides: that it is this
// fund's, that the caller may delete it for every entity it sits in, and that nothing on the books
// still hangs on it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { LEDGER_BOOKS } from '@/lib/accounting/books'
import { companyDeleteDenial } from '@/lib/access/company-delete'
import type { EntityScope } from '@/lib/access/entity-scope'
import { logActivity } from '@/lib/activity'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export async function deleteCompany(
  admin: SupabaseClient,
  who: { fundId: string; userId: string },
  companyId: string,
  /** The caller's entity scope, read only once the company is known to exist. */
  loadScope: () => Promise<Pick<EntityScope, 'access' | 'vehicleNames'>>,
): Promise<Outcome<{ ok: true; id: string; name: string }>> {
  // Scope the lookup to the caller's fund, and to companies and digital assets — both carry their
  // value in investment transactions and their own accounts, which the checks below cover (a
  // digital asset's wallets and price feed cascade with it). Fund holdings share the companies
  // table but have their own delete route with the register checks
  // (DELETE /api/portfolio/fund-holdings/[id]); the holding page's form sends them there.
  const { data: company, error: companyError } = await (admin as any)
    .from('companies')
    .select('id, name, fund_id, holding_type')
    .eq('id', companyId)
    .eq('fund_id', who.fundId)
    .in('holding_type', ['company', 'crypto'])
    .maybeSingle() as {
      data: { id: string; name: string; fund_id: string; holding_type: string | null } | null
      error: { message: string } | null
    }

  if (companyError) return dbFail(companyError, 'companies-id-delete-lookup')
  if (!company) return fail(404, 'Company not found')
  const noun = company.holding_type === 'crypto' ? 'digital asset' : 'company'

  // Deleting removes it for every entity, so a member may delete only a company wholly theirs.
  const deleteDenied = await companyDeleteDenial(admin, await loadScope(), company.id)
  if (deleteDenied) return fail(403, deleteDenied)

  // Each investment deletion retracts its mirrored journal entries and refuses closed periods.
  // Cascading the company row would bypass that accounting safeguard, so require the operator to
  // remove investment history through its own UI first.
  const { count: investmentCount, error: investmentError } = await (admin as any)
    .from('investment_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id)

  if (investmentError) return dbFail(investmentError, 'companies-id-delete-investments')
  if ((investmentCount ?? 0) > 0) {
    return fail(409, `Delete this ${noun}'s ${investmentCount} investment transaction${investmentCount === 1 ? '' : 's'} first so its accounting entries can be retracted safely.`)
  }

  // Refuse to orphan any company-specific chart accounts that still carry postings — any journal
  // entry on them the transaction check above does not account for.
  const { data: accountRows, error: accountError } = await (admin as any)
    .from('chart_of_accounts')
    .select('id')
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id) as {
      data: { id: string }[] | null
      error: { message: string } | null
    }
  if (accountError) return dbFail(accountError, 'companies-id-delete-accounts')

  const accountIds = (accountRows ?? []).map(account => account.id)
  if (accountIds.length > 0) {
    // A posting in ANY book pins the account — tax adjustments included.
    const { count: postingCount, error: postingError } = await (admin as any)
      .from('journal_postings')
      .select('id', { count: 'exact', head: true })
      .in('book', LEDGER_BOOKS)
      .eq('fund_id', company.fund_id)
      .in('account_id', accountIds)
    if (postingError) return dbFail(postingError, 'companies-id-delete-postings')
    if ((postingCount ?? 0) > 0) {
      return fail(409, `This ${noun}'s accounts still carry ${postingCount} ledger posting${postingCount === 1 ? '' : 's'}. Reverse those entries before deleting the ${noun}.`)
    }
  }

  // Capture uploaded-file paths before their rows cascade. The database delete is authoritative;
  // storage cleanup follows it so a transient storage failure can never leave live rows pointing
  // at files that have already disappeared.
  const { data: documentRows, error: documentError } = await (admin as any)
    .from('company_documents')
    .select('storage_path')
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id) as {
      data: { storage_path: string | null }[] | null
      error: { message: string } | null
    }
  if (documentError) return dbFail(documentError, 'companies-id-delete-documents')
  const storagePaths = (documentRows ?? [])
    .map(document => document.storage_path)
    .filter((path): path is string => Boolean(path))

  const { error: deleteError } = await (admin as any)
    .from('companies')
    .delete()
    .eq('id', company.id)
    .eq('fund_id', company.fund_id)
  if (deleteError) return dbFail(deleteError, 'companies-id-delete')

  // ON DELETE SET NULL leaves these empty per-company accounts ready for explicit cleanup.
  if (accountIds.length > 0) {
    const { error: accountDeleteError } = await (admin as any)
      .from('chart_of_accounts')
      .delete()
      .eq('fund_id', company.fund_id)
      .in('id', accountIds)
    if (accountDeleteError) {
      console.error('[companies-id-delete] Failed to remove empty chart accounts:', accountDeleteError.message)
    }
  }

  if (storagePaths.length > 0) {
    const { error: storageError } = await admin.storage.from('company-documents').remove(storagePaths)
    if (storageError) {
      console.error('[companies-id-delete] Failed to remove company document objects:', storageError.message)
    }
  }

  logActivity(admin, company.fund_id, who.userId, 'company.delete', {
    companyId: company.id,
    companyName: company.name,
  })

  return done({ ok: true, id: company.id, name: company.name })
}
