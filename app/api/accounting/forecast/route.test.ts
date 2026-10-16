import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const m = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('@/lib/forecast/http', () => ({ forecastRequest: async (_req: unknown, _need: unknown, run: (ctx: unknown, vehicle: string) => Promise<unknown>) => NextResponse.json(await run({ fundId: 'synthetic-fund' }, 'Synthetic vehicle')), readJson: vi.fn() }))
vi.mock('@/lib/forecast/service', () => ({ listPlans: m.list, getPlan: m.detail, createPlan: vi.fn() }))
import { GET } from './route'
beforeEach(() => { vi.clearAllMocks(); m.list.mockResolvedValue({ plans: [{ id: 'plan-a' }] }); m.detail.mockResolvedValue({ plan: { id: 'plan-a' } }) })
it('bundles the default plan only when requested', async () => {
  const response = await GET(new NextRequest('https://synthetic.invalid/api/accounting/forecast?initial=1'))
  expect(m.detail).toHaveBeenCalledWith({ fundId: 'synthetic-fund' }, { vehicle: 'Synthetic vehicle', planId: 'plan-a' })
  expect((await response.json()).initialPlan.plan.id).toBe('plan-a')
})
it('keeps existing list requests lightweight', async () => {
  await GET(new NextRequest('https://synthetic.invalid/api/accounting/forecast'))
  expect(m.detail).not.toHaveBeenCalled()
})
it('returns no default detail for an empty list', async () => {
  m.list.mockResolvedValue({ plans: [] })
  expect((await (await GET(new NextRequest('https://synthetic.invalid/api/accounting/forecast?initial=1'))).json()).initialPlan).toBeNull()
  expect(m.detail).not.toHaveBeenCalled()
})
