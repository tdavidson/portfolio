import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess } from '@/lib/api-helpers'
import { outcomeResponse } from '@/lib/service-outcome'
import { announceToLps } from '@/lib/lps/outreach'

// An announcement: a message to chosen LPs (or all of them) with nothing attached to it.
//
//   POST { subject, body, lp_investor_ids?: string[] | 'all', preview?: boolean }
//
// Every other LP email hangs off an item — a statement, a letter, a document. This is the plain
// message: a close, a change of address, a heads-up before a call. It goes out through the same
// recipient resolution (the investor's account To, their authorized users Cc), is recorded as an
// outbound message per investor so the portal shows it, and is logged per send. `preview`
// returns the exact addresses without sending. (lib/lps/outreach.ts, shared with lp_announce.)
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const access = await assertWriteAccess(admin, user.id)
  if (access instanceof NextResponse) return access

  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await announceToLps(admin, { fundId: access.fundId, userId: user.id, role: access.role }, body))
}
