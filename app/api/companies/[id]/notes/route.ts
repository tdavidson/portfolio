import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { parseMentions, parseCompanyMentions, parseGroupMentions } from '@/lib/notes/mentions'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'
import { resolveNoteEntity, scopeNotesQuery } from '@/lib/notes/entity'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // Verify company exists and user has access
  const { data: company } = await supabase
    .from('companies')
    .select('id, fund_id')
    .eq('id', params.id)
    .maybeSingle() as { data: { id: string; fund_id: string } | null }

  if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Fetch notes directly on this company OR mentioning it via @tag — either way only notes the
  // caller may read (their entity's, and about a company of theirs): a note about ANOTHER company
  // that @mentions this one is that note's entity's, not this page's.
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (!scope) return NextResponse.json([])
  const { data: directNotes, error: directError } = await scopeNotesQuery(admin
    .from('company_notes')
    .select('*')
    .eq('company_id', params.id), scope)
    .order('created_at', { ascending: true }) as { data: { id: string; content: string; user_id: string; company_id: string | null; mentioned_user_ids: string[] | null; created_at: string; updated_at: string }[] | null; error: { message: string } | null }

  if (directError) return dbError(directError, 'companies-id-notes')

  const { data: taggedNotes } = await scopeNotesQuery(admin
    .from('company_notes')
    .select('*')
    .eq('fund_id', company.fund_id)
    .contains('mentioned_company_ids' as any, [params.id]), scope)
    .order('created_at', { ascending: true }) as { data: { id: string; content: string; user_id: string; company_id: string | null; mentioned_user_ids: string[] | null; created_at: string; updated_at: string }[] | null }

  // Merge and deduplicate
  const seenIds = new Set<string>()
  const notes: typeof directNotes = []
  for (const n of [...(directNotes ?? []), ...(taggedNotes ?? [])]) {
    if (!seenIds.has(n.id)) {
      seenIds.add(n.id)
      notes.push(n)
    }
  }
  notes.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  // Batch-load read status for current user
  const noteIds = (notes ?? []).map(n => n.id)
  const readSet = new Set<string>()
  if (noteIds.length > 0) {
    const { data: reads } = await supabase
      .from('note_reads' as any)
      .select('note_id')
      .eq('user_id', user.id)
      .in('note_id', noteIds) as { data: { note_id: string }[] | null }
    for (const r of reads ?? []) readSet.add(r.note_id)
  }

  // Batch-load display names for all note authors
  const { data: members } = await admin
    .from('fund_members')
    .select('user_id, display_name')
    .eq('fund_id', company.fund_id) as { data: { user_id: string; display_name: string | null }[] | null }
  const nameMap: Record<string, string | null> = {}
  for (const m of members ?? []) {
    nameMap[m.user_id] = m.display_name
  }

  // Look up user emails
  const result = []
  const emailCache: Record<string, string> = {}
  for (const note of notes ?? []) {
    if (!emailCache[note.user_id]) {
      const { data: { user: noteUser } } = await admin.auth.admin.getUserById(note.user_id)
      emailCache[note.user_id] = noteUser?.email ?? 'Unknown'
    }
    result.push({
      id: note.id,
      content: note.content,
      userId: note.user_id,
      userName: nameMap[note.user_id] || null,
      userEmail: emailCache[note.user_id],
      mentionedUserIds: note.mentioned_user_ids ?? [],
      vehicleId: (note as any).vehicle_id ?? null,
      isRead: note.user_id === user.id || readSet.has(note.id),
      createdAt: note.created_at,
      edited: note.updated_at !== note.created_at,
    })
  }

  return NextResponse.json(result)
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { content, vehicleId: requestedVehicle } = body

  if (!content?.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 })
  }

  // Get the company's fund_id
  const { data: company } = await supabase
    .from('companies')
    .select('fund_id, name')
    .eq('id', params.id)
    .maybeSingle() as { data: { fund_id: string; name: string } | null }

  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  // Every note is for one of the writer's entities that holds this company.
  const noteScope = await loadEntityScopeForUser(admin, user.id)
  if (!noteScope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const entity = await resolveNoteEntity(admin, noteScope, params.id, requestedVehicle)
  if ('error' in entity) return NextResponse.json({ error: entity.error, code: 'ENTITY_REQUIRED' }, { status: entity.status })

  // Parse @mentions for people
  const { data: members } = await admin
    .from('fund_members')
    .select('user_id, display_name')
    .eq('fund_id', company.fund_id) as { data: { user_id: string; display_name: string | null }[] | null }

  // Resolve emails for members without display names
  const membersWithFallback = await Promise.all(
    (members ?? []).map(async (m) => {
      if (m.display_name?.trim()) return m
      const { data: { user: u } } = await admin.auth.admin.getUserById(m.user_id)
      return { ...m, email: u?.email }
    })
  )

  const mentionedUserIds = parseMentions(content.trim(), membersWithFallback)

  // Parse @mentions for companies — only the writer's can be tagged.
  const { data: allCompanies } = await filterByCompany(admin
    .from('companies')
    .select('id, name')
    .eq('fund_id', company.fund_id), noteScope.companyIds, { column: 'id' }) as { data: { id: string; name: string }[] | null }

  const mentionedCompanyIds = parseCompanyMentions(content.trim(), allCompanies ?? [])

  const { data: note, error } = await supabase
    .from('company_notes')
    .insert({
      company_id: params.id,
      vehicle_id: entity.vehicleId,
      fund_id: company.fund_id,
      user_id: user.id,
      content: content.trim(),
      mentioned_user_ids: mentionedUserIds,
      mentioned_company_ids: mentionedCompanyIds,
    } as any)
    .select('id, content, user_id, created_at')
    .single() as { data: { id: string; content: string; user_id: string; created_at: string } | null; error: { message: string } | null }

  if (error || !note) return dbError(error ?? { message: 'Failed to create note' }, 'company-notes')

  // Look up current user's display name
  const { data: membership } = await admin
    .from('fund_members')
    .select('display_name')
    .eq('fund_id', company.fund_id)
    .eq('user_id', user.id)
    .maybeSingle() as { data: { display_name: string | null } | null }

  // Fire-and-forget notification
  sendNoteNotificationsAsync(admin, company.fund_id, {
    id: note.id,
    content: note.content,
    companyId: params.id,
    companyName: company.name,
    vehicleId: entity.vehicleId,
    authorName: membership?.display_name || user.email?.split('@')[0] || 'Someone',
    authorUserId: user.id,
    mentionedUserIds,
  })

  return NextResponse.json({
    id: note.id,
    content: note.content,
    userId: note.user_id,
    userName: membership?.display_name || null,
    userEmail: user.email ?? 'Unknown',
    mentionedUserIds,
    vehicleId: entity.vehicleId,
    isRead: true,
    createdAt: note.created_at,
    edited: false,
  })
}

// Fire-and-forget wrapper to avoid blocking the response
async function sendNoteNotificationsAsync(...args: Parameters<typeof import('@/lib/notes/notify').sendNoteNotifications>) {
  try {
    const { sendNoteNotifications } = await import('@/lib/notes/notify')
    await sendNoteNotifications(...args)
  } catch (err) {
    console.error('[notes] Failed to send notifications:', err)
  }
}
