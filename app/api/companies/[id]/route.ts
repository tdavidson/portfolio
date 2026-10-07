import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import type { CompanyStatus } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { LEDGER_BOOKS } from '@/lib/accounting/books'
import { loadEntityScope, loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { canSeeVehicle, mergeGroupsForWrite, scopeGroups } from '@/lib/access/scope'

const VALID_STATUSES: CompanyStatus[] = ['active', 'exited', 'written-off']

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (error) return dbError(error, 'companies-id')
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Name only the caller's entities on it: that another fund also holds it is not theirs to see.
  const scope = await loadEntityScopeForUser(createAdminClient(), user.id)
  return NextResponse.json({ ...(data as Record<string, unknown>), portfolio_group: scopeGroups((data as any).portfolio_group, scope ? scope.vehicleNames : []) })
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { name, aliases, tags, stage, industry, country, notes, status, overview, founders, why_invested, current_update, contact_email, portfolio_group, google_drive_folder_id, google_drive_folder_name } = body

  if (name !== undefined && !name?.trim()) {
    return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Verify the user has access to this company's fund
  const { data: company } = await admin
    .from('companies')
    .select('fund_id, portfolio_group')
    .eq('id', params.id)
    .maybeSingle()

  if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: membership } = await admin
    .from('fund_members')
    .select('id')
    .eq('fund_id', company.fund_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = name.trim()
  if (aliases !== undefined) updates.aliases = aliases
  if (tags !== undefined) updates.tags = tags
  if (stage !== undefined) updates.stage = stage?.trim() || null
  if (industry !== undefined) updates.industry = industry
  // The Schedule of Investments renders a by-geography breakout from `companies.country`, but
  // the column was in no write path anywhere — so the table read "Unclassified" for every
  // position, permanently. This is that write path.
  if (country !== undefined) updates.country = country?.trim() || null
  if (notes !== undefined) updates.notes = notes?.trim() || null
  if (overview !== undefined) updates.overview = overview?.trim() || null
  if (founders !== undefined) updates.founders = founders?.trim() || null
  if (why_invested !== undefined) updates.why_invested = why_invested?.trim() || null
  if (current_update !== undefined) updates.current_update = current_update?.trim() || null
  if (contact_email !== undefined) updates.contact_email = contact_email
  if (portfolio_group !== undefined) {
    // A member edits only their own entities' part: the ones they cannot see are kept as they were,
    // and naming one they cannot see is refused (before ensureVehiclesByName could create it).
    const scope = await loadEntityScope(admin, writeCheck)
    const merged = mergeGroupsForWrite((company as any).portfolio_group, portfolio_group, scope.vehicleNames)
    if ('error' in merged) return NextResponse.json({ error: merged.error }, { status: 403 })
    // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
    // disconnected string. Resolve/create before the write, not after.
    await ensureVehiclesByName(admin, company.fund_id, merged.groups)
    updates.portfolio_group = merged.groups
  }
  if (google_drive_folder_id !== undefined) updates.google_drive_folder_id = google_drive_folder_id || null
  if (google_drive_folder_name !== undefined) updates.google_drive_folder_name = google_drive_folder_name || null
  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })
    }
    updates.status = status as CompanyStatus
  }

  const { data, error } = await admin
    .from('companies')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return dbError(error, 'companies-id')

  logActivity(admin, company.fund_id, user.id, 'company.update', { companyId: params.id })

  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Scope the lookup to the caller's fund and to ordinary portfolio companies. Fund holdings
  // share the companies table but have a separate delete route with stricter register checks.
  const { data: company, error: companyError } = await admin
    .from('companies' as any)
    .select('id, name, fund_id, holding_type')
    .eq('id', params.id)
    .eq('fund_id', writeCheck.fundId)
    .eq('holding_type', 'company')
    .maybeSingle() as {
      data: { id: string; name: string; fund_id: string; holding_type: string | null } | null
      error: { message: string } | null
    }

  if (companyError) return dbError(companyError, 'companies-id-delete-lookup')
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  // Deleting removes it for every entity, so a member may delete only a company no entity they
  // cannot see is linked to.
  const deleteScope = await loadEntityScope(admin, writeCheck)
  if (!deleteScope.access.vehicles.all) {
    const { data: links } = await (admin as any).from('company_vehicles').select('vehicle_id').eq('company_id', company.id)
    if (((links as any[]) ?? []).some(l => !canSeeVehicle(deleteScope.access, l.vehicle_id))) {
      return NextResponse.json({ error: 'Another entity also holds this company. Ask an admin to remove it.' }, { status: 403 })
    }
  }

  // Each investment deletion retracts its mirrored journal entries and refuses closed periods.
  // Cascading the company row would bypass that accounting safeguard, so require the operator to
  // remove investment history through its own UI first.
  const { count: investmentCount, error: investmentError } = await admin
    .from('investment_transactions' as any)
    .select('id', { count: 'exact', head: true })
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id)

  if (investmentError) return dbError(investmentError, 'companies-id-delete-investments')
  if ((investmentCount ?? 0) > 0) {
    return NextResponse.json({
      error: `Delete this company's ${investmentCount} investment transaction${investmentCount === 1 ? '' : 's'} first so its accounting entries can be retracted safely.`,
    }, { status: 409 })
  }

  // Refuse to orphan any company-specific chart accounts that still carry postings, including
  // positions bootstrapped directly into the ledger rather than mirrored from the tracker.
  const { data: accountRows, error: accountError } = await admin
    .from('chart_of_accounts' as any)
    .select('id')
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id) as {
      data: { id: string }[] | null
      error: { message: string } | null
    }
  if (accountError) return dbError(accountError, 'companies-id-delete-accounts')

  const accountIds = (accountRows ?? []).map(account => account.id)
  if (accountIds.length > 0) {
    // A posting in ANY book pins the account — tax adjustments included.
    const { count: postingCount, error: postingError } = await admin
      .from('journal_postings' as any)
      .select('id', { count: 'exact', head: true })
      .in('book', LEDGER_BOOKS)
      .eq('fund_id', company.fund_id)
      .in('account_id', accountIds)
    if (postingError) return dbError(postingError, 'companies-id-delete-postings')
    if ((postingCount ?? 0) > 0) {
      return NextResponse.json({
        error: `This company's accounts still carry ${postingCount} ledger posting${postingCount === 1 ? '' : 's'}. Reverse those entries before deleting the company.`,
      }, { status: 409 })
    }
  }

  // Capture uploaded-file paths before their rows cascade. The database delete is authoritative;
  // storage cleanup follows it so a transient storage failure can never leave live rows pointing
  // at files that have already disappeared.
  const { data: documentRows, error: documentError } = await admin
    .from('company_documents' as any)
    .select('storage_path')
    .eq('company_id', company.id)
    .eq('fund_id', company.fund_id) as {
      data: { storage_path: string | null }[] | null
      error: { message: string } | null
    }
  if (documentError) return dbError(documentError, 'companies-id-delete-documents')
  const storagePaths = (documentRows ?? [])
    .map(document => document.storage_path)
    .filter((path): path is string => Boolean(path))

  const { error: deleteError } = await admin
    .from('companies' as any)
    .delete()
    .eq('id', company.id)
    .eq('fund_id', company.fund_id)
  if (deleteError) return dbError(deleteError, 'companies-id-delete')

  // ON DELETE SET NULL leaves these empty per-company accounts ready for explicit cleanup.
  if (accountIds.length > 0) {
    const { error: accountDeleteError } = await admin
      .from('chart_of_accounts' as any)
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

  logActivity(admin, company.fund_id, user.id, 'company.delete', {
    companyId: company.id,
    companyName: company.name,
  })

  return NextResponse.json({ ok: true })
}
