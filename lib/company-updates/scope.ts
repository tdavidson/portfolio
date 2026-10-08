// Company Updates belong to their company: a scoped member searches and opens only updates about
// companies linked to their entities. The search RPC is security definer and filters only on the
// company ids it is given, so the caller's set must always be passed. Null = every company.

/** The search, narrowed to the caller's companies — or null when none of theirs is in it. */
export function scopeSearchParams<P extends { companyIds?: string[] | null }>(params: P, visibleCompanyIds: string[] | null): P | null {
  if (visibleCompanyIds === null) return params
  const wanted = params.companyIds ?? null
  const companyIds = wanted === null ? visibleCompanyIds : wanted.filter(id => visibleCompanyIds.includes(id))
  return companyIds.length === 0 ? null : { ...params, companyIds }
}

export function updateVisible(update: { company_id: string | null }, visibleCompanyIds: string[] | null): boolean {
  return visibleCompanyIds === null || (!!update.company_id && visibleCompanyIds.includes(update.company_id))
}
