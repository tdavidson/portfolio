import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). Management companies join the list only for a
// caller who holds `management_company`, checked in the handler — the same rule resolveGroupOr400
// applies per vehicle, applied here to the list.
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { loadFirmOverview } from '@/lib/accounting/firm-load'
import { canSeeVehicle } from '@/lib/access/scope'

// GET — every entity the caller may see, with the state of its books: closed through, last entry,
// drafts waiting, bank rows unreconciled, trial balance tied. The firm-wide "is it ready?" view.
export async function GET(request: Request) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const ctx = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  const includeManco = hasAccess(ctx, 'management_company', 'read')
  return NextResponse.json(await loadFirmOverview(admin, gate.fundId, { includeManco, includeBacklog: new URL(request.url).searchParams.get('backlog') === '1', visible: id => canSeeVehicle(ctx, id) }))
}
