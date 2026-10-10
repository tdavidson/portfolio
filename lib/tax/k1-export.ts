import type { SupabaseClient } from '@supabase/supabase-js'
import type * as XLSX from 'xlsx'
import { emptyLines, type K1Category } from '@/lib/accounting/k1-allocation'
import { buildK1Workbook, type K1WorkbookPartner } from './k1-workbook'
import { currentForm, type TaxFormRecord } from './forms'

// Loading a stored K-1 package into its workbook — shared by the K-1 export route and the tax
// package, so the preparer's bundle carries the same file the K-1 page downloads.
//
// The CALLER is responsible for authorization: a package contains the carry, and both callers
// pass refuseWithoutCarryAccess before reaching here. See lib/tax/access.ts.

export interface K1PackageRow {
  id: string
  vehicle_id: string
  tax_year: number
  version: number
  status: string
  fund_character: unknown
  warnings: unknown
}

/** The latest FINAL package for a vehicle and year, or null. A draft is not a deliverable. */
export async function findFinalK1Package(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  taxYear: number,
): Promise<K1PackageRow | null> {
  const { data } = await admin
    .from('k1_packages' as any)
    .select('id, vehicle_id, tax_year, version, status, fund_character, warnings')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('tax_year', taxYear)
    .eq('status', 'final')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as K1PackageRow | null) ?? null
}

/** The workbook for a stored package, and the filename it downloads as. */
export async function buildK1WorkbookForPackage(
  admin: SupabaseClient,
  fundId: string,
  pkg: K1PackageRow,
): Promise<{ wb: XLSX.WorkBook; filename: string }> {
  const [{ data: partnerRows }, { data: lineRows }, { data: fund }, { data: vehicle }] = await Promise.all([
    admin.from('k1_partners' as any).select('*').eq('fund_id', fundId).eq('package_id', pkg.id),
    admin.from('k1_lines' as any).select('lp_entity_id, category, amount').eq('fund_id', fundId).eq('package_id', pkg.id),
    admin.from('funds').select('name').eq('id', fundId).maybeSingle() as unknown as Promise<{ data: { name: string } | null }>,
    admin.from('fund_vehicles' as any).select('name').eq('id', pkg.vehicle_id).maybeSingle(),
  ])

  const entityIds = ((partnerRows as any[]) ?? []).map(p => p.lp_entity_id)
  const [{ data: entities }, { data: forms }] = await Promise.all([
    admin.from('lp_entities' as any).select('id, entity_name').eq('fund_id', fundId).in('id', entityIds),
    admin
      .from('lp_tax_forms' as any)
      .select('lp_entity_id, form_type, signed_date, expires_on, legal_name, tin_type, tin_last4, country, tax_classification')
      .eq('fund_id', fundId)
      .in('lp_entity_id', entityIds.length > 0 ? entityIds : ['00000000-0000-0000-0000-000000000000']),
  ])

  const nameById = new Map(((entities as any[]) ?? []).map(e => [e.id as string, e.entity_name as string]))

  const formsByEntity = new Map<string, any[]>()
  for (const f of ((forms as any[]) ?? [])) {
    const list = formsByEntity.get(f.lp_entity_id) ?? []
    list.push(f)
    formsByEntity.set(f.lp_entity_id, list)
  }

  const linesByEntity = new Map<string, Record<K1Category, number>>()
  for (const l of ((lineRows as any[]) ?? [])) {
    const cur = linesByEntity.get(l.lp_entity_id) ?? emptyLines()
    cur[l.category as K1Category] = Number(l.amount)
    linesByEntity.set(l.lp_entity_id, cur)
  }

  const partners: K1WorkbookPartner[] = ((partnerRows as any[]) ?? []).map(p => {
    // The form details come from the CURRENT form rather than whichever row sorted first —
    // a partner who re-certified mid-year has more than one, and the K-1 carries the latest.
    const rows = formsByEntity.get(p.lp_entity_id) ?? []
    const records: (TaxFormRecord & { row: any })[] = rows.map(r => ({
      formType: r.form_type,
      signedDate: r.signed_date,
      expiresOn: r.expires_on,
      row: r,
    }))
    const cf = currentForm(records)
    return {
      lpEntityId: p.lp_entity_id,
      name: nameById.get(p.lp_entity_id) ?? p.lp_entity_id,
      legalName: cf?.row?.legal_name ?? null,
      // The package froze what the form looked like when it was built; that is what the export
      // should show, not what the form looks like today.
      formType: p.form_type ?? cf?.formType ?? null,
      formStanding: p.form_standing ?? null,
      tinType: cf?.row?.tin_type ?? null,
      tinLast4: cf?.row?.tin_last4 ?? null,
      country: cf?.row?.country ?? null,
      taxClassification: cf?.row?.tax_classification ?? null,
      lines: linesByEntity.get(p.lp_entity_id) ?? emptyLines(),
      capitalAccount: {
        beginning: Number(p.beginning_capital),
        contributions: Number(p.contributions),
        distributions: Number(p.distributions),
        netIncome: Number(p.net_income),
        otherChanges: Number(p.other_changes ?? 0),
        ending: Number(p.ending_capital),
      },
      tieOutVariance: Number(p.tie_out_variance),
      rollForwardVariance: Number(p.roll_forward_variance),
    }
  })

  const vehicleName = (vehicle as any)?.name ?? 'Vehicle'
  const wb = buildK1Workbook({
    fundName: fund?.name ?? 'Fund',
    vehicle: vehicleName,
    taxYear: pkg.tax_year,
    version: pkg.version,
    status: pkg.status,
    generatedAt: new Date().toISOString(),
    partners,
    fundCharacter: (pkg.fund_character as any) ?? null,
    warnings: ((pkg.warnings as any) ?? []) as { kind: string; detail: string }[],
  })

  const filename = `k1-${vehicleName}-${pkg.tax_year}-v${pkg.version}`.replace(/[^a-zA-Z0-9\-]/g, '-')
  return { wb, filename }
}
