import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getPlan: vi.fn(), savePlan: vi.fn(), publishPlan: vi.fn(), resolveVehicleWithAccess: vi.fn(), resolveVehicle: vi.fn() }))

vi.mock('@/lib/forecast/service', async orig => ({
  ...(await orig<typeof import('@/lib/forecast/service')>()),
  getPlan: mocks.getPlan,
  savePlan: mocks.savePlan,
  publishPlan: mocks.publishPlan,
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveVehicleWithAccess: mocks.resolveVehicleWithAccess }))
vi.mock('@/lib/accounting/vehicle-resolver', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-resolver')>()),
  resolveVehicle: mocks.resolveVehicle,
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'vid' }))

import { applyUpdate, describeUpdate, describePublish } from '@/lib/forecast/actions'
import { stagedTarget } from '@/lib/pending-actions/target'
import { getWriteAction } from '@/lib/pending-actions/registry'

const DETAIL = {
  plan: { id: 'p1', vehicle: 'Hemrock Management', name: '2027 budget', revision: 4 },
  accounts: [
    { id: 'a5210', code: '5210', name: 'Audit, tax and accounting fees', type: 'expense' },
    { id: 'a4000', code: '4000', name: 'Management fee income', type: 'income' },
  ],
  rules: [{ accountId: 'a5210', method: 'fixed', params: { amount: 1000 } }],
  overrides: [{ accountId: 'a4000', month: '2027-03', amount: 50 }],
  versions: [{ status: 'approved', versionNo: 1 }],
  cutoff: '2026-09',
  stale: false,
}

const ctx = { admin: {} as any, fundId: 'f1', userId: 'u1', access: {} as any }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getPlan.mockResolvedValue(DETAIL)
  mocks.savePlan.mockResolvedValue(DETAIL)
})

describe('forecast write actions', () => {
  it('maps account codes to ids and applies at the current revision unless one was named', async () => {
    await applyUpdate(ctx, {
      vehicle: 'Hemrock Management', planId: 'p1',
      rules: [{ account: '5210', method: 'recurring', params: { amount: 12000, everyMonths: 12, anchor: '2027-03' } }],
      overrides: [{ account: '4000', month: '2027-03', amount: null }],
    })
    expect(mocks.savePlan.mock.calls[0][1]).toMatchObject({
      planId: 'p1', expectedRevision: 4,
      rules: [{ accountId: 'a5210', method: 'recurring' }],
      overrides: [{ accountId: 'a4000', month: '2027-03', amount: null }],
    })
    await applyUpdate(ctx, { vehicle: 'Hemrock Management', planId: 'p1', expectedRevision: 2 })
    expect(mocks.savePlan.mock.calls[1][1].expectedRevision).toBe(2)
  })

  it('refuses an account that is not in the chart, at preview time', async () => {
    await expect(describeUpdate(ctx, { vehicle: 'X', planId: 'p1', rules: [{ account: '9999', method: 'fixed', params: {} }] }))
      .rejects.toThrow(/No income or expense account "9999"/)
  })

  it('previews before and after for the approver', async () => {
    const p = await describeUpdate(ctx, {
      vehicle: 'X', planId: 'p1',
      rules: [{ account: '5210', method: 'fixed', params: { amount: 2000 } }],
      overrides: [{ account: '4000', month: '2027-03', amount: 75 }],
    })
    expect(p.summary).toContain('1 rule')
    expect((p.details as any).rules[0]).toMatchObject({ account: '5210 Audit, tax and accounting fees', before: { params: { amount: 1000 } } })
    expect((p.details as any).overrides[0]).toMatchObject({ before: 50, after: 75 })
  })

  it('refuses to stage a second approved baseline', async () => {
    await expect(describePublish(ctx, { vehicle: 'X', planId: 'p1', status: 'approved' })).rejects.toThrow(/already has an approved baseline/)
  })
})

describe('staging a forecast action on a management company', () => {
  it('resolves through the grant-checking resolver, never the bare one', async () => {
    mocks.resolveVehicleWithAccess.mockResolvedValue({ name: 'Hemrock Management', kind: 'manco' })
    const t = await stagedTarget(ctx as any, getWriteAction('update_forecast_plan')!, { vehicle: 'hemrock management', planId: 'p1' })
    expect(t).toEqual({ input: { vehicle: 'Hemrock Management', planId: 'p1' }, vehicleId: 'vid' })
    expect(mocks.resolveVehicleWithAccess).toHaveBeenCalledWith(ctx.admin, ctx.access, 'hemrock management', 'read')
    expect(mocks.resolveVehicle).not.toHaveBeenCalled()
  })

  it('leaves every other action on the ordinary resolver', async () => {
    mocks.resolveVehicle.mockResolvedValue('Fund I')
    await stagedTarget(ctx as any, getWriteAction('update_portfolio_construction')!, { vehicle: 'Fund I' })
    expect(mocks.resolveVehicleWithAccess).not.toHaveBeenCalled()
  })
})

describe('create_forecast_plan (AI draft)', () => {
  it('previews every suggested rule with its evidence, marking the ones the Analyst adjusted', async () => {
    const svc = await import('@/lib/forecast/service')
    const spy = vi.spyOn(svc, 'suggestRules').mockResolvedValue({
      vehicle: 'Hemrock Management', closedThrough: '2026-09', history: { first: '2024-10', last: '2026-09' }, warnings: [],
      suggestions: [
        { accountId: 'a5210', code: '5210', name: 'Audit', type: 'expense', method: 'recurring', params: { amount: 12600, everyMonths: 12, anchor: '2026-03' }, confidence: 'high', evidence: 'Every year: 12,000 in Mar 2025, 12,600 in Mar 2026', warnings: [] },
        { accountId: 'a5000', code: '5000', name: 'Salaries', type: 'expense', method: 'run_rate', params: { window: 12 }, confidence: 'high', evidence: 'Steady', warnings: [] },
      ],
    } as any)
    const { describeCreate } = await import('@/lib/forecast/actions')
    const p = await describeCreate(ctx, {
      vehicle: 'Hemrock Management', kind: 'rolling_forecast', name: 'FY27', horizonMonths: 12,
      rules: [{ account: '5000', method: 'fixed', params: { amount: 90000 } }],
      explanation: 'Two hires in January',
    })
    expect(p.summary).toContain('2 account rules (1 adjusted)')
    expect((p.details as any).rules).toEqual([
      expect.objectContaining({ account: '5210 Audit', source: 'suggested', evidence: expect.stringContaining('Mar 2025') }),
      expect.objectContaining({ account: '5000 Salaries', source: 'adjusted', method: 'fixed' }),
    ])
    expect((p.details as any).explanation).toBe('Two hires in January')
    spy.mockRestore()
  })
})
