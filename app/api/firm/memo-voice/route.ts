import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { outcomeResponse } from '@/lib/service-outcome'
import { getMemoVoiceRow, learnMemoVoice, memoVoiceEdit, saveMemoVoice } from '@/lib/memo-agent/voice-store'
import { DEFAULT_MEMO_EXAMPLES_MD, DEFAULT_MEMO_VOICE_MD } from '@/lib/memo-agent/skill'

/**
 * The fund's memo voice: the voice, house rules and examples every memo is written in, by the memo
 * agent and by a connected assistant (diligence_memo_skill).
 *
 * GET  → { voice: row | null, defaults: { voice, examples } }
 * PUT  → save { voice?, house_rules?, examples?, learned_from? }
 * POST → learn a draft from the sample memos ({ anchor_ids? }); saves nothing
 */
async function member() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}

export async function GET() {
  const m = await member()
  if ('error' in m) return m.error
  const row = await getMemoVoiceRow(m.admin as any, m.fundId)
  return NextResponse.json({ voice: row, defaults: { voice: DEFAULT_MEMO_VOICE_MD, examples: DEFAULT_MEMO_EXAMPLES_MD } })
}

export async function PUT(req: NextRequest) {
  const m = await member()
  if ('error' in m) return m.error
  const edit = memoVoiceEdit(await req.json().catch(() => ({})))
  if (!edit.ok) return outcomeResponse(edit)
  return outcomeResponse(await saveMemoVoice(m.admin as any, { fundId: m.fundId, userId: m.userId }, edit.value), v => ({ voice: v }))
}

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const m = await member()
  if ('error' in m) return m.error
  const body = await req.json().catch(() => ({}))
  const ids = Array.isArray(body?.anchor_ids) ? body.anchor_ids.filter((x: unknown) => typeof x === 'string') : undefined
  return outcomeResponse(await learnMemoVoice(m.admin as any, { fundId: m.fundId, userId: m.userId }, ids))
}
