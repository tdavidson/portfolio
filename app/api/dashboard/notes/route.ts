import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { parseMentions, parseCompanyMentions, parseGroupMentions } from '@/lib/notes/mentions'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows } from '@/lib/access/scope'

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
  const pageContext = req.nextUrl.searchParams.get('page_context')
  const limitParam = req.nextUrl.searchParams.get('limit')

  let query = admin
    .from('company_notes')
    .select('id, content, user_id, company_id, mentioned_user_ids, mentioned_company_ids, mentioned_groups, created_at, updated_at, pinned_at, page_context')
    .eq('fund_id', membership.fund_id)

  if (pageContext) {
    query = query.eq('page_context', pageContext).is('company_id', null)
  } else if (filter === 'general') {
    query = query.is('company_id', null)
  }

  if (limitParam) {
    const n = Math.min(parseInt(limitParam, 10) || 10, 200)
    query = query.order('created_at', { ascending: false }).limit(n)
  } else {
    query = query.order('created_at', { ascending: true })
  }

  let { data: notes, error } = await query as {
    data: { id: string; content: string; user_id: string; company_id: string | null; mentioned_user_ids: string[] | null; created_at: string; updated_at: string }[] | null
    error: { message: string } | null
  }

  if (error) return dbError(error, 'dashboard-notes')

  // Notes about a company the caller cannot see are not theirs to read. Fund-wide notes (no company)
  // stay visible; @mentions of an invisible company are dropped from the names map below.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const visibleCompanies = (scope ? scope.companyIds : [])
  notes = scopeCompanyRows(notes ?? [], visibleCompanies, 'company_id', { keepUnlinked: true })

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

  // Batch-load company names for tagged notes (both direct and @mentioned)
  const allMentionedCompanyIds = (Array.from(new Set(
    (notes ?? []).flatMap(n => [...(n.company_id ? [n.company_id] : []), ...((n as any).mentioned_company_ids ?? [])])
  )) as string[]).filter(id => visibleCompanies === null || visibleCompanies.includes(id))
  const companyNameMap: Record<string, string> = {}
  if (allMentionedCompanyIds.length > 0) {
    const { data: companies } = await admin
      .from('companies')
      .select('id, name')
      .in('id', allMentionedCompanyIds) as { data: { id: string; name: string }[] | null }
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

  // When limit is used, we fetched DESC; reverse to chronological for chat display
  if (limitParam) result.reverse()

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, display_name')
    .eq('user_id', user.id)
    .maybeSingle() as { data: { fund_id: string; display_name: string | null } | null }

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json()
  const { content, companyId, pageContext } = body

  if (!content?.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 })
  }

  // If companyId provided, verify it belongs to this fund
  let companyName: string | null = null
  if (companyId) {
    const { data: company } = await admin
      .from('companies')
      .select('id, name, fund_id')
      .eq('id', companyId)
      .eq('fund_id', membership.fund_id)
      .maybeSingle() as { data: { id: string; name: string; fund_id: string } | null }

    // Only about a company the caller can see — a write here would otherwise also confirm that an
    // invisible company exists.
    const noteScope = await loadEntityScopeForUser(admin, user.id)
    const visible = noteScope ? noteScope.companyIds : []
    if (!company || (visible !== null && !visible.includes(company.id))) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }
    companyName = company.name
  }

  // Parse @mentions for people
  const { data: members } = await admin
    .from('fund_members')
    .select('user_id, display_name')
    .eq('fund_id', membership.fund_id) as { data: { user_id: string; display_name: string | null }[] | null }

  // Resolve emails for members without display names
  const membersWithFallback = await Promise.all(
    (members ?? []).map(async (m) => {
      if (m.display_name?.trim()) return m
      const { data: { user: u } } = await admin.auth.admin.getUserById(m.user_id)
      return { ...m, email: u?.email }
    })
  )

  const mentionedUserIds = parseMentions(content.trim(), membersWithFallback)

  // Parse @mentions for companies
  const { data: allCompanies } = await admin
    .from('companies')
    .select('id, name')
    .eq('fund_id', membership.fund_id)
    // fund holdings have their own surfaces
    .eq('holding_type', 'company') as { data: { id: string; name: string }[] | null }

  const mentionedCompanyIds = parseCompanyMentions(content.trim(), allCompanies ?? [])

  // Parse @mentions for portfolio groups
  const distinctGroups = Array.from(new Set(
    (allCompanies ?? [])
      .flatMap((c: any) => Array.isArray(c.portfolio_group) ? c.portfolio_group : c.portfolio_group ? [c.portfolio_group] : [])
  ))
  const mentionedGroups = parseGroupMentions(content.trim(), distinctGroups)

  const { data: note, error } = await admin
    .from('company_notes')
    .insert({
      company_id: companyId || null,
      fund_id: membership.fund_id,
      user_id: user.id,
      content: content.trim(),
      mentioned_user_ids: mentionedUserIds,
      mentioned_company_ids: mentionedCompanyIds,
      mentioned_groups: mentionedGroups,
      page_context: pageContext || null,
    } as any)
    .select('id, content, user_id, company_id, created_at, page_context')
    .single() as { data: { id: string; content: string; user_id: string; company_id: string | null; created_at: string; page_context: string | null } | null; error: { message: string } | null }

  if (error || !note) return dbError(error ?? { message: 'Failed to create note' }, 'dashboard-notes')

  logActivity(admin, membership.fund_id, user.id, 'note.create', {})

  expireTag('notes-badge')

  // Fire-and-forget notification
  sendNoteNotificationsAsync(admin, membership.fund_id, {
    id: note.id,
    content: note.content,
    companyId: companyId || null,
    companyName,
    authorName: membership.display_name || user.email?.split('@')[0] || 'Someone',
    authorUserId: user.id,
    mentionedUserIds,
  })

  return NextResponse.json({
    id: note.id,
    content: note.content,
    userId: note.user_id,
    userName: membership.display_name || null,
    userEmail: user.email ?? 'Unknown',
    companyId: note.company_id,
    companyName,
    mentionedUserIds,
    mentionedCompanyIds,
    mentionedGroups,
    isRead: true,
    createdAt: note.created_at,
    edited: false,
    pinnedAt: null,
    pageContext: note.page_context ?? null,
  })
}

async function sendNoteNotificationsAsync(...args: Parameters<typeof import('@/lib/notes/notify').sendNoteNotifications>) {
  try {
    const { sendNoteNotifications } = await import('@/lib/notes/notify')
    await sendNoteNotifications(...args)
  } catch (err) {
    console.error('[notes] Failed to send notifications:', err)
  }
}
