import { describe, it, expect } from 'vitest'
import { seedCompanyFromDefaults, applyDefaultsToAllCompanies } from './seed-default-metrics'

/**
 * A minimal stand-in for the supabase query builder covering only the calls the seeder makes:
 *   .from('default_metrics').select(..).eq(..).eq(..).order(..)          → templates
 *   .from('metrics').select('slug').eq('company_id', ..)                 → existing slugs
 *   .from('metrics').insert(rows)                                        → capture rows
 *   .from('default_metric_exclusions').select(..).eq('company_id', ..)  → excluded default ids
 *   .from('companies').select('id').eq('fund_id', ..)                    → company ids
 */
function makeClient(opts: {
  templates: any[]
  existingByCompany: Record<string, string[]>
  excludedByCompany?: Record<string, string[]>
  companies?: string[]
}) {
  const inserted: any[] = []

  function builder(table: string) {
    const state: any = { table, filters: {} as Record<string, unknown> }
    const chain: any = {
      select(_cols?: string) { return chain },
      eq(col: string, val: unknown) { state.filters[col] = val; return chain },
      order() { return chain },
      insert(rows: any[]) {
        inserted.push(...rows)
        return Promise.resolve({ data: rows, error: null })
      },
      then(resolve: (v: any) => void) {
        if (table === 'default_metrics') return resolve({ data: opts.templates, error: null })
        if (table === 'companies') return resolve({ data: (opts.companies ?? []).map(id => ({ id })), error: null })
        if (table === 'metrics') {
          const companyId = state.filters['company_id'] as string
          const slugs = opts.existingByCompany[companyId] ?? []
          return resolve({ data: slugs.map(slug => ({ slug })), error: null })
        }
        if (table === 'default_metric_exclusions') {
          const companyId = state.filters['company_id'] as string
          const ids = (opts.excludedByCompany ?? {})[companyId] ?? []
          return resolve({ data: ids.map(default_metric_id => ({ default_metric_id })), error: null })
        }
        return resolve({ data: [], error: null })
      },
    }
    return chain
  }

  const client: any = { from: (table: string) => builder(table) }
  return { client, inserted }
}

const T = (slug: string, name = slug) => ({
  id: `dm-${slug}`, name, slug, description: null, unit: null, unit_position: 'suffix',
  value_type: 'number', reporting_cadence: 'quarterly', display_order: 0, currency: null,
})

describe('seedCompanyFromDefaults', () => {
  it('inserts only templates the company does not already have (dedup by slug)', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr'), T('headcount')],
      existingByCompany: { 'co-1': ['cash'] }, // company already tracks cash
    })

    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')

    expect(count).toBe(2)
    expect(inserted.map(r => r.slug).sort()).toEqual(['arr', 'headcount'])
    // never re-inserts the existing slug
    expect(inserted.some(r => r.slug === 'cash')).toBe(false)
    // stamps tenancy from the arguments, not the request
    expect(inserted.every(r => r.fund_id === 'fund-1' && r.company_id === 'co-1')).toBe(true)
  })

  it('is a no-op when the company already has every default', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: { 'co-1': ['cash', 'arr'] },
    })
    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')
    expect(count).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('skips defaults the company has opted out of (exclusions)', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr'), T('headcount')],
      existingByCompany: { 'co-1': [] },
      excludedByCompany: { 'co-1': ['dm-arr'] }, // opted out of ARR
    })

    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')

    expect(count).toBe(2)
    expect(inserted.map(r => r.slug).sort()).toEqual(['cash', 'headcount'])
    expect(inserted.some(r => r.slug === 'arr')).toBe(false)
  })

  it('is a no-op when the fund has no default metrics', async () => {
    const { client, inserted } = makeClient({ templates: [], existingByCompany: {} })
    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')
    expect(count).toBe(0)
    expect(inserted).toHaveLength(0)
  })
})

describe('applyDefaultsToAllCompanies', () => {
  it('seeds each company independently, deduping per company', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: { 'co-1': ['cash'], 'co-2': [] }, // co-2 has none
      companies: ['co-1', 'co-2'],
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res.companies).toBe(2)
    expect(res.inserted).toBe(3) // co-1: arr; co-2: cash + arr
    expect(inserted.filter(r => r.company_id === 'co-1').map(r => r.slug)).toEqual(['arr'])
    expect(inserted.filter(r => r.company_id === 'co-2').map(r => r.slug).sort()).toEqual(['arr', 'cash'])
  })
})
