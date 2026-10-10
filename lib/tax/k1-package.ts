// Generating, finalizing and amending a K-1 package.
//
// The numbers come from lib/accounting/k1-load.ts and k1-allocation.ts. This is the lifecycle
// around them: a draft that recomputes freely, a final that is frozen, and an amendment that is a
// new version rather than an edit.
//
// WHERE THE GATE SITS. Draft generation computes whatever the books allow, including for partners
// whose tax form is missing or lapsed — you cannot fix a gap you cannot see. FINALIZATION is what
// refuses. That is the seam: the draft is a diagnostic, the final is an assertion.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadK1Year } from '@/lib/accounting/k1-load'
import { allocateK1, capitalAccountFoots, K1_CATEGORIES } from '@/lib/accounting/k1-allocation'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { currentForm, formStanding, partnerFormStatus, type TaxFormRecord } from './forms'

export type K1PackageStatus = 'draft' | 'final' | 'superseded'

export interface K1PackageWarning {
  kind: 'not_derivable' | 'undetermined_gain' | 'tie_out' | 'roll_forward' | 'tax_form' | 'unallocated' | 'book_basis' | 'stale'
  detail: string
  lpEntityId?: string
}

export interface GeneratedPackage {
  packageId: string
  version: number
  status: K1PackageStatus
  taxYear: number
  partnerCount: number
  warnings: K1PackageWarning[]
  /** Warnings that would refuse finalization. A draft carries them; a final cannot. */
  blockers: K1PackageWarning[]
}

/** Warning kinds that stop a package being issued. */
const BLOCKING_KINDS: K1PackageWarning['kind'][] = ['tax_form', 'roll_forward', 'book_basis', 'stale']

export function blockersIn(warnings: K1PackageWarning[]): K1PackageWarning[] {
  return warnings.filter(w => BLOCKING_KINDS.includes(w.kind))
}

/**
 * Which warnings refuse an issuance, and which merely accompany one.
 *
 * A missing or lapsed tax form blocks: the K-1 would carry no certified identification, which is
 * the problem this whole chain exists to avoid. A capital account that does not foot blocks too —
 * item L is an assertion about the partner's basis, and one that does not add up is not a
 * disclosure, it is an error.
 *
 * A tie-out variance does NOT block. It means the fund's character does not cover every dollar
 * the close allocated, which is a real thing that happens — uncharacterised distributions, income
 * the ledger holds but nobody classified — and reporting it beside the K-1 is more useful than
 * refusing to produce one. The same goes for gain that no lot method could date.
 */
export async function generateK1Package(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  taxYear: number,
): Promise<GeneratedPackage | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const inputs = await loadK1Year(admin, fundId, group, taxYear)
  if ('error' in inputs) return inputs

  const allocation = allocateK1({ fund: inputs.fund, partners: inputs.partners })
  const forms = await loadFormsByEntity(admin, fundId)

  const warnings: K1PackageWarning[] = []
  for (const n of inputs.notDerivable) {
    warnings.push({ kind: 'not_derivable', detail: `${n.line}: ${n.reason}` })
  }
  if (inputs.undeterminedGain !== 0) {
    warnings.push({
      kind: 'undetermined_gain',
      detail: `${inputs.undeterminedGain.toFixed(2)} of realized gain could not be dated short or long term.`,
    })
  }
  for (const [category, amount] of Object.entries(allocation.unallocated)) {
    warnings.push({
      kind: 'unallocated',
      detail: `${category}: ${Number(amount).toFixed(2)} had no partner bucket to follow and is on no K-1.`,
    })
  }

  // The tax year ends on 31 December, and that is the date a form has to have been good on.
  const asOf = `${taxYear}-12-31`

  for (const p of allocation.partners) {
    const partnerForms = forms.get(p.lpEntityId) ?? []
    const status = partnerFormStatus(p.lpEntityId, partnerForms, asOf)
    if (status.blocker) {
      warnings.push({ kind: 'tax_form', detail: status.blocker, lpEntityId: p.lpEntityId })
    }
    if (p.tieOut.variance !== 0) {
      warnings.push({
        kind: 'tie_out',
        detail: `Lines total ${p.tieOut.computed.toFixed(2)} against ${p.tieOut.fromCapital.toFixed(2)} of allocated activity.`,
        lpEntityId: p.lpEntityId,
      })
    }
    // Appreciation still in tax capital means the year's book-to-tax adjustments were not posted
    // (or the books moved after they were): Item L would report book capital as tax capital.
    if (Math.abs(p.capitalAccount.unrealized) >= 0.01) {
      warnings.push({
        kind: 'book_basis',
        detail: `${p.capitalAccount.unrealized.toFixed(2)} of unrealized appreciation or currency translation is still in this partner's tax capital. Post the ${taxYear} book-to-tax adjustments, then regenerate.`,
        lpEntityId: p.lpEntityId,
      })
    }
    const foots = capitalAccountFoots(p)
    if (foots.variance !== 0) {
      warnings.push({
        kind: 'roll_forward',
        detail: `Item L does not foot: ${foots.actual.toFixed(2)} ending against ${foots.expected.toFixed(2)} expected.`,
        lpEntityId: p.lpEntityId,
      })
    }
  }

  // A draft regenerates in place. Finding the LATEST version rather than version 1: once an
  // amendment exists, regenerating means redoing the amendment, not resurrecting the original.
  const { data: existing } = await admin
    .from('k1_packages' as any)
    .select('id, version, status')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('tax_year', taxYear)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  const prior = existing as any
  if (prior && prior.status !== 'draft') {
    return {
      error:
        `The ${taxYear} package (v${prior.version}) is ${prior.status}. Amend it to create v${prior.version + 1} ` +
        'rather than regenerating over an issued package.',
    }
  }

  let packageId: string
  const version = prior?.version ?? 1
  if (prior) {
    packageId = prior.id
    await admin
      .from('k1_packages' as any)
      .update({ fund_character: inputs.fund, warnings, updated_at: new Date().toISOString() })
      .eq('id', packageId)
    // Children are rewritten rather than diffed: a partner who left the vehicle should not
    // linger in a regenerated package because nothing thought to remove them.
    await admin.from('k1_lines' as any).delete().eq('package_id', packageId)
    await admin.from('k1_partners' as any).delete().eq('package_id', packageId)
  } else {
    const { data: created, error } = await admin
      .from('k1_packages' as any)
      .insert({
        fund_id: fundId,
        vehicle_id: vehicleId,
        tax_year: taxYear,
        version,
        status: 'draft',
        fund_character: inputs.fund,
        warnings,
        created_by: userId,
      })
      .select('id')
      .single()
    if (error) return { error: error.message }
    packageId = (created as any).id
  }

  const partnerRows = allocation.partners.map(p => {
    const partnerForms = forms.get(p.lpEntityId) ?? []
    const cf = currentForm(partnerForms)
    const foots = capitalAccountFoots(p)
    return {
      package_id: packageId,
      fund_id: fundId,
      lp_entity_id: p.lpEntityId,
      beginning_capital: p.capitalAccount.beginning,
      contributions: p.capitalAccount.contributions,
      distributions: p.capitalAccount.distributions,
      net_income: p.capitalAccount.netIncome,
      other_changes: p.capitalAccount.otherChanges,
      ending_capital: p.capitalAccount.ending,
      tie_out_variance: p.tieOut.variance,
      roll_forward_variance: foots.variance,
      form_type: cf?.formType ?? null,
      form_standing: formStanding(cf, asOf),
    }
  })
  if (partnerRows.length > 0) {
    const { error } = await admin.from('k1_partners' as any).insert(partnerRows)
    if (error) return { error: error.message }
  }

  const lineRows = allocation.partners.flatMap(p =>
    K1_CATEGORIES.filter(c => p.lines[c] !== 0).map(c => ({
      package_id: packageId,
      fund_id: fundId,
      lp_entity_id: p.lpEntityId,
      category: c,
      amount: p.lines[c],
    })),
  )
  if (lineRows.length > 0) {
    const { error } = await admin.from('k1_lines' as any).insert(lineRows)
    if (error) return { error: error.message }
  }

  return {
    packageId,
    version,
    status: 'draft',
    taxYear,
    partnerCount: allocation.partners.length,
    warnings,
    blockers: blockersIn(warnings),
  }
}

/**
 * Issue the package.
 *
 * Refuses on blockers rather than warning about them: after this the numbers are frozen and a
 * partner has been told. The database enforces the freeze too — a final package rejects updates —
 * so this check is the friendlier of the two, not the only one.
 */
export async function finalizeK1Package(
  admin: SupabaseClient,
  fundId: string,
  packageId: string,
  userId: string | null,
): Promise<{ ok: true } | { error: string; blockers?: K1PackageWarning[] }> {
  const { data } = await admin
    .from('k1_packages' as any)
    .select('id, status, warnings, tax_year, vehicle_id')
    .eq('fund_id', fundId)
    .eq('id', packageId)
    .maybeSingle()
  const pkg = data as any
  if (!pkg) return { error: 'Package not found' }
  if (pkg.status !== 'draft') return { error: `This package is already ${pkg.status}.` }

  // The draft is a snapshot of the books when it was generated. Issuing it asserts it still is —
  // so recompute and compare, and refuse if a posting, a close or a tax adjustment has moved any
  // partner's figures since.
  const stale = await staleAgainstBooks(admin, fundId, pkg)
  if (stale.length > 0) {
    return {
      error: `The books have changed since this draft was generated. Regenerate the ${pkg.tax_year} package, review it, then issue.`,
      blockers: stale,
    }
  }

  const blockers = blockersIn((pkg.warnings ?? []) as K1PackageWarning[])
  if (blockers.length > 0) {
    return {
      error:
        `${blockers.length} issue${blockers.length === 1 ? '' : 's'} must be resolved before the ` +
        `${pkg.tax_year} package can be issued.`,
      blockers,
    }
  }

  const { error } = await admin
    .from('k1_packages' as any)
    .update({ status: 'final', finalized_at: new Date().toISOString(), finalized_by: userId })
    .eq('id', packageId)
  if (error) return { error: error.message }
  return { ok: true }
}

/**
 * Amend an issued package: supersede it and start the next version as a draft.
 *
 * The old version is kept. A partner filed on it, and "what did we tell them in March" has to
 * remain answerable after the amendment exists.
 */
export async function amendK1Package(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  taxYear: number,
): Promise<GeneratedPackage | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const { data } = await admin
    .from('k1_packages' as any)
    .select('id, version, status')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('tax_year', taxYear)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const prior = data as any
  if (!prior) return { error: `No ${taxYear} package to amend.` }
  if (prior.status === 'draft') return { error: 'That package is still a draft — regenerate it instead of amending.' }

  const { error: supErr } = await admin
    .from('k1_packages' as any)
    .update({ status: 'superseded' })
    .eq('id', prior.id)
  if (supErr) return { error: supErr.message }

  const { data: created, error } = await admin
    .from('k1_packages' as any)
    .insert({
      fund_id: fundId,
      vehicle_id: vehicleId,
      tax_year: taxYear,
      version: prior.version + 1,
      status: 'draft',
      created_by: userId,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }

  // The new version is empty until generated, so populate it immediately — an amendment nobody
  // filled in would look like a package that lost all its partners.
  void created
  return generateK1Package(admin, fundId, group, userId, taxYear)
}

/** Partners whose figures in the draft no longer match a fresh computation from the books. */
async function staleAgainstBooks(admin: SupabaseClient, fundId: string, pkg: any): Promise<K1PackageWarning[]> {
  const { data: vehicle } = await admin.from('fund_vehicles' as any).select('name').eq('id', pkg.vehicle_id).eq('fund_id', fundId).maybeSingle()
  const group = (vehicle as any)?.name as string | undefined
  if (!group) return [{ kind: 'stale', detail: 'The vehicle this package belongs to could not be found.' }]
  const inputs = await loadK1Year(admin, fundId, group, Number(pkg.tax_year))
  if ('error' in inputs) return [{ kind: 'stale', detail: inputs.error }]
  const fresh = allocateK1({ fund: inputs.fund, partners: inputs.partners })

  const [{ data: storedPartners }, { data: storedLines }] = await Promise.all([
    admin.from('k1_partners' as any).select('lp_entity_id, beginning_capital, contributions, distributions, net_income, ending_capital').eq('fund_id', fundId).eq('package_id', pkg.id),
    admin.from('k1_lines' as any).select('lp_entity_id, category, amount').eq('fund_id', fundId).eq('package_id', pkg.id),
  ])
  const linesOf = new Map<string, Map<string, number>>()
  for (const l of ((storedLines as any[]) ?? [])) {
    const m = linesOf.get(l.lp_entity_id) ?? new Map<string, number>()
    m.set(l.category, Number(l.amount))
    linesOf.set(l.lp_entity_id, m)
  }
  const storedById = new Map(((storedPartners as any[]) ?? []).map(p => [p.lp_entity_id as string, p]))
  const differs = (a: number, b: number) => Math.abs(a - b) >= 0.01
  const out: K1PackageWarning[] = []
  for (const p of fresh.partners) {
    const s = storedById.get(p.lpEntityId)
    storedById.delete(p.lpEntityId)
    const c = p.capitalAccount
    const moved = !s
      || differs(c.beginning, Number(s.beginning_capital)) || differs(c.contributions, Number(s.contributions))
      || differs(c.distributions, Number(s.distributions)) || differs(c.netIncome, Number(s.net_income))
      || differs(c.ending, Number(s.ending_capital))
      || K1_CATEGORIES.some(cat => differs(p.lines[cat] ?? 0, linesOf.get(p.lpEntityId)?.get(cat) ?? 0))
    if (moved) out.push({ kind: 'stale', detail: s ? 'Figures differ from the books as they now stand.' : 'A partner with activity this year is not in the draft.', lpEntityId: p.lpEntityId })
  }
  for (const id of storedById.keys()) out.push({ kind: 'stale', detail: 'In the draft, but no longer has activity on the books for this year.', lpEntityId: id })
  return out
}

async function loadFormsByEntity(
  admin: SupabaseClient,
  fundId: string,
): Promise<Map<string, TaxFormRecord[]>> {
  const { data } = await admin
    .from('lp_tax_forms' as any)
    .select('lp_entity_id, form_type, signed_date, expires_on, subject_to_backup_withholding')
    .eq('fund_id', fundId)
  const out = new Map<string, TaxFormRecord[]>()
  for (const r of ((data as any[]) ?? [])) {
    const list = out.get(r.lp_entity_id) ?? []
    list.push({
      formType: r.form_type,
      signedDate: r.signed_date,
      expiresOn: r.expires_on,
      subjectToBackupWithholding: r.subject_to_backup_withholding,
    })
    out.set(r.lp_entity_id, list)
  }
  return out
}
