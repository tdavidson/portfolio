import { describe, it, expect, vi, beforeEach } from 'vitest'

// One action type whose preview refuses anything outside the caller's entities, as the real ones do.
const m = vi.hoisted(() => ({ preview: vi.fn(), execute: vi.fn() }))
vi.mock('./registry', () => ({
  getWriteAction: () => ({ domain: 'lp_capital', entity: 'required', preview: m.preview, execute: m.execute }),
}))

import { listPendingActions, approvePendingAction, rejectPendingAction } from './service'

const row = (id: string, vehicle: string, vehicleId: string | null = vehicle === 'Fund I' ? 'v1' : 'v2') => ({
  id, fund_id: 'f1', vehicle_id: vehicleId, domain: 'lp_capital', action_type: 'issue_capital_call',
  args: { vehicle }, preview: { summary: `call on ${vehicle}`, details: {} }, status: 'pending',
  created_by: 'admin', created_via: 'analyst', approved_by: null, approved_at: null, applied_result: null,
  error: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
})
const rows = [
  row('00000000-0000-4000-8000-000000000001', 'Fund I'),
  row('00000000-0000-4000-8000-000000000002', 'Fund II'),
  // Staged by a Fund II member with no vehicle named, before staging pinned one: re-running its
  // preview as a Fund I member would resolve to Fund I — it must not become theirs.
  { ...row('00000000-0000-4000-8000-000000000003', 'Fund II', null), args: {} },
]

function admin() {
  const updates: any[] = []
  return {
    updates,
    from: () => {
      let id: string | null = null
      const chain: any = {
        select: () => chain, order: () => chain, limit: () => chain, or: () => chain,
        eq: (k: string, v: any) => { if (k === 'id') id = v; return chain },
        update: (u: any) => { updates.push(u); return chain },
        maybeSingle: async () => ({ data: rows.find(r => r.id === id) ?? null, error: null }),
        single: async () => ({ data: rows.find(r => r.id === id) ?? null, error: null }),
        then: (res: any) => res({ data: id ? rows.filter(r => r.id === id) : rows, error: null }),
      }
      return chain
    },
  } as any
}

const features = new Proxy({}, { get: () => 'everyone' }) as any
const principal = (all: boolean) => ({
  userId: 'u1', fundId: 'f1', role: 'member',
  access: { fundId: 'f1', userId: 'u1', role: 'member', features, grants: { lp_capital: 'write' }, defaults: {}, vehicles: { all, ids: all ? [] : ['v1'] } },
}) as any

describe('pending actions — only the caller\'s entities', () => {
  beforeEach(() => {
    m.preview.mockReset().mockImplementation(async (deps: any, args: any) => {
      if (!deps.access.vehicles.all && args.vehicle !== 'Fund I') throw new Error('Unknown vehicle')
      return { summary: 'ok', details: {} }
    })
    m.execute.mockReset().mockResolvedValue({ ok: true })
  })

  it('lists only actions on their entities', async () => {
    const out = await listPendingActions(admin(), principal(false), { limit: 20 })
    expect(out.actions.map(a => a.preview.summary)).toEqual(['call on Fund I'])
    expect((await listPendingActions(admin(), principal(true), { limit: 20 })).actions).toHaveLength(3)
  })
  it('an action on another entity is hidden even when its preview would pass for the viewer', async () => {
    m.preview.mockResolvedValue({ summary: 'ok', details: {} })
    const out = await listPendingActions(admin(), principal(false), { limit: 20 })
    expect(out.actions.map(a => a.preview.summary)).toEqual(['call on Fund I'])
    await expect(approvePendingAction(admin(), principal(false), rows[2].id)).rejects.toMatchObject({ status: 404 })
  })

  it('approving or rejecting another entity\'s action is not found, and changes nothing', async () => {
    const a = admin()
    await expect(approvePendingAction(a, principal(false), rows[1].id)).rejects.toMatchObject({ status: 404 })
    await expect(rejectPendingAction(a, principal(false), rows[1].id)).rejects.toMatchObject({ status: 404 })
    expect(a.updates).toEqual([])
    expect(m.execute).not.toHaveBeenCalled()
  })
})
