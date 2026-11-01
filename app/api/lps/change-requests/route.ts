import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadGateAccess } from '@/lib/access/request-context'
import { hasAccess } from '@/lib/access/effective'
import { loadLpScope } from '@/lib/access/lp-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { decideChangeRequest, listChangeRequests } from '@/lib/lps/change-requests'

/**
 * Change requests from LPs: changes to their record, and portal access for someone acting for
 * them. lib/lps/change-requests.ts.
 *
 *   GET  ?all=1                         → pending requests (or every one), for the caller's LPs
 *   POST { id, decision: 'approve' | 'reject', note? }
 *
 * Gated on lp_capital: read to see them (the middleware), write to decide. Approving makes the
 * change through the same function a direct edit uses, as the approver; giving someone portal
 * access is admin-only, as it is directly.
 */

async function ctx() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  const [lp, access] = await Promise.all([loadLpScope(admin, gate), loadGateAccess(admin, gate)])
  return {
    admin,
    actor: {
      fundId: gate.fundId, userId: user.id, role: gate.role,
      investorIds: lp.investorIds, entityIds: lp.entityIds,
      canWrite: gate.role !== 'viewer' && hasAccess(access, 'lp_capital', 'write'),
    },
  }
}

export async function GET(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  return outcomeResponse(
    await listChangeRequests(c.admin, c.actor, { includeClosed: req.nextUrl.searchParams.get('all') === '1' }),
    requests => ({ requests, canDecide: c.actor.canWrite, isAdmin: c.actor.role === 'admin' }),
  )
}

export async function POST(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await decideChangeRequest(c.admin, c.actor, body))
}
