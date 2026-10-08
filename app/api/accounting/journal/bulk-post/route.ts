import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { dbError } from '@/lib/api-error'
import { readBulkScope, runBulkDraftAction } from '@/lib/accounting/journal-bulk'
import { loadMayTouchInvestments } from '@/lib/accounting/investment-access'

// POST — post many DRAFT entries at once (the journal's bulk-post action).
//   body: { group?, start?, end?, ids?, afterId? }
//     ids     — post exactly these entries (still draft-only, still guarded), one shot; OR
//     start/end — restrict the window (omit both for all drafts);
//     afterId — keyset cursor from the previous call's `cursor`, to page through.
// Each entry is posted only if it is a draft, is balanced, and does not fall in a closed
// period; everything else comes back in `skipped` with a reason. Returns { posted, skipped,
// hasMore, cursor } — the client loops with afterId=cursor while hasMore is true.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const result = await runBulkDraftAction(admin, {
    fundId: gate.fundId,
    vehicleId,
    group,
    action: 'post',
    scope: readBulkScope(body),
    userId: user.id,
    // A draft that would adopt or release investment transactions is skipped, with the reason.
    investments: await loadMayTouchInvestments(admin, gate, user.id),
  })
  if (!result.ok) return dbError(result.error as any, 'journal-bulk-post')

  const { changed, skipped, warnings, removedTransactions, unlinkedRegisterRows, hasMore, cursor } = result.outcome
  // `changed` is the action-neutral name the client reads; `posted` is kept for clarity
  // at the API surface. A posted reversal draft deletes its original's transactions: say which,
  // and say when that failed part-way (`warnings`).
  return NextResponse.json({ changed, posted: changed, skipped, warnings, removedTransactions, unlinkedRegisterRows, hasMore, cursor })
}
