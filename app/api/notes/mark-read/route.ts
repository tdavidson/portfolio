import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeNotesQuery } from '@/lib/notes/entity'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { noteIds } = body as { noteIds: string[] }

  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return NextResponse.json({ error: 'noteIds required' }, { status: 400 })
  }

  // Cap at 500 to prevent abuse
  const ids = noteIds.slice(0, 500)

  const admin = createAdminClient()

  // Get user's fund
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  // Validate note IDs belong to the user's fund
  // …and to notes the caller can read (the note rule: lib/notes/entity.ts).
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope) return NextResponse.json({ ok: true })
  const { data: validNotes } = await scopeNotesQuery((admin as any)
    .from('company_notes')
    .select('id')
    .in('id', ids)
    .eq('fund_id', membership.fund_id), scope) as { data: { id: string }[] | null }

  const validIds = new Set((validNotes ?? []).map(n => n.id))

  // Upsert read receipts — ignore conflicts (already read)
  const rows = ids
    .filter(id => validIds.has(id))
    .map(noteId => ({
      user_id: user.id,
      note_id: noteId,
    }))

  await admin
    .from('note_reads' as any)
    .upsert(rows, { onConflict: 'user_id,note_id', ignoreDuplicates: true })

  expireTag('notes-badge')

  return NextResponse.json({ ok: true })
}
