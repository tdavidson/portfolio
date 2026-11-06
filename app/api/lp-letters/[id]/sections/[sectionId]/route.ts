import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { getLetter, updateSection } from '@/lib/lp-letters/service'
import { fromLetter } from '@/lib/lp-letters/content'
import { briefForLetter, rewriteSection } from '@/lib/lp-letters/draft-from-brief'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 120

async function gate(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  const scope = await loadEntityScopeForUser(admin, user.id)
  return { admin, user, fundId: writeCheck.fundId, visible: scope ? scope.vehicleNames : [] as string[] }
}

/** Edit one section: its text or its heading. */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string; sectionId: string }> }) {
  const params = await props.params
  const g = await gate(req)
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await updateSection(g.admin, { fundId: g.fundId, userId: g.user.id, visible: g.visible }, params.id, decodeURIComponent(params.sectionId), {
    body: body?.body, heading: body?.heading,
  }))
}

/**
 * Rewrite one section with the fund's AI, from the same brief as the whole letter and with the
 * rest of the letter as context. `prompt` is guidance for this section, kept with the letter.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string; sectionId: string }> }) {
  const params = await props.params
  const sectionId = decodeURIComponent(params.sectionId)
  const g = await gate(req)
  if ('error' in g) return g.error
  const limited = await rateLimit({ key: `lp-letter-section:${g.user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const body = await req.json().catch(() => ({}))
  const found = await getLetter(g.admin, g.fundId, g.visible, params.id)
  const letter = found.ok ? found.value : null
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (letter.status === 'generating') return NextResponse.json({ error: 'This letter is being generated. Try again when it finishes.' }, { status: 409 })
  const content = fromLetter(letter)
  if (!content.sections.some(s => s.id === sectionId)) return NextResponse.json({ error: 'No such section' }, { status: 404 })

  // A section's guidance is kept with the letter, so a later rewrite uses it too.
  const prompts: Record<string, { prompt: string; mode: 'add' }> = { ...(letter.company_prompts ?? {}) }
  if (typeof body?.prompt === 'string') {
    if (body.prompt.trim()) prompts[sectionId] = { prompt: body.prompt.trim().slice(0, 4000), mode: 'add' }
    else delete prompts[sectionId]
    await g.admin.from('lp_letters').update({ company_prompts: prompts as any }).eq('id', params.id).eq('fund_id', g.fundId)
  }

  try {
    const loaded = await briefForLetter(g.admin, g.fundId, letter)
    const text = await rewriteSection(g.admin, g.fundId, g.user.id, loaded, content, sectionId, letter.generation_prompt, prompts[sectionId]?.prompt)
    if (!text) return NextResponse.json({ error: 'The AI returned nothing for this section. Try again.' }, { status: 502 })
    return outcomeResponse(await updateSection(g.admin, { fundId: g.fundId, userId: g.user.id, visible: g.visible }, params.id, sectionId, { body: text }))
  } catch (err) {
    console.error('[lp-letters-section]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Rewriting the section failed. Try again.' }, { status: 500 })
  }
}
