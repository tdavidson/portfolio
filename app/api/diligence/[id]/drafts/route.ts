import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
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

  // round_id arrives with the diligence rounds migration; before it is applied, list without it.
  const COLS = 'id, draft_version, agent_version, is_draft, finalized_at, created_at, ingestion_output, research_output, qa_answers, memo_draft_output'
  const list = (cols: string) => admin
    .from('diligence_memo_drafts')
    .select(cols)
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
  let { data, error } = await list(`round_id, ${COLS}`)
  if (error && /round_id/.test(error.message ?? '')) ({ data, error } = await list(COLS))

  if (error) return dbError(error, 'diligence-drafts-list')
  return NextResponse.json(data ?? [])
}
