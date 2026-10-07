import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { assertReadAccess } from '@/lib/api-helpers'
import { currentForm, type TaxFormRecord } from '@/lib/tax/forms'
import { buildStateWorklist, summarizeWorklist, type PartnerStateRow } from '@/lib/tax/state-worklist'
import { incomeTotal, emptyLines, type K1Category } from '@/lib/accounting/k1-allocation'
import { assertK1PackageVisible } from '@/lib/accounting/vehicle-visibility'

// Which states have partners, and how much was allocated to each.
//
// A worklist, not an answer. Composite-return eligibility, withholding rates and thresholds
// differ by state and change yearly; encoding them would produce something authoritative-looking
// and quietly stale. This reports what the books know and leaves the rules to whoever applies
// them.

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

  const packageId = req.nextUrl.searchParams.get('packageId')
  if (!packageId) return NextResponse.json({ error: 'packageId is required' }, { status: 400 })
  // A package is one entity's — it must be one of the caller's.
  const hiddenPackage = await assertK1PackageVisible(admin, gate, packageId)
  if (hiddenPackage) return hiddenPackage

  const { data: pkg } = await admin
    .from('k1_packages' as any)
    .select('id, tax_year, version')
    .eq('fund_id', gate.fundId)
    .eq('id', packageId)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

  const [{ data: partnerRows }, { data: lineRows }, { data: forms }, { data: profile }] = await Promise.all([
    admin.from('k1_partners' as any).select('lp_entity_id').eq('fund_id', gate.fundId).eq('package_id', packageId),
    admin.from('k1_lines' as any).select('lp_entity_id, category, amount').eq('fund_id', gate.fundId).eq('package_id', packageId),
    admin.from('lp_tax_forms' as any).select('lp_entity_id, form_type, signed_date, expires_on, state, country').eq('fund_id', gate.fundId),
    admin.from('fund_compliance_profile' as any).select('*').eq('fund_id', gate.fundId).maybeSingle(),
  ])

  const entityIds = ((partnerRows as any[]) ?? []).map(p => p.lp_entity_id)
  const { data: entities } = await admin
    .from('lp_entities' as any)
    .select('id, entity_name')
    .eq('fund_id', gate.fundId)
    .in('id', entityIds.length > 0 ? entityIds : ['00000000-0000-0000-0000-000000000000'])
  const nameById = new Map(((entities as any[]) ?? []).map(e => [e.id as string, e.entity_name as string]))

  // Allocated income per partner, from the package's own lines — the same figure the K-1 shows,
  // so a withholding calculation starts from what the partner was told.
  const linesByEntity = new Map<string, Record<K1Category, number>>()
  for (const l of ((lineRows as any[]) ?? [])) {
    const cur = linesByEntity.get(l.lp_entity_id) ?? emptyLines()
    cur[l.category as K1Category] = Number(l.amount)
    linesByEntity.set(l.lp_entity_id, cur)
  }

  const formsByEntity = new Map<string, any[]>()
  for (const f of ((forms as any[]) ?? [])) {
    const list = formsByEntity.get(f.lp_entity_id) ?? []
    list.push(f)
    formsByEntity.set(f.lp_entity_id, list)
  }

  const rows: PartnerStateRow[] = entityIds.map(id => {
    const records: (TaxFormRecord & { row: any })[] = (formsByEntity.get(id) ?? []).map(r => ({
      formType: r.form_type,
      signedDate: r.signed_date,
      expiresOn: r.expires_on,
      row: r,
    }))
    const cf = currentForm(records)
    return {
      lpEntityId: id,
      name: nameById.get(id) ?? id,
      state: cf?.row?.state ?? null,
      country: cf?.row?.country ?? null,
      allocatedIncome: incomeTotal(linesByEntity.get(id) ?? emptyLines()),
    }
  })

  // The fund's own state, when the compliance profile records one. Absent, nothing is marked
  // nonresident rather than guessing — a wrong home state puts every partner on a list.
  const homeState = (profile as any)?.state ?? null
  const worklist = buildStateWorklist(rows, homeState)

  return NextResponse.json({
    packageId,
    taxYear: (pkg as any).tax_year,
    version: (pkg as any).version,
    ...worklist,
    summary: summarizeWorklist(worklist),
  })
}
