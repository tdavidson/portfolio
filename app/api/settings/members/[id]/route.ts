import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { sendApprovalEmail } from '@/lib/email'
import { dbError } from '@/lib/api-error'
import { parseApprovalEntities } from '@/lib/access/entity-grants'
import { logActivity } from '@/lib/activity'
import { removeMember } from '@/lib/access/remove-member'
import { outcomeResponse } from '@/lib/service-outcome'

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Verify user is an admin of their fund
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || membership.role !== 'admin') {
    return NextResponse.json({ error: 'Only fund administrators can manage members' }, { status: 403 })
  }

  const { action, entities } = await req.json()
  if (!['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  // Get the join request
  const { data: request } = await admin
    .from('fund_join_requests')
    .select('id, fund_id, user_id, email, status, funds(name)')
    .eq('id', params.id)
    .eq('fund_id', membership.fund_id)
    .eq('status', 'pending')
    .single()

  if (!request) {
    return NextResponse.json({ error: 'Join request not found' }, { status: 404 })
  }

  if (action === 'approve') {
    // Approving chooses what they see: All entities, or some of the fund's. A member approved with
    // nothing would land on empty pages with buttons that fail.
    const { data: fundVehicles } = await admin.from('fund_vehicles' as any).select('id').eq('fund_id', request.fund_id)
    const choice = parseApprovalEntities(entities, ((fundVehicles as any[]) ?? []).map(v => v.id as string))
    if ('error' in choice) return NextResponse.json({ error: choice.error }, { status: 400 })

    // Add as fund member
    const { error: memberError } = await admin
      .from('fund_members')
      .insert({
        fund_id: request.fund_id,
        user_id: request.user_id,
        invited_by: user.id,
        role: 'member',
        all_entities: choice.all,
      } as any)
    if (memberError) {
      return dbError(memberError, 'settings-members')
    }
    if (choice.ids.length > 0) {
      const { error: grantError } = await admin.from('fund_member_vehicles' as any).insert(
        choice.ids.map(id => ({ fund_id: request.fund_id, user_id: request.user_id, vehicle_id: id, granted_by: user.id })))
      if (grantError) return dbError(grantError, 'settings-members-entities')
    }
    logActivity(admin, request.fund_id, user.id, 'access.member_approved', { member: request.user_id, allEntities: choice.all, vehicleIds: choice.ids })
  }

  // Update the request status
  const { error: updateError } = await admin
    .from('fund_join_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: user.id,
    })
    .eq('id', params.id)

  if (updateError) {
    return dbError(updateError, 'settings-members')
  }

  // Send approval notification email (fire-and-forget)
  if (action === 'approve' && request.email) {
    const fundName = (request as any).funds?.name || 'your fund'
    sendApprovalEmail(admin, request.fund_id, request.email, fundName).catch(() => {})
  }

  expireTag('pending-requests')
  expireTag('membership')

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Verify user is an admin of their fund
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || membership.role !== 'admin') {
    return NextResponse.json({ error: 'Only fund administrators can remove members' }, { status: 403 })
  }

  // Not yourself, not another admin: lib/access/remove-member.ts, shared with the remove_member tool.
  return outcomeResponse(await removeMember(admin, { fundId: membership.fund_id, userId: user.id }, params.id), () => ({ ok: true }))
}
