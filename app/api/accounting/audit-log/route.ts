import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { auditCsv, loadAuditTrail, visibleTo } from '@/lib/audit/read'

// GET — the books' audit trail (accounting_audit_events): voids, unposts, reversals, period closes,
// reopens and approvals, commitment edits, shared reports, calls, distributions, K-1s.
//
//   ?group=<entity>   one entity's events (omit for the whole firm)
//   ?from=&to=        YYYY-MM-DD bounds
//   ?format=csv       the same rows as a download, for an auditor
//
// Gated on accounting read (route-domains.ts). Events carrying partner figures or the carry are
// dropped for a caller without lp_capital / gp_economics (lib/audit/read.ts visibleTo).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const sp = req.nextUrl.searchParams
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const group = sp.get('group')
  const vehicleId = group ? await vehicleIdByName(admin, gate.fundId, group) : null
  if (group && !vehicleId) return NextResponse.json({ error: `Unknown entity "${group}"` }, { status: 400 })

  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  // Entity scope: one entity the caller may see, or the firm-wide trail cut to the entities they
  // may see. Events not tied to an entity are shown only to a caller who sees every entity.
  if (vehicleId && !canSeeVehicle(access, vehicleId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const visible = visibleVehicleIds(access)
  const csv = sp.get('format') === 'csv'
  const all = await loadAuditTrail(admin, gate.fundId, { vehicleId, from: date(sp.get('from')), to: date(sp.get('to')), limit: csv ? undefined : Math.min(500, Number(sp.get('limit')) || 100) }, visibleTo(access))
  const rows = visible === null ? all : all.filter(r => r.vehicleId != null && visible.includes(r.vehicleId))

  if (!csv) return NextResponse.json({ events: rows })
  const { data: vehicles } = await admin.from('fund_vehicles' as any).select('id, name').eq('fund_id', gate.fundId)
  const names = new Map(((vehicles as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const file = `audit-trail${group ? `-${group.replace(/[^\w.-]+/g, '-')}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(auditCsv(rows, names), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` },
  })
}
