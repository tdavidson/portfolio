import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { recordAudit } from '@/lib/audit/events'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts) — this is per-partner capital data, gated
// exactly like capital calls, its inbound mirror.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { previewDistribution, declareDistribution, listDistributions } from '@/lib/accounting/distributions'
import { recordRegisterPayments } from '@/lib/accounting/register-import'
import { postDistributionDeductions } from '@/lib/accounting/call-extras'

// GET — declared distributions for the vehicle, newest first.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  return NextResponse.json(await listDistributions(admin, gate.fundId, group))
}

// POST — { action: 'preview' | 'declare', … }
//   preview: { total, asOf?, method?: 'waterfall' | 'pro_rata' }
//            → the split, writing nothing. Through the waterfall when the vehicle has carry
//              terms (LP lines + carry lines + the tier breakdown), else pro-rata by capital.
//   declare: { distributionDate, description?, lines, carryLines?, splitMethod?, tiers?, kind?, character? }
//            → Dr each partner's capital, Cr 2300 Distributions payable; carry as its own entry
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
    const asOf = typeof body?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf)
      ? body.asOf
      : new Date().toISOString().slice(0, 10)
    const method = body?.method === 'pro_rata' ? 'pro_rata' : 'waterfall'
    return NextResponse.json(await previewDistribution(admin, gate.fundId, group, total, asOf, method))
  }

  if (body?.action === 'declare') {
    // Character is optional: omitting it leaves the distribution uncharacterised, which is a
    // legitimate state and the one every pre-existing row is in. Supplying a partial split is
    // not — declareDistribution refuses anything that doesn't sum to the declared total.
    const c = body?.character
    const t = body?.tiers
    const result = await declareDistribution(admin, gate.fundId, group, user.id, {
      requestKey: typeof body.requestKey === 'string' ? body.requestKey.slice(0, 100) : undefined,
      distributionDate: String(body?.distributionDate ?? ''),
      description: body?.description ?? null,
      lines: Array.isArray(body?.lines) ? body.lines : [],
      carryLines: Array.isArray(body?.carryLines) ? body.carryLines : [],
      splitMethod: body?.splitMethod,
      tiers: t && typeof t === 'object'
        ? {
            returnOfCapital: Number(t.returnOfCapital ?? 0),
            preferred: Number(t.preferred ?? 0),
            catchUp: Number(t.catchUp ?? 0),
            carry: Number(t.carry ?? 0),
            profitToLP: Number(t.profitToLP ?? 0),
            toLP: Number(t.toLP ?? 0),
            toGP: Number(t.toGP ?? 0),
          }
        : null,
      kind: body?.kind,
      character: c
        ? {
            returnOfCapital: Number(c.returnOfCapital ?? 0),
            realizedGain: Number(c.realizedGain ?? 0),
            income: Number(c.income ?? 0),
          }
        : undefined,
    })
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    const date = String(body.distributionDate)
    const lines = linesOf(body.lines)
    const extras: Record<string, unknown> = {}
    // 1. Fees, tax withheld or an unpaid call netted off — taken from what the partner is owed.
    if (Array.isArray(body?.deductions) && body.deductions.length > 0) {
      const d = await postDistributionDeductions(admin, gate.fundId, group, user.id, { distributionId: result.distributionId, date, lines, deductions: body.deductions })
      Object.assign(extras, 'error' in d ? { deductionsError: d.error } : { deductionsPosted: d.posted })
    }
    // 2. Imported from a spreadsheet: what has already been paid out to each partner.
    if (Array.isArray(body?.payments) && body.payments.length > 0) {
      const paid = await recordRegisterPayments(admin, gate.fundId, group, user.id, {
        kind: 'distribution', registerId: result.distributionId, registerDate: date, lines, payments: body.payments,
      })
      Object.assign(extras, 'error' in paid ? { paymentsError: paid.error } : { paymentsPosted: paid.posted })
    }
    await recordAudit(admin, {
      fundId: gate.fundId, vehicleId: await vehicleIdByName(admin, gate.fundId, group), actorId: user.id,
      action: 'distribution.declare', subjectType: 'distribution', subjectId: result.distributionId,
      details: { date, total: Array.from(lines.values()).reduce((s, v) => s + v, 0), partners: lines.size, ...extras },
    })
    return NextResponse.json({ ...result, ...extras })
  }

  return NextResponse.json({ error: "action must be 'preview' or 'declare'" }, { status: 400 })
}

/** The register's own lines, per partner, for capping imported payments. */
function linesOf(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of Array.isArray(raw) ? raw : []) if (l && typeof l.lpEntityId === 'string') out.set(l.lpEntityId, (out.get(l.lpEntityId) ?? 0) + (Number(l.amount) || 0))
  return out
}
