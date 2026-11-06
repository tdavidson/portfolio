import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { proposeProfile } from '@/lib/lp-letters/draft-from-brief'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 120

/**
 * Propose an entity's letter profile from its last letter as sent (or `letter_id`): read by the
 * fund's AI, returned for the person to review. Nothing is saved.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const limited = await rateLimit({ key: `lp-letter-profile-seed:${user.id}`, limit: 5, windowSeconds: 300 })
  if (limited) return limited
  const body = await req.json().catch(() => ({}))
  const vehicle = typeof body?.vehicle === 'string' ? body.vehicle : ''
  if (!vehicle) return NextResponse.json({ error: 'Name the entity.' }, { status: 400 })
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (scope?.vehicleNames && !scope.vehicleNames.includes(vehicle)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const proposed = await proposeProfile(admin, writeCheck.fundId, user.id, vehicle, typeof body?.letter_id === 'string' ? body.letter_id : null)
    if (!proposed) return NextResponse.json({ error: 'No sent letter to read for this entity. Import one first.' }, { status: 404 })
    return NextResponse.json(proposed)
  } catch (err) {
    console.error('[lp-letter-profile-seed]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Reading the letter failed. Try again.' }, { status: 500 })
  }
}
