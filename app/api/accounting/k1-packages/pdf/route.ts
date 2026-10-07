import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { assertReadAccess } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { emptyLines, type K1Category } from '@/lib/accounting/k1-allocation'
import { generateK1Pdf } from '@/lib/tax/k1-pdf'
import { currentForm, type TaxFormRecord } from '@/lib/tax/forms'
import { assertK1PackageVisible } from '@/lib/accounting/vehicle-visibility'

// One partner's K-1 figures as a PDF.
//
// GP-side. The portal serves the same document to the partner through the delivery record, which
// is where consent is checked — this route is the manager looking at, or printing, what will be
// furnished.

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

  const limited = await rateLimit({ key: `k1-pdf:${user.id}`, limit: 60, windowSeconds: 300 })
  if (limited) return limited

  const packageId = req.nextUrl.searchParams.get('packageId')
  const lpEntityId = req.nextUrl.searchParams.get('lpEntityId')
  if (!packageId || !lpEntityId) {
    return NextResponse.json({ error: 'packageId and lpEntityId are required' }, { status: 400 })
  }
  const hiddenPackage = await assertK1PackageVisible(admin, gate, packageId)
  if (hiddenPackage) return hiddenPackage

  const { data: pkg } = await admin
    .from('k1_packages' as any)
    .select('id, vehicle_id, tax_year, version, status, warnings')
    .eq('fund_id', gate.fundId)
    .eq('id', packageId)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

  const [{ data: partner }, { data: lines }, { data: fund }, { data: vehicle }, { data: entity }, { data: forms }] =
    await Promise.all([
      admin.from('k1_partners' as any).select('*').eq('fund_id', gate.fundId).eq('package_id', packageId).eq('lp_entity_id', lpEntityId).maybeSingle(),
      admin.from('k1_lines' as any).select('category, amount').eq('fund_id', gate.fundId).eq('package_id', packageId).eq('lp_entity_id', lpEntityId),
      admin.from('funds').select('name').eq('id', gate.fundId).maybeSingle() as unknown as Promise<{ data: { name: string } | null }>,
      admin.from('fund_vehicles' as any).select('name').eq('id', (pkg as any).vehicle_id).maybeSingle(),
      admin.from('lp_entities' as any).select('entity_name').eq('fund_id', gate.fundId).eq('id', lpEntityId).maybeSingle(),
      admin.from('lp_tax_forms' as any).select('form_type, signed_date, expires_on, legal_name, tin_last4').eq('fund_id', gate.fundId).eq('lp_entity_id', lpEntityId),
    ])
  if (!partner) return NextResponse.json({ error: 'Partner not in this package' }, { status: 404 })

  const lineMap = emptyLines()
  for (const l of ((lines as any[]) ?? [])) lineMap[l.category as K1Category] = Number(l.amount)

  const records: (TaxFormRecord & { row: any })[] = ((forms as any[]) ?? []).map(r => ({
    formType: r.form_type,
    signedDate: r.signed_date,
    expiresOn: r.expires_on,
    row: r,
  }))
  const cf = currentForm(records)

  // Only the warnings that touch THIS partner, plus the fund-wide ones. A partner should not be
  // handed another partner's tie-out variance.
  const warnings = (((pkg as any).warnings ?? []) as { detail: string; lpEntityId?: string }[])
    .filter(w => !w.lpEntityId || w.lpEntityId === lpEntityId)
    .map(w => w.detail)

  const p = partner as any
  const pdf = await generateK1Pdf({
    fundName: fund?.name ?? 'Fund',
    fundLogo: null,
    fundAddress: null,
    vehicle: (vehicle as any)?.name ?? 'Vehicle',
    taxYear: (pkg as any).tax_year,
    version: (pkg as any).version,
    status: (pkg as any).status,
    partnerName: (entity as any)?.entity_name ?? lpEntityId,
    legalName: cf?.row?.legal_name ?? null,
    tinLast4: cf?.row?.tin_last4 ?? null,
    formType: p.form_type ?? null,
    lines: lineMap,
    capitalAccount: {
      beginning: Number(p.beginning_capital),
      contributions: Number(p.contributions),
      distributions: Number(p.distributions),
      netIncome: Number(p.net_income),
      ending: Number(p.ending_capital),
    },
    notes: warnings,
  })

  const filename = `k1-${(pkg as any).tax_year}-v${(pkg as any).version}`.replace(/[^a-zA-Z0-9\-]/g, '-')
  return new NextResponse(pdf as any, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}.pdf"`,
    },
  })
}
