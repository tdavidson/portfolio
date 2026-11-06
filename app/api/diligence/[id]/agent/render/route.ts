import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runRenderJob } from '@/lib/memo-agent/jobs/render-job'

const VALID_FORMATS = ['markdown', 'docx', 'gdoc', 'pdf'] as const

/**
 * Render a draft synchronously. Markdown returns inline; docx returns a 24h
 * signed download URL; gdoc returns a Google Doc view link. The render-job
 * helper is shared so a future async path can reuse it.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
  const fundId = (membership as any).fund_id as string

  const body = await req.json().catch(() => ({}))
  const format = typeof body.format === 'string' ? body.format : 'markdown'
  if (!VALID_FORMATS.includes(format as any)) {
    return NextResponse.json({ error: 'Invalid format' }, { status: 400 })
  }
  const draftId = typeof body.draft_id === 'string' ? body.draft_id : null
  if (!draftId) return NextResponse.json({ error: 'draft_id required' }, { status: 400 })

  // Confirm the draft belongs to this fund + deal.
  const { data: row } = await admin
    .from('diligence_memo_drafts')
    .select('id')
    .eq('id', draftId)
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const result = await runRenderJob(admin, {
      id: 'sync',
      fund_id: fundId,
      deal_id: params.id,
      draft_id: draftId,
      payload: { format },
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Render failed' }, { status: 500 })
  }
}
