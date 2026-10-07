import { describe, expect, it, vi } from 'vitest'

const getConstructionModel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/accounting/construction-service', () => ({ getConstructionModel }))

import { CONSTRUCTION_HANDLERS } from './construction-tools'

describe('portfolio_construction tool', () => {
  it('returns the canonical construction service result unchanged', async () => {
    const canonical = {
      vehicle: 'Fund II',
      vintageYear: 2024,
      ledgerAvailable: false,
      actuals: { committedCapital: 10_000_000 },
      assumptions: { feeAnnualRate: 0.02 },
      forecast: { capital: { remaining: 3_000_000 } },
      positions: [],
      warnings: ['Ledger unavailable'],
      asOf: '2026-09-02T12:00:00.000Z',
    }
    getConstructionModel.mockResolvedValue(canonical)
    const admin = {} as any

    const result = await CONSTRUCTION_HANDLERS.portfolio_construction(
      { admin, fundId: 'fund-1', portfolioGroup: '', userId: 'user-1', access: {} as any },
      { vehicle: 'Fund II' },
    )

    expect(getConstructionModel).toHaveBeenCalledWith(
      { admin, fundId: 'fund-1', access: expect.anything() },
      { vehicle: 'Fund II' },
    )
    expect(result).toBe(canonical)
  })

  it('requires an explicit vehicle', async () => {
    await expect(CONSTRUCTION_HANDLERS.portfolio_construction(
      { admin: {} as any, fundId: 'fund-1', portfolioGroup: '', userId: null, access: {} as any },
      {},
    )).rejects.toThrow(/vehicle is required/)
  })
})
