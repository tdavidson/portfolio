import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows, groupWriteDenial } from '@/lib/access/scope'

// ---------------------------------------------------------------------------
// GET — get all fund group configs for this fund
// ---------------------------------------------------------------------------

export async function GET() {
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

  const { data, error } = await admin
    .from('fund_group_config' as any)
    .select('*')
    .eq('fund_id', membership.fund_id) as { data: any[] | null; error: { message: string } | null }

  if (error) return dbError(error, 'fund-group-config')

  // Only the caller's entities' settings.
  const scope = await loadEntityScopeForUser(admin, user.id)
  return NextResponse.json(scopeCompanyRows(data ?? [], (scope ? scope.vehicleNames : []), 'portfolio_group'))
}

// ---------------------------------------------------------------------------
// PUT — upsert group config (cash_on_hand, carry_rate, gp_commit_pct)
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json()
  const { portfolioGroup, cashOnHand, carryRate, gpCommitPct, vintage } = body

  if (!portfolioGroup) {
    return NextResponse.json({ error: 'portfolioGroup is required' }, { status: 400 })
  }
  const writeScope = await loadEntityScopeForUser(admin, user.id)
  const denied = groupWriteDenial((writeScope ? writeScope.vehicleNames : []), portfolioGroup)
  if (denied) return NextResponse.json({ error: denied }, { status: 403 })

  const row: Record<string, any> = {
    fund_id: membership.fund_id,
    portfolio_group: portfolioGroup,
    updated_at: new Date().toISOString(),
  }
  if (cashOnHand !== undefined) {
    const v = parseFloat(cashOnHand ?? 0)
    row.cash_on_hand = isNaN(v) ? 0 : v
  }
  if (carryRate !== undefined) {
    const v = parseFloat(carryRate ?? 0.2)
    row.carry_rate = isNaN(v) ? 0.2 : v
  }
  if (gpCommitPct !== undefined) {
    const v = parseFloat(gpCommitPct ?? 0)
    row.gp_commit_pct = isNaN(v) ? 0 : v
  }
  if (vintage !== undefined) {
    row.vintage = vintage ? parseInt(vintage, 10) : null
  }

  const { data, error } = await admin
    .from('fund_group_config' as any)
    .upsert(row, { onConflict: 'fund_id,portfolio_group' })
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'fund-group-config-upsert')

  return NextResponse.json(data)
}
