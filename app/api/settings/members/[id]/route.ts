import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { sendApprovalEmail } from '@/lib/email'
import { dbError } from '@/lib/api-error'

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

  const { action } = await req.json()
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
    // Add as fund member
    const { error: memberError } = await admin
      .from('fund_members')
      .insert({
        fund_id: request.fund_id,
        user_id: request.user_id,
        invited_by: user.id,
        role: 'member',
      })

    if (memberError) {
      return dbError(memberError, 'settings-members')
    }
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

  // Get the member to remove — must be in the same fund
  const { data: target } = await admin
    .from('fund_members')
    .select('id, user_id, role')
    .eq('id', params.id)
    .eq('fund_id', membership.fund_id)
    .single()

  if (!target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  // Prevent removing yourself
  if (target.user_id === user.id) {
    return NextResponse.json({ error: 'You cannot remove yourself' }, { status: 400 })
  }

  // Prevent removing other admins
  if (target.role === 'admin') {
    return NextResponse.json({ error: 'Cannot remove an admin' }, { status: 400 })
  }

  const { error } = await admin
    .from('fund_members')
    .delete()
    .eq('id', params.id)

  if (error) {
    return dbError(error, 'settings-members')
  }

  // Their entity grants go with the membership: someone re-added later starts with none, rather
  // than quietly regaining entities an admin granted them before.
  await (admin as any).from('fund_member_vehicles').delete()
    .eq('fund_id', membership.fund_id).eq('user_id', target.user_id)

  expireTag('membership')

  return NextResponse.json({ ok: true })
}
