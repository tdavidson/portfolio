import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { getLetter } from '@/lib/lp-letters/service'
import { briefForLetter, writeDraftInto, writeWithFundAI } from '@/lib/lp-letters/draft-from-brief'
import { logActivity } from '@/lib/activity'
import { rateLimit } from '@/lib/rate-limit'

// The whole letter is one AI call from the brief, which can take a minute or two.
export const maxDuration = 300

/**
 * Write the whole letter with the fund's AI: the same brief, layers and rules as lp_draft_letter,
 * saved as the letter's sections. The letter page and the MCP tools go through this one generator.
 */
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const limited = await rateLimit({ key: `lp-letter-gen:${user.id}`, limit: 5, windowSeconds: 300 })
  if (limited) return limited

  const scope = await loadEntityScopeForUser(admin, user.id)
  const found = await getLetter(admin, fundId, scope ? scope.vehicleNames : [], params.id)
  const letter = found.ok ? found.value : null
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (letter.status === 'generating') return NextResponse.json({ error: 'This letter is already being generated.' }, { status: 409 })

  await admin
    .from('lp_letters')
    .update({ status: 'generating', generation_error: null, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  try {
    const loaded = await briefForLetter(admin, fundId, letter)
    const text = await writeWithFundAI(admin, fundId, user.id, loaded.brief, loaded.voice, letter.generation_prompt)
    if (!text) throw new Error('The draft came back empty')
    const saved = await writeDraftInto(admin, { fundId, userId: user.id }, params.id, text, loaded, 'fund_ai')
    if (!saved.ok) throw new Error(saved.error)

    logActivity(admin, fundId, user.id, 'lp-letter.generate', {
      letterId: params.id,
      periodLabel: letter.period_label,
      sections: Array.isArray(saved.value.content?.sections) ? saved.value.content.sections.length : 0,
    })
    return NextResponse.json(saved.value)
  } catch (err) {
    console.error('[lp-letters] Generation error detail:', err instanceof Error ? err.message : err)
    await admin
      .from('lp_letters')
      .update({ status: 'draft', generation_error: 'Letter generation failed. Please try again.', updated_at: new Date().toISOString() })
      .eq('id', params.id)
    return NextResponse.json({ error: 'Letter generation failed. Please try again.' }, { status: 500 })
  }
}
