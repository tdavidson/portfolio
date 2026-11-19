import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/mcp-client/connections', () => ({ getMcpServerForUser: vi.fn() }))
vi.mock('@/lib/mcp-client/tools', () => ({ callMcpTool: vi.fn() }))

import { cartaFigures, cartaQueries, parseCartaRows } from './carta'
import { cleanAdminFigures, type AdminFigures } from './figures'
import { positionsFromCsv } from './csv'

const FUND = '11111111-2222-3333-4444-555555555555'

describe('cartaQueries', () => {
  it('builds both queries for one fund and date', () => {
    const q = cartaQueries(FUND, '2026-06-30')
    expect(q.positions).toContain(`fund_id = '${FUND}'`)
    expect(q.positions).toContain(`month_end_date = '2026-06-30'`)
    expect(q.fund).toContain(`fund_uuid = '${FUND}'`)
  })
  it('lets nothing but a UUID and a date into the SQL', () => {
    expect(() => cartaQueries("x' or 1=1 --", '2026-06-30')).toThrow(/UUID/)
    expect(() => cartaQueries(FUND, "2026-06-30' --")).toThrow(/date/)
  })
})

describe('parseCartaRows', () => {
  const ndjson = 'total_rows: 2 | truncated: false\n\n{"PARTNER_UUID":"p-1","PARTNER_NAME":"Jane Doe"}\n{"PARTNER_UUID":"p-2","PARTNER_NAME":"Acme LLC"}'
  it('reads ndjson rows after the header, lower-casing columns', () => {
    expect(parseCartaRows(ndjson)).toEqual([{ partner_uuid: 'p-1', partner_name: 'Jane Doe' }, { partner_uuid: 'p-2', partner_name: 'Acme LLC' }])
  })
  it('unwraps a {"result": ...} reply', () => {
    expect(parseCartaRows(JSON.stringify({ result: ndjson }))).toHaveLength(2)
  })
})

describe('cartaFigures', () => {
  it('shapes a pull that cleans as stated, reading the IRR as a percent', () => {
    const input = cartaFigures('2026-06-30', [{
      partner_uuid: 'p-1', partner_name: 'Jane Doe', cumulative_total_commitment: '100000', cumulative_total_contributions: '50000',
      cumulative_total_distributions: '0', ending_total_nav: '60000',
    }], [{ net_lp_irr: 0.5, lp_tvpi: 1.2, lp_dpi: 0 }])
    const f = cleanAdminFigures(input) as AdminFigures
    expect(f.source).toBe('Carta')
    // 0.5 from Carta means 0.5%, not 50%.
    expect(f.fund.irr).toBeCloseTo(0.005)
    expect(f.positions[0]).toMatchObject({ externalId: 'p-1', paidIn: 50_000, nav: 60_000 })
  })
})

describe('positionsFromCsv', () => {
  it('reads the named columns and skips a total row', () => {
    const csv = 'Partner Name,Partner ID,Commitment,Paid-in Capital,Distributions,NAV\n"Doe, Jane",p-1,"100,000",50000,0,60000\nTotal,,100000,50000,0,60000\n'
    expect(positionsFromCsv(csv)).toEqual([{ name: 'Doe, Jane', external_id: 'p-1', commitment: '100,000', paid_in: '50000', distributions: '0', nav: '60000' }])
  })
  it('says which column is missing', () => {
    expect(positionsFromCsv('Name,Commitment\nJane,1\n')).toMatch(/paid-in, distributions, nav/)
  })
})
