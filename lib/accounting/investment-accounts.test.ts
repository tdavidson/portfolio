import { describe, it, expect } from 'vitest'
import { isInvestmentAccount, isPooledInvestmentAccount, investmentKind, loadVehicleChart } from './investment-accounts'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const acct = (type: string, subtype: string | null, companyId: string | null = null) => ({ type, subtype, companyId })

describe('isInvestmentAccount', () => {
  it('per-company cost, unrealized, FX and realized gain are investment accounts', () => {
    expect(isInvestmentAccount(acct('asset', 'investment', 'c'))).toBe(true)
    expect(isInvestmentAccount(acct('asset', 'unrealized', 'c'))).toBe(true)
    expect(isInvestmentAccount(acct('asset', 'fx_translation', 'c'))).toBe(true)
    expect(isInvestmentAccount(acct('income', 'realized_gain', 'c'))).toBe(true)
  })
  it('pooled 1100/1200/1250 are investment accounts, and pooled', () => {
    expect(isInvestmentAccount(acct('asset', 'investment'))).toBe(true)
    expect(isPooledInvestmentAccount(acct('asset', 'unrealized'))).toBe(true)
    expect(isPooledInvestmentAccount(acct('asset', 'investment', 'c'))).toBe(false)
  })
  it('pooled 4200/4300 share the subtypes but are income, so they are not', () => {
    expect(isInvestmentAccount(acct('income', 'unrealized'))).toBe(false)
    expect(isInvestmentAccount(acct('income', 'fx_translation'))).toBe(false)
  })
  it('pooled 4000, accrued note interest and a manco receivable are not', () => {
    expect(isInvestmentAccount(acct('income', 'realized_gain'))).toBe(false)
    expect(isInvestmentAccount(acct('asset', 'accrued_interest', 'c'))).toBe(false)
    expect(isInvestmentAccount(acct('asset', 'receivable'))).toBe(false)
  })
  it('names the kind of each', () => {
    expect(investmentKind(acct('asset', 'investment', 'c'))).toBe('cost')
    expect(investmentKind(acct('asset', 'unrealized', 'c'))).toBe('unrealized')
    expect(investmentKind(acct('asset', 'fx_translation', 'c'))).toBe('fx')
    expect(investmentKind(acct('income', 'realized_gain', 'c'))).toBe('realized')
    expect(investmentKind(acct('income', 'unrealized'))).toBeNull()
  })
})

describe('loadVehicleChart', () => {
  it("reads one vehicle's chart in the reader's shape", async () => {
    const { admin } = memoryAdmin({ chart_of_accounts: [
      { id: 'a1', fund_id: 'f', vehicle_id: 'v', code: '1100-ab', type: 'asset', subtype: 'investment', company_id: 'c' },
      { id: 'a2', fund_id: 'f', vehicle_id: 'other', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
    ] })
    expect(await loadVehicleChart(admin, 'f', 'v')).toEqual([{ id: 'a1', code: '1100-ab', type: 'asset', subtype: 'investment', companyId: 'c' }])
  })

  it('throws on query error', async () => {
    const fakeAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                range: async () => ({ data: null, error: { message: 'boom' } })
              })
            })
          })
        })
      })
    }
    await expect(loadVehicleChart(fakeAdmin as any, 'f', 'v')).rejects.toThrow('Could not read the chart of accounts: boom')
  })

  it('pages through all rows when chart has more than 1000 entries', async () => {
    let callCount = 0
    const fakeAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                range: async (from: number, to: number) => {
                  callCount++
                  if (callCount === 1) {
                    // First call: return 1000 rows (fills the page)
                    const rows = Array.from({ length: 1000 }, (_, i) => ({
                      id: `a${i}`,
                      fund_id: 'f',
                      vehicle_id: 'v',
                      code: `1100-${i}`,
                      type: 'asset',
                      subtype: 'investment',
                      company_id: 'c'
                    }))
                    return { data: rows, error: null }
                  } else if (callCount === 2) {
                    // Second call: return 1 row (incomplete page, signals end)
                    return {
                      data: [{
                        id: 'a1000',
                        fund_id: 'f',
                        vehicle_id: 'v',
                        code: '1100-1000',
                        type: 'asset',
                        subtype: 'investment',
                        company_id: 'c'
                      }],
                      error: null
                    }
                  }
                  return { data: [], error: null }
                }
              })
            })
          })
        })
      })
    }
    const result = await loadVehicleChart(fakeAdmin as any, 'f', 'v')
    expect(result).toHaveLength(1001)
    expect(result[0].id).toBe('a0')
    expect(result[1000].id).toBe('a1000')
  })
})
