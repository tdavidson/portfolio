import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts) — who was emailed what is a relationship fact.
import { assertReadAccess } from '@/lib/api-helpers'
import { listDeliveries, type DeliveryKind } from '@/lib/lp-deliveries'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

const KINDS: DeliveryKind[] = ['notice', 'receipt', 'statement', 'letter', 'snapshot', 'document', 'announcement', 'reply']

/**
 * GET ?kind=notice&ids=a,b,c → every delivery of those items, newest first.
 *
 * The delivery log for a set of items of one kind: which address each went to, who was Cc'd,
 * and whether the provider accepted it. A failed send is a row too.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const kind = req.nextUrl.searchParams.get('kind') as DeliveryKind | null
  if (!kind || !KINDS.includes(kind)) return NextResponse.json({ error: `kind must be one of ${KINDS.join(', ')}` }, { status: 400 })
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 500)
  if (ids.length === 0) return NextResponse.json({ deliveries: [] })

  // Only deliveries to investors the caller can see (listDeliveries reads with the service role, so
  // the route filters — the registry test cannot follow a lib helper, so this is checked here).
  const lp = await loadLpScope(admin, gate)
  const deliveries = (await listDeliveries(admin, gate.fundId, kind, ids)).filter(d => lpVisible(lp.investorIds, d.lpInvestorId))
  return NextResponse.json({ deliveries })
}
