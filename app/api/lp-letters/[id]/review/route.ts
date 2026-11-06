import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { getLetter } from '@/lib/lp-letters/service'
import { briefForLetter } from '@/lib/lp-letters/draft-from-brief'
import { fromLetter } from '@/lib/lp-letters/content'
import { avoidTerms, reviewLetter } from '@/lib/lp-letters/review'

/**
 * The review of a letter against a fresh brief: each flag names the section it is about, so the
 * letter page can show it beside that section. Read-only.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = membership.fund_id as string

  const scope = await loadEntityScopeForUser(admin, user.id)
  const found = await getLetter(admin, fundId, scope ? scope.vehicleNames : [], params.id)
  const letter = found.ok ? found.value : null
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const { brief, investorNames, voice } = await briefForLetter(admin, fundId, letter)
    const flags = reviewLetter(fromLetter(letter), brief, investorNames, letter.internal_notes, { avoid: avoidTerms(voice.houseRules) })
    return NextResponse.json({ flags, missing_information: brief.missing_information, as_of: brief.as_of })
  } catch (err) {
    console.error('[lp-letters] Review error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not review this letter.' }, { status: 500 })
  }
}
