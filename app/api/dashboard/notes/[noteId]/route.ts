import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { resolveNoteEntity } from '@/lib/notes/entity'

export async function PATCH(req: NextRequest, props: { params: Promise<{ noteId: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { content, pinned, vehicleId } = body

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const { data: note } = await admin
    .from('company_notes')
    .select('id, user_id, fund_id, company_id')
    .eq('id', params.noteId)
    .eq('fund_id', membership.fund_id)
    .maybeSingle() as { data: { id: string; user_id: string; fund_id: string; company_id: string | null } | null }

  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Which entity the note is for — how an unattributed legacy note gets one, or a note moves to
  // the right team. Its author, or an unscoped user; the new entity must be one the note may be for.
  if (typeof vehicleId === 'string') {
    const scope = await loadEntityScopeForUser(admin, user.id)
    if (!scope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
    if (note.user_id !== user.id && !scope.access.vehicles.all) {
      return NextResponse.json({ error: 'Only the author or an admin can move a note' }, { status: 403 })
    }
    const entity = await resolveNoteEntity(admin, scope, note.company_id, vehicleId)
    if ('error' in entity) return NextResponse.json({ error: entity.error }, { status: entity.status })
    const { error } = await (admin as any).from('company_notes').update({ vehicle_id: entity.vehicleId }).eq('id', params.noteId)
    if (error) return dbError(error, 'dashboard-notes')
    expireTag('notes-badge')
    return NextResponse.json({ id: params.noteId, vehicleId: entity.vehicleId })
  }

  // Pin/unpin: any fund member can do this
  if (typeof pinned === 'boolean') {
    const { data: updated, error } = await admin
      .from('company_notes')
      .update({ pinned_at: pinned ? new Date().toISOString() : null } as any)
      .eq('id', params.noteId)
      .select('id, pinned_at')
      .single() as { data: { id: string; pinned_at: string | null } | null; error: { message: string } | null }

    if (error || !updated) return dbError(error ?? { message: 'Failed to update' }, 'dashboard-notes')

    expireTag('notes-badge')
    return NextResponse.json({ id: updated.id, pinnedAt: updated.pinned_at })
  }

  // Content edit: only the author
  if (!content?.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 })
  }

  if (note.user_id !== user.id) {
    return NextResponse.json({ error: 'You can only edit your own notes' }, { status: 403 })
  }

  const { data: updated, error } = await admin
    .from('company_notes')
    .update({ content: content.trim(), updated_at: new Date().toISOString() })
    .eq('id', params.noteId)
    .select('id, content, user_id, created_at, updated_at')
    .single() as { data: { id: string; content: string; user_id: string; created_at: string; updated_at: string } | null; error: { message: string } | null }

  if (error || !updated) return dbError(error ?? { message: 'Failed to update' }, 'dashboard-notes')

  const { data: memberInfo } = await admin
    .from('fund_members')
    .select('display_name')
    .eq('fund_id', note.fund_id)
    .eq('user_id', user.id)
    .maybeSingle() as { data: { display_name: string | null } | null }

  expireTag('notes-badge')

  return NextResponse.json({
    id: updated.id,
    content: updated.content,
    userId: updated.user_id,
    userName: memberInfo?.display_name || null,
    userEmail: user.email ?? 'Unknown',
    createdAt: updated.created_at,
    edited: updated.updated_at !== updated.created_at,
  })
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ noteId: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle() as { data: { fund_id: string; role: string } | null }

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const { data: note } = await admin
    .from('company_notes')
    .select('id, user_id')
    .eq('id', params.noteId)
    .eq('fund_id', membership.fund_id)
    .maybeSingle() as { data: { id: string; user_id: string } | null }

  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (note.user_id !== user.id && membership.role !== 'admin') {
    return NextResponse.json({ error: 'Only the author or an admin can delete this note' }, { status: 403 })
  }

  const { error } = await admin
    .from('company_notes')
    .delete()
    .eq('id', params.noteId)

  if (error) return dbError(error, 'dashboard-notes-noteId')

  expireTag('notes-badge')

  return NextResponse.json({ success: true })
}
