import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'

const m = vi.hoisted(() => ({ access: { vehicles: { all: false, ids: ['v1'] } } as any }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member' }),
  assertWriteAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member' }),
}))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => m.access }))

import { entityDocumentsGate } from './http'

const admin = {
  from: () => {
    let id = ''
    const c: any = { select: () => c, eq: (k: string, v: string) => { if (k === 'id') id = v; return c },
      maybeSingle: async () => ({ data: ['v1', 'v2'].includes(id) ? { id } : null }) }
    return c
  },
} as any

describe('entityDocumentsGate — anyone on the entity\'s team, whatever their domain grants', () => {
  it('lets in a member granted the entity', async () => {
    expect(await entityDocumentsGate(admin, 'u1', 'v1', 'read')).toMatchObject({ fundId: 'f1' })
  })
  it('another entity, or one not in the fund, is not found', async () => {
    for (const v of ['v2', 'v9']) {
      const r = await entityDocumentsGate(admin, 'u1', v, 'read')
      expect(r instanceof NextResponse && r.status).toBe(404)
    }
  })
  it('an unscoped member sees every entity in the fund', async () => {
    m.access = { vehicles: { all: true, ids: [] } }
    expect(await entityDocumentsGate(admin, 'u1', 'v2', 'write')).toMatchObject({ fundId: 'f1' })
  })
})
