import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import type { CompanyStatus } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { loadEntityScope, loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { mergeGroupsForWrite, scopeGroups } from '@/lib/access/scope'
import { deleteCompany } from '@/lib/companies/delete'
import { outcomeResponse } from '@/lib/service-outcome'

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

  // The checks and the delete are lib/companies/delete.ts, shared with the delete_company tool.
  return outcomeResponse(
    await deleteCompany(admin, { fundId: writeCheck.fundId, userId: user.id }, params.id, () => loadEntityScope(admin, writeCheck)),
    () => ({ ok: true }),
  )
}
