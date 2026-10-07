import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { visibleVehicleIds } from '@/lib/access/scope'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const status = req.nextUrl.searchParams.get('status')          // comma-separated, e.g. "new,reviewing"
  const fitScore = req.nextUrl.searchParams.get('fit_score')      // strong | moderate | weak | out_of_thesis | spam
  const introSource = req.nextUrl.searchParams.get('intro_source')
  const search = req.nextUrl.searchParams.get('q')                // company or founder name
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '100', 10), 500)

  const scope = await loadEntityScopeForUser(admin, user.id)
  // Untyped: the column list is built at runtime, and typing it sends inference past its limit.
  let query = (admin as any)
    .from('inbound_deals')
    // vehicle_id exists only once the entity-access migration has run; before it, asking fails.
    .select(`id, fund_id, ${scope?.access.vehicles.enforced ? 'vehicle_id, ' : ''}email_id, company_name, company_url, company_domain, founder_name, founder_email, intro_source, referrer_name, thesis_fit_score, stage, industry, raise_amount, status, prior_deal_id, created_at`)
    .eq('fund_id', membership.fund_id)
    .order('created_at', { ascending: false })
    .limit(limit)

  // Only deals owned by the caller's entities. Unassigned deals (the email pipeline does not know
  // which entity a pitch is for) are for admins to triage and assign.
  const vehicleIds = scope ? visibleVehicleIds(scope.access) : []
  if (vehicleIds !== null) query = query.in('vehicle_id', vehicleIds)

  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length) query = query.in('status', statuses)
  }

  if (fitScore) query = query.eq('thesis_fit_score', fitScore)
  if (introSource) query = query.eq('intro_source', introSource)
  if (search) {
    // Neutralize PostgREST filter-string delimiters first (a `,` `(` `)` `:` or
    // backslash would otherwise be parsed as extra .or() clauses), then escape
    // LIKE wildcards in the remaining literal search text.
    const escaped = search.replace(/[,()*:".\\]/g, ' ').replace(/[%_]/g, '\\$&')
    query = query.or(`company_name.ilike.%${escaped}%,founder_name.ilike.%${escaped}%,founder_email.ilike.%${escaped}%`)
  }

  const { data, error } = await query
  if (error) return dbError(error, 'deals')

  return NextResponse.json(data ?? [])
}
