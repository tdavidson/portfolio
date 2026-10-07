import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertReadAccess: vi.fn(),
  loadAccessContext: vi.fn(),
  execute: vi.fn(),
  revalidateTag: vi.fn(),
  row: {} as Record<string, any>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser } }),
}))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: mocks.assertReadAccess }))
vi.mock('@/lib/access/effective', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/access/effective')>()
  return { ...original, loadAccessContext: mocks.loadAccessContext }
})
vi.mock('@/lib/pending-actions/registry', () => ({
  getWriteAction: (name: string) => name === 'update_portfolio_construction'
    ? { domain: 'accounting', stageAccess: 'write', execute: mocks.execute }
    : undefined,
}))
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }))

/**
 * A stateful stand-in for `pending_actions`, filter-aware on purpose.
 *
 * The previous fake ignored filters and applied updates from its `then`, which was enough for a
 * route that read-then-wrote. The route now claims the row with a conditional update
 * (`.eq('status','pending')`) and reads the claimed row back through `.select('*').maybeSingle()`,
 * so a fake that cannot refuse a filtered update cannot exercise the thing SEC-007 fixed.
 */
function adminClient() {
  return {
    from(table: string) {
      if (table !== 'pending_actions') throw new Error(`Unexpected table ${table}`)
      const filters: Array<(r: Record<string, any>) => boolean> = []
      let updatePayload: Record<string, unknown> | null = null
      const matched = () => (filters.every(f => f(mocks.row)) ? [mocks.row] : [])
      const settle = () => {
        const rows = matched()
        if (updatePayload) for (const r of rows) Object.assign(r, updatePayload)
        return rows
      }
      const chain: Record<string, any> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push(r => r[column] === value)
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          updatePayload = payload
          return chain
        },
        maybeSingle: async () => ({ data: settle()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: settle(), error: null }).then(resolve, reject),
      }
      return chain
    },
  }
}

const admin = adminClient()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))

import { POST as approve } from '@/app/api/pending-actions/[id]/approve/route'
import { POST as reject } from '@/app/api/pending-actions/[id]/reject/route'

const features = Object.fromEntries(
  Object.keys(DEFAULT_FEATURE_VISIBILITY).map(key => [key, 'everyone']),
) as FeatureVisibilityMap

function access(level: 'read' | 'write') {
  return {
    fundId: 'fund-1',
    userId: 'user-1',
    role: 'member' as const,
    features,
    grants: { accounting: level },
    defaults: {},
    vehicles: { all: true, ids: [] },
  }
}

describe('construction pending-action decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.row = {
      id: 'action-1',
      fund_id: 'fund-1',
      vehicle_id: null,
      domain: 'accounting',
      action_type: 'update_portfolio_construction',
      args: { vehicle: 'Fund II', feeAnnualRate: 0.015 },
      preview: { summary: 'Set the management fee to 1.50%', details: {} },
      status: 'pending',
      created_by: 'user-1',
      created_via: 'analyst',
      approved_by: null,
      approved_at: null,
      applied_result: null,
      error: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
    }
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.assertReadAccess.mockResolvedValue({ fundId: 'fund-1', role: 'member' })
    mocks.loadAccessContext.mockResolvedValue(access('write'))
    mocks.execute.mockResolvedValue({ model: { vehicle: 'Fund II' } })
  })

  it('executes once and a repeated approval cannot execute again', async () => {
    const first = await approve(new Request('https://reporting.test'), { params: Promise.resolve({ id: 'action-1' }) })
    const second = await approve(new Request('https://reporting.test'), { params: Promise.resolve({ id: 'action-1' }) })

    expect(first.status).toBe(200)
    // The retry now REPLAYS the stored result instead of 404ing. A phone or a double click cannot
    // tell a lost response from a lost request, and "not found" is a worse answer to that than
    // "here is what happened", as long as the write itself ran once — which is the next assertion.
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ ok: true, replayed: true })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.row.status).toBe('applied')
  })

  it('re-checks live write access and refuses approval after access is removed', async () => {
    mocks.loadAccessContext.mockResolvedValue(access('read'))
    const response = await approve(new Request('https://reporting.test'), { params: Promise.resolve({ id: 'action-1' }) })

    expect(response.status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.row.status).toBe('pending')
  })

  it('rejects without executing the staged update', async () => {
    const response = await reject(new Request('https://reporting.test'), { params: Promise.resolve({ id: 'action-1' }) })

    expect(response.status).toBe(200)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.row.status).toBe('rejected')
  })
})
