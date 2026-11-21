import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadGateAccess } from '@/lib/access/request-context'
import { outcomeResponse } from '@/lib/service-outcome'
import { readAuditLog } from '@/lib/audit-log'

/**
 * Audit: the automatic log of what outside firms did, grouped by firm (lib/audit-log).
 *
 *   GET ?firm=&since=YYYY-MM-DD&until=YYYY-MM-DD&limit=
 *
 * Gated on the `records` grant under the `audit` switch in route-domains.ts. Someone on an
 * engagement gets only their own firm. Turning Audit on or off is the Settings page (feature
 * visibility), or the audit_settings tool.
 */

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const access = await loadGateAccess(admin, gate)
  const p = req.nextUrl.searchParams
  return outcomeResponse(await readAuditLog(admin, access, {
    firm: p.get('firm') || undefined, since: p.get('since') || undefined, until: p.get('until') || undefined, limit: p.get('limit') || undefined,
  }), log => log)
}
