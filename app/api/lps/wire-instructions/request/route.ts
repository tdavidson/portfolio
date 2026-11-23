import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts), admin-only (lib/access/admin-only.ts): it
// emails LPs.
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'
import { rateLimit } from '@/lib/rate-limit'
import { planWireRequest, sendWireRequest } from '@/lib/lps/wire-request'

export const runtime = 'nodejs'

// POST { lp_entity_ids: string[], message?, include_verified?: boolean, preview?: boolean }
//
// Ask partners for bank details for distributions, by portal account or, without one, the contact
// or notice email on file. Entities with verified details are left out unless include_verified
// (to re-confirm before a payment). `preview` returns who would be asked about what, and sends nothing.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const lp = await loadLpScope(admin, gate)
  const ids = (Array.isArray(body?.lp_entity_ids) ? body.lp_entity_ids : []).filter((x: unknown): x is string => typeof x === 'string' && lpVisible(lp.entityIds, x))
  if (ids.length === 0) return NextResponse.json({ error: 'Choose at least one LP entity.' }, { status: 400 })
  const includeVerified = body?.include_verified === true
  const message = typeof body?.message === 'string' ? body.message.slice(0, 5000) : null

  if (body?.preview === true) {
    const plan = await planWireRequest(admin, gate.fundId, ids, { includeVerified })
    if ('error' in plan) return NextResponse.json({ error: plan.error }, { status: 400 })
    return NextResponse.json({ preview: true, ...plan })
  }
  const limited = await rateLimit({ key: `wire-request:${user.id}`, limit: 5, windowSeconds: 60 })
  if (limited) return limited
  const out = await sendWireRequest(admin, { fundId: gate.fundId, userId: user.id }, ids, { message, includeVerified })
  if ('error' in out) return NextResponse.json({ error: out.error }, { status: 400 })
  return NextResponse.json(out)
}
