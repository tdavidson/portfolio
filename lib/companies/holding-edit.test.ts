import { describe, expect, it } from 'vitest'
import { companyChangeFromInput, planCompanyChange } from './holding-edit'

/** A companies table holding one row, enough for planCompanyChange's single read. */
function fakeAdmin(row: Record<string, unknown>) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
  }
  return { from: () => query } as any
}

const company = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Acme', status: 'active', holding_type: 'company', portfolio_group: [], aliases: [],
  metrics_enabled: true, analyst_enabled: true, price_feed_enabled: false, ...extra,
})
const who = { fundId: 'f1', vehicleNames: null }

describe('page section settings through update_company', () => {
  it('reads the switches from the tool input, text "true"/"false" included', () => {
    expect(companyChangeFromInput({ metrics_enabled: false, analyst_enabled: 'true', price_feed_enabled: true }))
      .toMatchObject({ metricsEnabled: false, analystEnabled: true, priceFeedEnabled: true })
    expect(companyChangeFromInput({ name: 'Acme' })).not.toHaveProperty('metricsEnabled')
  })

  it('plans only the switches that change', async () => {
    const out = await planCompanyChange(fakeAdmin(company()), who, 'c1', { metricsEnabled: false, analystEnabled: true })
    expect(out.ok && out.value.updates).toEqual({ metrics_enabled: false })
  })

  it('refuses a value that is not true or false', async () => {
    const out = await planCompanyChange(fakeAdmin(company()), who, 'c1', { analystEnabled: 'maybe' as any })
    expect(out.ok).toBe(false)
  })

  it('refuses a price feed on a fund holding', async () => {
    const out = await planCompanyChange(fakeAdmin(company({ holding_type: 'fund' })), who, 'c1', { priceFeedEnabled: true })
    expect(out.ok).toBe(false)
  })
})
