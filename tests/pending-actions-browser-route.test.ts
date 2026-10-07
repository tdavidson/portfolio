import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

/**
 * SEC-007, the browser half.
 *
 * The legacy route read the row, checked `status === 'pending'`, ran the write, and only then
 * flipped the status. Two overlapping requests — a double click, or a retry after a slow
 * response — both passed the check before either had written, and both executed. For a capital
 * call that is a duplicated financial entry.
 *
 * The concurrency test below is the one that matters: it interleaves two approvals of the same
 * action and asserts the write ran ONCE. Against the old implementation it ran twice.
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  revalidateTag: vi.fn(),
  principal: null as unknown,
}))

vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }))
vi.mock('@/lib/pending-actions/browser-principal', () => ({
  resolveBrowserPrincipal: async () => mocks.principal,
}))
vi.mock('@/lib/pending-actions/registry', () => ({
  getWriteAction: (name: string) =>
    name === 'issue_capital_call'
      ? { domain: 'accounting', stageAccess: 'write', execute: mocks.execute }
      : undefined,
}))

/** One row, with the conditional-update semantics the claim depends on. */
const row = {
  id: 'action-1',
  fund_id: 'fund-1',
  vehicle_id: null,
  domain: 'accounting',
  action_type: 'issue_capital_call',
  args: { amount: 1_000_000 },
  preview: { summary: 'Issue a $1,000,000 capital call', details: {} },
  status: 'pending',
  created_by: 'user-1',
  created_via: 'analyst',
  approved_by: null as string | null,
  approved_at: null as string | null,
  applied_result: null as unknown,
  error: null as string | null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
}
let table: (typeof row)[] = []

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(name: string) {
      if (name !== 'pending_actions') throw new Error(`Unexpected table ${name}`)
      const filters: Array<(r: Record<string, any>) => boolean> = []
      let patch: Record<string, any> | null = null
      const matched = () => table.filter(r => filters.every(f => f(r as Record<string, any>)))
      const settle = () => {
        const rows = matched()
        // The claim: apply the patch only to rows that still satisfy every filter, which is what
        // `.eq('status','pending')` on an UPDATE buys in Postgres.
        if (patch) for (const r of rows) Object.assign(r, patch)
        return rows
      }
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        or: () => chain,
        eq: (col: string, value: unknown) => {
          filters.push(r => r[col] === value)
          return chain
        },
        update: (values: Record<string, any>) => {
          patch = values
          return chain
        },
        maybeSingle: async () => ({ data: settle()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
          Promise.resolve({ data: settle(), error: null }).then(resolve, reject),
      }
      return chain
    },
  }),
}))

import { POST as approve } from '@/app/api/pending-actions/[id]/approve/route'
import { POST as reject } from '@/app/api/pending-actions/[id]/reject/route'
import { GET as list } from '@/app/api/pending-actions/route'

function principal(level: 'read' | 'write' | 'none') {
  return {
    userId: 'user-1',
    fundId: 'fund-1',
    role: 'member',
    access: {
      fundId: 'fund-1',
      userId: 'user-1',
      role: 'member',
      features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone' } as FeatureVisibilityMap,
      grants: level === 'none' ? {} : { accounting: level },
      defaults: {},
      vehicles: { all: true, ids: [] },
    },
  }
}

const post = () => new Request('https://reporting.test/api/pending-actions/action-1/approve', { method: 'POST' })
const params = { params: Promise.resolve({ id: 'action-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  table = [{ ...row }]
  mocks.principal = principal('write')
  mocks.execute.mockResolvedValue({ callId: 'call-1' })
})

describe('POST /api/pending-actions/:id/approve', () => {
  it('runs the write ONCE when two approvals of the same action overlap', async () => {
    const [first, second] = await Promise.all([approve(post(), params), approve(post(), params)])
    const bodies = [await first.json(), await second.json()]

    expect(mocks.execute, 'the capital call was issued more than once').toHaveBeenCalledTimes(1)

    const applied = bodies.filter(b => b.ok === true)
    const refused = bodies.filter(b => b.ok === false)
    expect(applied).toHaveLength(1)
    expect(refused).toHaveLength(1)
    // The loser is told the action is being processed, not that it succeeded.
    expect(refused[0].error).toMatch(/already being processed|no longer available/i)
    expect([first.status, second.status].sort()).toEqual([200, 409])
    expect(table[0].status).toBe('applied')
  })

  it('applies the action and reports the result on the happy path', async () => {
    const response = await approve(post(), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, result: { callId: 'call-1' } })
    expect(table[0]).toMatchObject({ status: 'applied', approved_by: 'user-1' })
    // Immediate expiry, not stale-while-revalidate — see lib/cache/tags.ts for why.
    expect(mocks.revalidateTag).toHaveBeenCalledWith('pending-actions-badge', { expire: 0 })
  })

  it('re-checks CURRENT write access — staging only needed read', async () => {
    mocks.principal = principal('read')
    const response = await approve(post(), params)
    expect(response.status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(table[0].status).toBe('pending')
  })

  it('refuses a RESTRICTED credential outright, whatever its grants and scope say', async () => {
    // The demo case, ahead of Phase 8 issuing one. The restriction is a property of the credential,
    // so it is checked in the shared service and cannot be asserted away by a request body.
    mocks.principal = { ...principal('write'), credentialKind: 'demo' }
    const response = await approve(post(), params)
    expect(response.status).toBe(403)
    expect((await response.json()).error).toMatch(/cannot decide pending actions/i)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(table[0].status).toBe('pending')
  })

  it('refuses a restricted credential at reject too, not only at approve', async () => {
    mocks.principal = { ...principal('write'), credentialKind: 'demo' }
    expect((await reject(post(), params)).status).toBe(403)
    expect(table[0].status).toBe('pending')
  })

  it('refuses when the grant has been revoked since the action was staged', async () => {
    mocks.principal = principal('none')
    expect((await approve(post(), params)).status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('marks the row failed rather than claiming a partial success', async () => {
    mocks.execute.mockRejectedValue(new Error('Ledger period is closed'))
    const response = await approve(post(), params)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: 'Ledger period is closed' })
    expect(table[0]).toMatchObject({ status: 'failed', error: 'Ledger period is closed' })
  })

  it('replays the stored result for an action that already applied', async () => {
    await approve(post(), params)
    mocks.execute.mockClear()
    const again = await approve(post(), params)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ ok: true, replayed: true })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('refuses an action that was already rejected', async () => {
    table[0].status = 'rejected'
    const response = await approve(post(), params)
    expect(response.status).toBe(409)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(table[0].status).toBe('rejected')
  })

  it('404s an unknown id', async () => {
    const response = await approve(post(), { params: Promise.resolve({ id: 'no-such-action' }) })
    expect(response.status).toBe(404)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('404s an action from another fund rather than confirming it exists', async () => {
    table[0].fund_id = 'someone-else'
    expect((await approve(post(), params)).status).toBe(404)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe('POST /api/pending-actions/:id/reject', () => {
  it('requires write in the row’s domain, like approve', async () => {
    mocks.principal = principal('read')
    expect((await reject(post(), params)).status).toBe(403)
    expect(table[0].status).toBe('pending')
  })

  it('rejects once and reports a second attempt as a replay', async () => {
    expect((await reject(post(), params)).status).toBe(200)
    expect(table[0]).toMatchObject({ status: 'rejected', approved_by: 'user-1' })
    expect(await (await reject(post(), params)).json()).toMatchObject({ ok: true, replayed: true })
  })

  it('never executes the staged write', async () => {
    await reject(post(), params)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe('GET /api/pending-actions', () => {
  const get = () => new Request('https://reporting.test/api/pending-actions')

  it('returns rows the caller can READ, through the shared service', async () => {
    const body = await (await list(get())).json()
    expect(body.actions).toHaveLength(1)
    expect(body.actions[0]).toMatchObject({ id: 'action-1', actionType: 'issue_capital_call' })
  })

  it('hides a row whose domain the caller cannot read — the queue spans domains', async () => {
    mocks.principal = principal('none')
    const body = await (await list(get())).json()
    expect(body.actions).toEqual([])
  })

  it('shows a row the caller can read but not write, so they can see what is waiting', async () => {
    mocks.principal = principal('read')
    const body = await (await list(get())).json()
    expect(body.actions).toHaveLength(1)
  })
})
