import type { PageContext } from '@/lib/pages/context'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

export interface CompanyUpdatesPageData {
  companies: Array<{ id: string; name: string }>
}

export async function loadCompanyUpdatesPage({ admin, page }: PageContext): Promise<CompanyUpdatesPageData> {
  // The company filter offers only the caller's companies.
  const scope = await entityScopeFor(admin as any, page.access)
  const { data: companies } = await filterByCompany((admin as any)
    .from('companies')
    .select('id, name')
    .eq('fund_id', page.fundId)
    .eq('holding_type', 'company'), scope.companyIds, { column: 'id' })
    .order('name') as { data: Array<{ id: string; name: string }> | null }
  return { companies: companies ?? [] }
}
