import { describe, it, expect } from 'vitest'
import { scopeSearchParams, updateVisible } from './scope'

const params = (companyIds: string[] | null) => ({ fundId: 'f1', companyIds, query: 'runway' }) as any

describe('Company Updates — only the caller\'s companies', () => {
  it('a search naming no company covers only theirs', () => {
    expect(scopeSearchParams(params(null), ['c1', 'c2'])!.companyIds).toEqual(['c1', 'c2'])
  })
  it('a search naming companies keeps only theirs', () => {
    expect(scopeSearchParams(params(['c2', 'c9']), ['c1', 'c2'])!.companyIds).toEqual(['c2'])
  })
  it('nothing visible: null, so the route answers empty without searching', () => {
    expect(scopeSearchParams(params(['c9']), ['c1'])).toBeNull()
    expect(scopeSearchParams(params(null), [])).toBeNull()
  })
  it('unscoped: unchanged', () => {
    expect(scopeSearchParams(params(['c9']), null)!.companyIds).toEqual(['c9'])
  })
  it('an update is visible with its company', () => {
    expect(updateVisible({ company_id: 'c1' }, ['c1'])).toBe(true)
    expect(updateVisible({ company_id: 'c2' }, ['c1'])).toBe(false)
    expect(updateVisible({ company_id: null }, ['c1'])).toBe(false)
    expect(updateVisible({ company_id: 'c2' }, null)).toBe(true)
  })
})
