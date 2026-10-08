import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

// Isolate the staging mechanics from the real preview/execute internals.
vi.mock('@/lib/pending-actions/registry', () => {
  const actions = {
    update_company_metric: {
      domain: 'portfolio',
      entity: 'none',
      accessFeature: undefined,
      description: 'Set a metric.',
      inputSchema: { type: 'object' },
      preview: async () => ({ summary: 'Set ARR for Q2 2026 to 4000000', details: { mode: 'update' } }),
      execute: async () => ({ metricValueId: 'mv1' }),
    },
  }
  return { WRITE_ACTIONS: actions, getWriteAction: (n: string) => (actions as Record<string, unknown>)[n] }
})

import { buildAnalystTools, type StagedActionRecord } from '@/lib/ai/analyst-tools'

function ctx(grants: Partial<Record<string, 'read' | 'write'>>): AccessContext {
  return {
    fundId: 'f1',
    userId: 'u1',
    role: 'member',
    features: { ...DEFAULT_FEATURE_VISIBILITY } as FeatureVisibilityMap,
    grants: grants as any,
    defaults: {},
  } as AccessContext
}

let inserted: Array<{ table: string; row: any }> = []
function makeAdmin() {
  return {
    from: (table: string) => ({
      insert: (row: any) => {
        inserted.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: 'pa1' }, error: null }) }) }
      },
    }),
  } as any
}

beforeEach(() => {
  inserted = []
})

describe('analyst write staging', () => {
  it('lists a write tool for a member with domain read and stages it on call', async () => {
    const staged: StagedActionRecord[] = []
    const { tools, executeTool } = buildAnalystTools({
      admin: makeAdmin(),
      fundId: 'f1',
      userId: 'u1',
      access: ctx({ portfolio: 'read' }),
      enableDrafts: true,
      stagedActions: staged,
    })
    expect(tools.map(t => t.name)).toContain('update_company_metric')

    const res = await executeTool({
      name: 'update_company_metric',
      input: { companyId: 'c1', metricId: 'm1', period_label: 'Q2 2026', period_year: 2026, value: 4_000_000 },
    })

    expect(res).toContain('Staged')
    const paInsert = inserted.find(i => i.table === 'pending_actions')
    expect(paInsert).toBeTruthy()
    expect(paInsert!.row.status).toBe('pending')
    expect(paInsert!.row.action_type).toBe('update_company_metric')
    expect(paInsert!.row.created_by).toBe('u1')
    expect(staged).toHaveLength(1)
    expect(staged[0].id).toBe('pa1')
  })

  it('does not list write tools for a member without domain read', () => {
    const { tools } = buildAnalystTools({
      admin: makeAdmin(),
      fundId: 'f1',
      userId: 'u1',
      access: ctx({}),
      enableDrafts: true,
    })
    expect(tools.map(t => t.name)).not.toContain('update_company_metric')
  })

  it('omits write tools entirely when enableDrafts is off', () => {
    const { tools } = buildAnalystTools({
      admin: makeAdmin(),
      fundId: 'f1',
      userId: 'u1',
      access: ctx({ portfolio: 'write' }),
    })
    expect(tools.map(t => t.name)).not.toContain('update_company_metric')
  })
})
