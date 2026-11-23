import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts), and admin-only, checked here (HANDLER_CHECKED): the
// sheet prints every partner's full account number. Each export is logged.
import { assertReadAccess } from '@/lib/api-helpers'
import { adminOnlyDenial, HANDLER_CHECKED } from '@/lib/access/admin-only'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { recordAudit } from '@/lib/audit/events'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fundNameFor } from '@/lib/accounting/distribution-review'
import { distributionPayoutDocument } from '@/lib/accounting/distribution-payouts'

export const runtime = 'nodejs'

// GET ?group=&id=  — the payout sheet for a declared distribution (.xlsx)
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const denied = adminOnlyDenial(gate.role, HANDLER_CHECKED.payoutSheet)
  if (denied) return NextResponse.json({ error: denied }, { status: 403 })
  const limited = await rateLimit({ key: `distribution-payouts:${user.id}`, limit: 10, windowSeconds: 60 })
  if (limited) return limited
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group
  const id = sp.get('id')
  if (!id) return NextResponse.json({ error: 'id (a declared distribution) is required' }, { status: 400 })

  const doc = await distributionPayoutDocument(admin, gate.fundId, group, id, { fundName: await fundNameFor(admin, gate.fundId, group), generatedBy: user.email ?? null })
  if (!doc) return NextResponse.json({ error: 'Distribution not found on this vehicle' }, { status: 404 })
  await recordAudit(admin, {
    fundId: gate.fundId, vehicleId: await vehicleIdByName(admin, gate.fundId, group), actorId: user.id,
    action: 'distribution.payout_sheet', subjectType: 'distribution', subjectId: id,
    details: { partners: doc.rows.length, withBankDetails: doc.rows.filter(r => r.wire).length, ready: doc.rows.filter(r => r.ready).length },
  })
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': doc.contentType,
      'Content-Disposition': `attachment; filename="${doc.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
