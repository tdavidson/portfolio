import { describe, it, expect, vi } from 'vitest'

// The Portfolio page shows fund holdings beside the companies; portfolio_summary must too, with the
// schedule of investments' figures (the sheet the page's fund cards read).
const sheetCalls: { vehicles: string[]; opts: unknown }[] = []
vi.mock('@/lib/portfolio/sheet-load', () => ({
  loadPortfolioSheet: async (_admin: unknown, _fundId: string, vehicles: string[], opts: unknown) => {
    sheetCalls.push({ vehicles, opts })
    return {
      companies: [], crypto: [],
      funds: [
        { key: 'h1', companyId: 'h1', name: 'Example Fund II', kind: 'fund', vehicles: ['Fund I'], cost: 400, fairValue: 600, invested: 500, distributions: 150, moic: 1.5, commitment: 1000, called: 500, unfunded: 500, navAsOf: '2026-06-30' },
        // A holding the caller cannot see never reaches the output, even if the sheet carried it.
        { key: 'h2', companyId: 'h2', name: 'Hidden Fund', kind: 'fund', vehicles: ['Fund II'], cost: 1, fairValue: 1, invested: 1, distributions: 0, moic: 1, commitment: 1, called: 1, unfunded: 0, navAsOf: null },
      ],
    }
  },
}))

const { PORTFOLIO_HANDLERS } = await import('./portfolio-tools')

const companies = [
  { id: 'c1', name: 'Acme', fund_id: 'f1', status: 'active', holding_type: 'company', portfolio_group: ['Fund I'] },
  { id: 'h1', name: 'Example Fund II', fund_id: 'f1', status: 'active', holding_type: 'fund', portfolio_group: ['Fund I'] },
]
const txns = [
  { company_id: 'c1', fund_id: 'f1', transaction_type: 'investment', round_name: 'Seed', transaction_date: '2020-01-01', investment_cost: 100, shares_acquired: 100, portfolio_group: 'Fund I' },
]

function admin() {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = []
      const rows = () => (table === 'companies' ? companies : table === 'investment_transactions' ? txns : [])
        .filter(r => filters.every(f => f(r)))
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: any) => { filters.push(r => r[k] === v); return chain },
        then: (res: any) => res({ data: rows(), error: null }),
      }
      return chain
    },
  } as any
}

const everyEntity = { fundId: 'f1', role: 'admin', vehicles: { all: true, ids: [] } } as any

describe('portfolio_summary — fund holdings', () => {
  it('lists fund holdings beside companies, from the schedule of investments', async () => {
    const out: any = await PORTFOLIO_HANDLERS.portfolio_summary({ admin: admin(), fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyEntity }, {})
    expect(sheetCalls.at(-1)).toEqual({ vehicles: ['Fund I'], opts: {} })
    expect(out.positions.map((p: any) => [p.kind, p.company])).toEqual([
      ['fund', 'Example Fund II'],
      ['company', 'Acme'],
    ])
    expect(out.positions[0]).toMatchObject({ cost: 400, fairValue: 600, invested: 500, realized: 150, moic: 1.5, commitment: 1000, called: 500, unfunded: 500, navAsOf: '2026-06-30' })
    expect(out.totals).toMatchObject({ cost: 500, fairValue: 700 })
  })

  it('passes as_of through to the schedule', async () => {
    await PORTFOLIO_HANDLERS.portfolio_summary({ admin: admin(), fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyEntity }, { as_of: '2025-12-31' })
    expect(sheetCalls.at(-1)?.opts).toEqual({ asOf: '2025-12-31' })
  })
})
