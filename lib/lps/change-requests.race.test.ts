import { describe, it, expect, vi, beforeEach } from 'vitest'

const apply = vi.hoisted(() => ({ profile: vi.fn() }))
vi.mock('./records', async orig => ({ ...(await orig<any>()), updateEntityProfile: apply.profile }))
vi.mock('@/lib/audit/events', () => ({ recordAudit: async () => {} }))

import { decideChangeRequest } from './change-requests'

/** One request row, read and conditionally updated the way PostgREST does it. */
function store() {
  const row: Record<string, any> = { id: 'r1', fund_id: 'f1', lp_investor_id: 'i1', lp_entity_id: 'e1', kind: 'profile', status: 'pending', payload: { entity: { city: 'Springfield' } } }
  const from = () => {
    const f: Record<string, any> = {}
    let patch: Record<string, any> | null = null
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { f[k] = v; return chain },
      update: (p: Record<string, any>) => { patch = p; return chain },
      maybeSingle: async () => ({ data: { ...row }, error: null }),
      then: (r: any) => {
        if (!patch) return r({ data: [], error: null })
        const hit = (f.status === undefined || row.status === f.status)
        if (hit) Object.assign(row, patch)
        return r({ data: hit ? [{ id: row.id }] : [], error: null })
      },
    }
    return chain
  }
  return { admin: { from } as any, row }
}

const actor = { fundId: 'f1', userId: 'u1', role: 'admin', investorIds: null, entityIds: null, canWrite: true } as any

describe('approving an LP change request applies it once', () => {
  beforeEach(() => { apply.profile.mockReset().mockResolvedValue({ ok: true, value: { updated: true } }) })

  it('two approvals at once: one applies, the other is told it was already decided', async () => {
    const s = store()
    const [a, b] = await Promise.all([
      decideChangeRequest(s.admin, actor, { id: 'r1', decision: 'approve' }),
      decideChangeRequest(s.admin, actor, { id: 'r1', decision: 'approve' }),
    ])
    expect([a, b].filter(o => o.ok)).toHaveLength(1)
    expect([a, b].find(o => !o.ok)).toMatchObject({ status: 409 })
    expect(apply.profile).toHaveBeenCalledTimes(1)
    expect(s.row.status).toBe('approved')
  })

  it('a change that fails to apply goes back to pending, to be decided again', async () => {
    apply.profile.mockResolvedValue({ ok: false, status: 400, error: 'bad' })
    const s = store()
    expect(await decideChangeRequest(s.admin, actor, { id: 'r1', decision: 'approve' })).toMatchObject({ ok: false, status: 400 })
    expect(s.row.status).toBe('pending')
    expect(s.row.decided_by).toBeNull()
  })
})
