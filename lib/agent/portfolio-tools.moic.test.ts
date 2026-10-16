import { describe, it, expect } from 'vitest'
import { PORTFOLIO_HANDLERS } from './portfolio-tools'

// A partial exit: 100 invested, the slice that cost 60 sold for 300, the rest (cost 40) marked
// up by 160 to 200. Gross multiple = (300 realized + 200 held) / 100 invested = 5.0x. Dividing by
// the 40 still held instead (12.5x) is the bug this pins: one holding showed a different,
// inflated multiple on the schedule and on its own page.
const companies = [{ id: 'c1', name: 'Acme', fund_id: 'f1', status: 'active', holding_type: 'company', portfolio_group: ['Fund I'] }]
const txns = [
  { company_id: 'c1', fund_id: 'f1', transaction_type: 'investment', round_name: 'Seed', transaction_date: '2020-01-01', investment_cost: 100, shares_acquired: 100, portfolio_group: 'Fund I' },
  { company_id: 'c1', fund_id: 'f1', transaction_type: 'proceeds', round_name: 'Seed', transaction_date: '2022-01-01', cost_basis_exited: 60, proceeds_received: 300, portfolio_group: 'Fund I' },
  { company_id: 'c1', fund_id: 'f1', transaction_type: 'unrealized_gain_change', round_name: 'Seed', transaction_date: '2022-01-01', unrealized_value_change: 160, portfolio_group: 'Fund I' },
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

describe('portfolio_summary — gross multiple', () => {
  it('divides realized plus held value by everything invested, not by the cost still held', async () => {
    const out: any = await PORTFOLIO_HANDLERS.portfolio_summary({ admin: admin(), fundId: 'f1', portfolioGroup: '', userId: 'u1', access: everyEntity }, {})
    const [p] = out.positions
    expect(p).toMatchObject({ invested: 100, cost: 40, fairValue: 200, unrealized: 160, realized: 300, moic: 5 })
    expect(out.totals).toMatchObject({ invested: 100, cost: 40, grossMoic: 5 })
  })
})
