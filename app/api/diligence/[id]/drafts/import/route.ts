import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { outcomeResponse } from '@/lib/service-outcome'
import { importWordMemo } from '@/lib/memo-agent/assistant-memo'

const MAX_BYTES = 15 * 1024 * 1024

/**
 * A partner's edited Word memo, imported as a new draft version of the deal's memo. multipart form:
 * file (.docx) and draft_id (the draft it was exported from). Returns the new draft and the changes.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = (membership as any).fund_id as string

  const { data: deal } = await (admin as any).from('diligence_deals').select('*').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const draftId = form?.get('draft_id')
  if (!(file instanceof File) || typeof draftId !== 'string') return NextResponse.json({ error: 'Send file and draft_id.' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That file is larger than 15 MB.' }, { status: 400 })
  const bytes = Buffer.from(await file.arrayBuffer())
  return outcomeResponse(await importWordMemo(admin as any, { fundId, userId: user.id }, deal, draftId, bytes))
}
