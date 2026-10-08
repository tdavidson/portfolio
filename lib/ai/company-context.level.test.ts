import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/company-updates/analyst', () => ({ buildRecentUpdatesBlock: async () => '' }))

import { buildCompanyContext } from './context-builder'

function admin(tables: string[]) {
  const q = (t: string): any => {
    tables.push(t)
    const result = { data: t === 'companies' ? { id: 'c1', name: 'Acme', fund_id: 'f1' } : [], error: null }
    const p: any = new Proxy({}, {
      get(_x, k) {
        if (k === 'then') return (res: any) => Promise.resolve({ data: t === 'companies' ? [] : [], error: null }).then(res)
        if (k === 'maybeSingle' || k === 'single') return async () => result
        return () => p
      },
    })
    return p
  }
  return { from: q } as any
}

const scope = { access: { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } }, vehicleNames: ['Fund I'], companyIds: ['c1'] } as any

describe('buildCompanyContext — company-level only (stored output shown to every entity)', () => {
  it('never reads positions, peers or notes', async () => {
    const tables: string[] = []
    const ctx = await buildCompanyContext(admin(tables), 'c1', { includeTeamNotes: true, scope, companyLevelOnly: true })
    expect(tables).not.toContain('investment_transactions')
    expect(tables).not.toContain('company_notes')
    expect(tables.filter(t => t === 'companies')).toHaveLength(1)   // the company itself, no peer list
    expect(ctx!.investmentBlock + ctx!.portfolioBlock + ctx!.teamNotesBlock).toBe('')
  })
  it('the Analyst\'s company context still reads them, scoped', async () => {
    const tables: string[] = []
    await buildCompanyContext(admin(tables), 'c1', { includeTeamNotes: true, scope })
    expect(tables).toContain('investment_transactions')
    expect(tables).toContain('company_notes')
  })
})
