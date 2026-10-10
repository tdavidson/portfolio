import { recordAudit } from '@/lib/audit/events'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { amendK1Package, finalizeK1Package, generateK1Package } from '@/lib/tax/k1-package'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

// K-1 packages for a vehicle: generate a draft, issue it, amend an issued one.
//
// GET lists what exists. POST takes an action, because the three verbs are transitions on one
// object rather than three resources.

function taxYearOr400(raw: unknown): number | NextResponse {
  const year = Number(raw)
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ error: 'A four-digit taxYear is required' }, { status: 400 })
  }
  return year
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Per-partner K-1 figures include the GP's — see lib/tax/access.ts.
  const carryGate = await refuseWithoutCarryAccess(admin, gate, user.id)
  if (carryGate) return carryGate

  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const packageId = req.nextUrl.searchParams.get('packageId')
  if (packageId) {
    const [{ data: pkg }, { data: partners }, { data: lines }] = await Promise.all([
      admin.from('k1_packages' as any).select('*').eq('fund_id', gate.fundId).eq('id', packageId).maybeSingle(),
      admin.from('k1_partners' as any).select('*').eq('fund_id', gate.fundId).eq('package_id', packageId),
      admin.from('k1_lines' as any).select('*').eq('fund_id', gate.fundId).eq('package_id', packageId),
    ])
    if (!pkg || !canSeeVehicle(access, (pkg as any).vehicle_id ?? null)) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
    return NextResponse.json({ package: pkg, partners: partners ?? [], lines: lines ?? [] })
  }

  const { data, error } = await admin
    .from('k1_packages' as any)
    .select('id, vehicle_id, tax_year, version, status, finalized_at, created_at, warnings')
    .eq('fund_id', gate.fundId)
    .order('tax_year', { ascending: false })
    .order('version', { ascending: false })
    .limit(200)
  if (error) return dbError(error, 'k1-packages')
  // Only the caller's entities' packages.
  return NextResponse.json({ packages: ((data as any[]) ?? []).filter(p => canSeeVehicle(access, p.vehicle_id)) })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `k1-packages:${user.id}`, limit: 20, windowSeconds: 60 })
  if (limited) return limited

  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Per-partner K-1 figures include the GP's — see lib/tax/access.ts.
  const carryGate = await refuseWithoutCarryAccess(admin, gate, user.id)
  if (carryGate) return carryGate

  const body = await req.json().catch(() => ({}))
  const action = body?.action

  if (action === 'finalize') {
    const packageId = typeof body?.packageId === 'string' ? body.packageId : ''
    if (!packageId) return NextResponse.json({ error: 'packageId is required' }, { status: 400 })
    const result = await finalizeK1Package(admin, gate.fundId, packageId, user.id)
    if ('error' in result) {
      // 409, not 400: the request is well formed and the package is simply not ready. The
      // blockers come back so the caller can list what to fix rather than guess.
      return NextResponse.json(result, { status: 409 })
    }
    await recordAudit(admin, { fundId: gate.fundId, actorId: user.id, action: 'k1.finalize', subjectType: 'k1_package', subjectId: packageId })
    return NextResponse.json(result)
  }

  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const taxYear = taxYearOr400(body?.taxYear)
  if (taxYear instanceof NextResponse) return taxYear

  if (action === 'generate' || action === 'amend') {
    const result =
      action === 'amend'
        ? await amendK1Package(admin, gate.fundId, group, user.id, taxYear)
        : await generateK1Package(admin, gate.fundId, group, user.id, taxYear)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    await recordAudit(admin, {
      fundId: gate.fundId, actorId: user.id, action: action === 'amend' ? 'k1.amend' : 'k1.generate', subjectType: 'k1_package', subjectId: result.packageId,
      details: { group, taxYear, version: result.version, partners: result.partnerCount, blockers: result.blockers.length },
    })
    return NextResponse.json(result)
  }

  return NextResponse.json({ error: "action must be 'generate', 'finalize' or 'amend'" }, { status: 400 })
}
