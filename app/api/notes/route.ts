import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

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

  const filter = req.nextUrl.searchParams.get('filter')

  let query = admin
    .from('company_notes')
    .select('id, content, user_id, company_id, mentioned_user_ids, mentioned_company_ids, mentioned_groups, created_at, updated_at, pinned_at, page_context')
    .eq('fund_id', membership.fund_id)
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(200)

  // Fund-wide notes, and notes about companies the caller can see.
  const scope = await loadEntityScopeForUser(admin, user.id)
  query = filterByCompany(query, scope ? scope.companyIds : [], { keepUnlinked: true })

  if (filter === 'general') {
    query = query.is('company_id', null)
  } else if (filter === 'mentions') {
    query = query.contains('mentioned_user_ids', [user.id])
  }

  const { data: notes, error } = await query as {
    data: { id: string; content: string; user_id: string; company_id: string | null; mentioned_user_ids: string[] | null; created_at: string; updated_at: string }[] | null
    error: { message: string } | null
  }

  if (error) return dbError(error, 'notes')

  // Batch-load read status
  const noteIds = (notes ?? []).map(n => n.id)
  const readSet = new Set<string>()
  if (noteIds.length > 0) {
    const { data: reads } = await admin
      .from('note_reads' as any)
      .select('note_id')
      .eq('user_id', user.id)
      .in('note_id', noteIds) as { data: { note_id: string }[] | null }
    for (const r of reads ?? []) readSet.add(r.note_id)
  }

  // Batch-load display names
  const { data: members } = await admin
    .from('fund_members')
    .select('user_id, display_name')
    .eq('fund_id', membership.fund_id) as { data: { user_id: string; display_name: string | null }[] | null }

  const nameMap: Record<string, string | null> = {}
  for (const m of members ?? []) {
    nameMap[m.user_id] = m.display_name
  }

  // Batch-load company names
  const companyIds = Array.from(new Set((notes ?? []).map(n => n.company_id).filter(Boolean))) as string[]
  const companyNameMap: Record<string, string> = {}
  if (companyIds.length > 0) {
    const { data: companies } = await admin
      .from('companies')
      .select('id, name')
      .in('id', companyIds) as { data: { id: string; name: string }[] | null }
    for (const c of companies ?? []) {
      companyNameMap[c.id] = c.name
    }
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
      companyId: note.company_id,
      companyName: note.company_id ? companyNameMap[note.company_id] ?? null : null,
      mentionedUserIds: note.mentioned_user_ids ?? [],
      mentionedCompanyIds: (note as any).mentioned_company_ids ?? [],
      mentionedGroups: (note as any).mentioned_groups ?? [],
      isRead: note.user_id === user.id || readSet.has(note.id),
      createdAt: note.created_at,
      edited: note.updated_at !== note.created_at,
      pinnedAt: (note as any).pinned_at ?? null,
      pageContext: (note as any).page_context ?? null,
    })
  }

  return NextResponse.json(result)
}
