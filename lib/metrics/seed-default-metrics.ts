import type { SupabaseClient } from '@supabase/supabase-js'
import { filterByCompany } from '@/lib/access/scope'

/**
 * The fund-wide "default metric profile". An admin defines these once (Settings → Portfolio →
 * Default metrics); they are TEMPLATES that get copied into every company's own `metrics` rows.
 *
 * Copying is always insert-if-not-exists by (company_id, slug) — the same key the `metrics` table
 * enforces with unique(company_id, slug) — so a company already tracking a slug (whether hand-added
 * or seeded earlier) is never given a duplicate. Templates are seed-only: editing or deleting a
 * default metric here does NOT touch metrics already copied into companies.
 */

const TEMPLATE_COLUMNS =
  'name, slug, description, unit, unit_position, value_type, reporting_cadence, display_order, currency'

type DefaultMetricTemplate = {
  id: string
  name: string
  slug: string
  description: string | null
  unit: string | null
  unit_position: string | null
  value_type: string | null
  reporting_cadence: string | null
  display_order: number | null
  currency: string | null
}

/** Map a default-metric template onto a company's `metrics` insert. */
function toMetricInsert(t: DefaultMetricTemplate, fundId: string, companyId: string) {
  return {
    company_id: companyId,
    fund_id: fundId,
    name: t.name,
    slug: t.slug,
    description: t.description ?? null,
    unit: t.unit ?? null,
    unit_position: t.unit_position ?? 'suffix',
    value_type: t.value_type ?? 'number',
    reporting_cadence: t.reporting_cadence ?? 'quarterly',
    display_order: t.display_order ?? 0,
    currency: t.currency ?? null,
    is_active: true,
  }
}

/**
 * Seed every active default metric into ONE company, skipping any slug the company already has.
 * Returns the number of metrics inserted. Used at company creation and by the fund-wide apply.
 *
 * `onlyIds` narrows the seed to a chosen subset. The Add-company modal lets you uncheck defaults
 * before the company exists and passes through the ones that stayed checked; pass undefined for
 * the normal "seed every active default" behaviour. An empty array seeds nothing.
 */
export async function seedCompanyFromDefaults(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  onlyIds?: string[]
): Promise<number> {
  const { data: templates } = await admin
    .from('default_metrics')
    .select(`id, ${TEMPLATE_COLUMNS}`)
    .eq('fund_id', fundId)
    .eq('is_active', true)
    .order('display_order')

  const all = (templates ?? []) as DefaultMetricTemplate[]
  const keep = onlyIds ? new Set(onlyIds) : null
  const list = keep ? all.filter(t => keep.has(t.id)) : all
  if (list.length === 0) return 0

  const [{ data: existing }, { data: exclusions }] = await Promise.all([
    admin.from('metrics').select('slug').eq('company_id', companyId),
    admin.from('default_metric_exclusions').select('default_metric_id').eq('company_id', companyId),
  ])

  const have = new Set(((existing ?? []) as { slug: string }[]).map(m => m.slug))
  const excluded = new Set(((exclusions ?? []) as { default_metric_id: string }[]).map(e => e.default_metric_id))
  const toInsert = list
    .filter(t => !have.has(t.slug) && !excluded.has(t.id))
    .map(t => toMetricInsert(t, fundId, companyId))

  if (toInsert.length === 0) return 0

  const { error } = await admin.from('metrics').insert(toInsert)
  if (error) {
    console.error('[seedCompanyFromDefaults] insert failed:', error.message)
    return 0
  }
  return toInsert.length
}

/**
 * Fan every active default metric out across ALL companies in the fund. Idempotent — a company
 * that already has a slug keeps its own row untouched. Returns the total metrics inserted.
 */
export async function applyDefaultsToAllCompanies(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's companies (null = all). Required: a scoped member syncs only theirs. */
  visibleCompanyIds: string[] | null,
): Promise<{ inserted: number; companies: number }> {
  const { data: companies } = await filterByCompany((admin as any)
    .from('companies')
    .select('id')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company'),   // fund holdings have their own surfaces
    visibleCompanyIds, { column: 'id' })

  const ids = ((companies ?? []) as { id: string }[]).map(c => c.id)
  let inserted = 0
  for (const companyId of ids) {
    inserted += await seedCompanyFromDefaults(admin, fundId, companyId)
  }
  return { inserted, companies: ids.length }
}
