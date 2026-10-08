import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { dbError } from '@/lib/api-error'
import { readBulkScope, runBulkDraftAction } from '@/lib/accounting/journal-bulk'

// POST — void many DRAFT entries at once (the journal's bulk-discard action). Same body,
// same paging and the same guards as bulk-post; see lib/accounting/journal-bulk.ts.
//
// Draft-only, deliberately. A draft has never touched the ledger, so voiding it discards a
// note-to-self. Voiding a POSTED entry reverses real balances, and that stays a one-at-a-time
// act through the PATCH route where the operator sees the entry they're reversing.
//
// Balance is NOT a condition here (unlike posting): an out-of-balance draft is exactly the
// kind you want to be able to throw away. A closed period still blocks it.
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
    action: 'void',
    userId: user.id,
    scope: readBulkScope(body),
  })
  if (!result.ok) return dbError(result.error as any, 'journal-bulk-void')

  const { changed, skipped, hasMore, cursor } = result.outcome
  // `changed` is the action-neutral name the client reads; `voided` is kept for clarity
  // at the API surface.
  return NextResponse.json({ changed, voided: changed, skipped, hasMore, cursor })
}
