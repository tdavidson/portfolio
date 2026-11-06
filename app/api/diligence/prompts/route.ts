import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'

const STAGES = ['ingest', 'research', 'qa', 'draft', 'score', 'render'] as const
type Stage = typeof STAGES[number]

/**
 * Per-stage editable prompt guidance. Open to all fund members — diligence
 * settings are not admin-gated.
 *
 * GET   → { guidance: { [stage]: string } } for every stage (empty if unset)
 * PATCH → { guidance: { [stage]: string } } upserts the provided stages
 */
export async function GET() {
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data } = await (admin as any)
    .from('memo_agent_prompts')
    .select('stage, guidance')
    .eq('fund_id', fundId)

  const guidance: Record<string, string> = {}
  for (const s of STAGES) guidance[s] = ''
  for (const row of (data ?? []) as Array<{ stage: string; guidance: string }>) {
    if (row.stage in guidance) guidance[row.stage] = row.guidance ?? ''
  }

  // First-page exemplar (Phase 3) + the fund's sample memos to choose from.
  const [{ data: settings }, { data: anchorRows }] = await Promise.all([
    (admin as any).from('fund_settings').select('memo_first_page_anchor_id, memo_design_anchor_id').eq('fund_id', fundId).maybeSingle(),
    admin.from('style_anchor_memos').select('id, title, file_name, file_format').eq('fund_id', fundId).order('uploaded_at', { ascending: false }),
  ])

  return NextResponse.json({
    guidance,
    first_page_anchor_id: (settings as any)?.memo_first_page_anchor_id ?? null,
    design_anchor_id: (settings as any)?.memo_design_anchor_id ?? null,
    anchors: ((anchorRows ?? []) as Array<{ id: string; title: string | null; file_name: string; file_format: string | null }>)
      .map(a => ({ id: a.id, label: a.title || a.file_name, file_name: a.file_name, file_format: a.file_format })),
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const body = await req.json().catch(() => ({}))

  // First-page exemplar (Phase 3).
  if ('first_page_anchor_id' in body) {
    const id = typeof body.first_page_anchor_id === 'string' && body.first_page_anchor_id ? body.first_page_anchor_id : null
    const { error: setErr } = await admin
      .from('fund_settings')
      .update({ memo_first_page_anchor_id: id } as any)
      .eq('fund_id', fundId)
    if (setErr) return dbError(setErr, 'diligence-prompts-anchor')
  }

  // Design template: the sample memo whose Word file every export is written into.
  if ('design_anchor_id' in body) {
    const id = typeof body.design_anchor_id === 'string' && body.design_anchor_id ? body.design_anchor_id : null
    if (id) {
      const { data: anchor } = await admin.from('style_anchor_memos').select('id').eq('fund_id', fundId).eq('id', id).maybeSingle()
      if (!anchor) return NextResponse.json({ error: 'That sample memo is not in this fund.' }, { status: 400 })
    }
    const { error: setErr } = await (admin as any)
      .from('fund_settings')
      .update({ memo_design_anchor_id: id })
      .eq('fund_id', fundId)
    if (setErr) return dbError(setErr, 'diligence-prompts-design')
  }

  const incoming = body?.guidance
  if (incoming && typeof incoming === 'object') {
    const rows: Array<{ fund_id: string; stage: Stage; guidance: string; updated_at: string }> = []
    for (const [stage, value] of Object.entries(incoming)) {
      if (!STAGES.includes(stage as Stage)) continue
      if (typeof value !== 'string') continue
      rows.push({ fund_id: fundId, stage: stage as Stage, guidance: value, updated_at: new Date().toISOString() })
    }
    if (rows.length > 0) {
      const { error } = await (admin as any)
        .from('memo_agent_prompts')
        .upsert(rows as any, { onConflict: 'fund_id,stage' })
      if (error) return dbError(error, 'diligence-prompts-guidance')
    }
  }

  return NextResponse.json({ ok: true })
}

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string }
}
