import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { issueCapitalCall, proRataCall, lpCapitalSummary, listCapitalCalls } from '@/lib/accounting/capital-calls'
import { recordRegisterPayments } from '@/lib/accounting/register-import'

// GET — the per-LP capital summary (commitment/called/funded/outstanding) plus
// the issued-call history for the vehicle.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const [summary, calls] = await Promise.all([
    lpCapitalSummary(admin, gate.fundId, group),
    listCapitalCalls(admin, gate.fundId, group),
  ])
  return NextResponse.json({ summary, calls })
}

// POST — { action: 'preview' | 'issue', ... }
//   preview: { total } → per-LP pro-rata split by commitment (to edit before issuing)
//   issue:   { callDate, description, scope, lines: [{ lpEntityId, amount }] }
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


  if (body?.action === 'preview') {
    const total = Number(body?.total)
    if (!Number.isFinite(total) || total <= 0) return NextResponse.json({ error: 'A positive total is required' }, { status: 400 })
    return NextResponse.json({ lines: await proRataCall(admin, gate.fundId, group, total) })
  }

  if (body?.action === 'issue') {
    const result = await issueCapitalCall(admin, gate.fundId, group, user.id, {
      requestKey: typeof body.requestKey === 'string' ? body.requestKey.slice(0, 100) : undefined,
      callDate: String(body?.callDate ?? ''),
      dueDate: body?.dueDate ? String(body.dueDate) : null,
      description: body?.description ?? null,
      scope: body?.scope === 'per_lp' ? 'per_lp' : 'fund_wide',
      lines: Array.isArray(body?.lines) ? body.lines : [],
    })
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    // A call imported from a spreadsheet arrives with what each partner has already paid
    // (lib/accounting/register-import.ts). The call stands either way; a payment that cannot be
    // posted is reported, not a reason to unissue it.
    if (Array.isArray(body?.payments) && body.payments.length > 0) {
      const paid = await recordRegisterPayments(admin, gate.fundId, group, user.id, {
        kind: 'call', registerId: result.callId, registerDate: String(body.callDate), lines: linesOf(body.lines), payments: body.payments,
      })
      return NextResponse.json({ ...result, ...('error' in paid ? { paymentsError: paid.error } : { paymentsPosted: paid.posted }) })
    }
    return NextResponse.json(result)
  }

  return NextResponse.json({ error: "action must be 'preview' or 'issue'" }, { status: 400 })
}

/** The register's own lines, per partner, for capping imported payments. */
function linesOf(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of Array.isArray(raw) ? raw : []) if (l && typeof l.lpEntityId === 'string') out.set(l.lpEntityId, (out.get(l.lpEntityId) ?? 0) + (Number(l.amount) || 0))
  return out
}
