import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'

async function verifyOwnership(
  admin: ReturnType<typeof createAdminClient>,
  valueId: string,
  userId: string
) {
  const { data: mv } = await admin
    .from('metric_values')
    .select('id, fund_id, company_id')
    .eq('id', valueId)
    .maybeSingle()

  if (!mv) return null

  // Only a value for a company one of the caller's entities holds.
  const scope = await loadEntityScopeForUser(admin, userId)
  const visible = scope ? scope.companyIds : []
  if (visible !== null && !visible.includes((mv as any).company_id)) return null

  const { data: membership } = await admin
    .from('fund_members')
    .select('id')
    .eq('fund_id', mv.fund_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!membership) return null
  return mv
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const mv = await verifyOwnership(admin, params.id, user.id)
  if (!mv) return NextResponse.json({ error: 'Not found or forbidden' }, { status: 404 })

  const body = await req.json()
  const updates: Record<string, unknown> = {}

  if (body.value_number !== undefined) updates.value_number = body.value_number
  if (body.value_text !== undefined) updates.value_text = body.value_text
  if (body.period_label !== undefined) updates.period_label = body.period_label
  if (body.period_year !== undefined) updates.period_year = body.period_year
  if (body.period_quarter !== undefined) updates.period_quarter = body.period_quarter
  if (body.period_month !== undefined) updates.period_month = body.period_month
  if (body.notes !== undefined) updates.notes = body.notes

  const { data, error } = await admin
    .from('metric_values')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return dbError(error, 'metric-values')

  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const mv = await verifyOwnership(admin, params.id, user.id)
  if (!mv) return NextResponse.json({ error: 'Not found or forbidden' }, { status: 404 })

  const { error } = await admin
    .from('metric_values')
    .delete()
    .eq('id', params.id)

  if (error) return dbError(error, 'metric-values')

  return NextResponse.json({ ok: true })
}
