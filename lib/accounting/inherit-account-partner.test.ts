import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { inheritAccountPartner } from './persist'

const chart = [
  { id: 'jane', fund_id: 'f', vehicle_id: 'v', code: '3100-a', subtype: 'lp_capital', lp_entity_id: 'lp-jane' },
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', subtype: 'cash', lp_entity_id: null },
]

describe('inheritAccountPartner', () => {
  it("gives a line on a partner's own capital account that partner, and leaves the rest alone", async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const out = await inheritAccountPartner(m.admin, 'f', 'v', [
      { accountId: 'cash', amount: 100 },
      { accountId: 'jane', amount: -60 },
      { accountId: 'jane', amount: -40, lpEntityId: 'lp-other' },
    ])
    expect(out.map(p => p.lpEntityId ?? null)).toEqual([null, 'lp-jane', 'lp-other'])
  })
})
