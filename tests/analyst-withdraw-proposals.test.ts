import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

// A draft the person keeps revising in the conversation replaces the earlier one, and the Analyst
// can take back a draft the person moved on from (lib/pending-actions/withdraw.ts).

vi.mock('@/lib/pending-actions/registry', () => {
  const actions = {
    update_company: {
      domain: 'portfolio', entity: 'none', description: 'Edit a company.', inputSchema: { type: 'object' },
      preview: async (_d: unknown, input: { companyId: string; name: string }) => ({ summary: `Rename to ${input.name}`, details: {} }),
      execute: async () => ({}),
    },
    update_company_metric: {
      domain: 'portfolio', entity: 'none', description: 'Set a metric.', inputSchema: { type: 'object' },
      preview: async () => ({ summary: 'Set ARR', details: {} }),
      execute: async () => ({}),
    },
  }
  return { WRITE_ACTIONS: actions, getWriteAction: (n: string) => (actions as Record<string, unknown>)[n] }
})

const audits: any[] = []
vi.mock('@/lib/audit/events', () => ({ recordAudit: async (_a: unknown, e: unknown) => { audits.push(e) } }))

import { buildAnalystTools } from '@/lib/ai/analyst-tools'
import { openProposalsBlock, proposalSubject, replaces, type OpenProposal } from '@/lib/pending-actions/withdraw'

function ctx(): AccessContext {
  return {
    fundId: 'f1', userId: 'u1', role: 'member',
    features: { ...DEFAULT_FEATURE_VISIBILITY } as FeatureVisibilityMap,
    grants: { portfolio: 'write' } as any, defaults: {},
  } as AccessContext
}

/** Records each update's filters; every row asked for is still pending unless `decided` says not. */
let updates: Array<{ row: any; filters: Record<string, unknown>; ids: string[] }> = []
let decided = new Set<string>()
function makeAdmin() {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'new1' }, error: null }) }) }),
      update: (row: any) => {
        const entry = { row, filters: {} as Record<string, unknown>, ids: [] as string[] }
        updates.push(entry)
        const chain: any = {
          eq: (k: string, v: unknown) => { entry.filters[k] = v; return chain },
          in: (_k: string, ids: string[]) => { entry.ids = ids; return chain },
          select: async () => ({
            data: entry.ids.filter(id => !decided.has(id)).map(id => ({ id, action_type: 'update_company', vehicle_id: null })),
            error: null,
          }),
        }
        return chain
      },
    }),
  } as any
}

const open = (over: Partial<OpenProposal>): OpenProposal => ({
  id: 'old1', actionType: 'update_company', vehicleId: null, subject: 'companyId:c1', summary: 'Rename to Acme', ...over,
})

beforeEach(() => { updates = []; audits.length = 0; decided = new Set() })

describe('withdrawing superseded drafts', () => {
  it('a revised draft of the same change withdraws the earlier one', async () => {
    const withdrawn: string[] = []
    const { executeTool } = buildAnalystTools({
      admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true,
      openProposals: [open({})], withdrawnActions: withdrawn,
    })
    const res = await executeTool({ name: 'update_company', input: { companyId: 'c1', name: 'Northwind' } })

    expect(res).toContain('Staged pending action new1')
    expect(res).toContain('withdrew')
    expect(withdrawn).toEqual(['old1'])
    expect(updates[0].row.status).toBe('rejected')
    // Only the caller's own, still pending, Analyst drafts.
    expect(updates[0].filters).toMatchObject({ fund_id: 'f1', created_by: 'u1', created_via: 'analyst', status: 'pending' })
    expect(audits[0]).toMatchObject({ action: 'pending_action.withdraw', subjectId: 'old1', details: { replacedBy: 'new1' } })
  })

  it('leaves a draft about a different company alone', async () => {
    const withdrawn: string[] = []
    const { executeTool } = buildAnalystTools({
      admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true,
      openProposals: [open({ subject: 'companyId:c2' })], withdrawnActions: withdrawn,
    })
    await executeTool({ name: 'update_company', input: { companyId: 'c1', name: 'Northwind' } })
    expect(withdrawn).toEqual([])
    expect(updates).toHaveLength(0)
  })

  it('does not auto-replace kinds where a second draft is usually a separate change', async () => {
    const withdrawn: string[] = []
    const { executeTool } = buildAnalystTools({
      admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true,
      openProposals: [open({ actionType: 'update_company_metric' })], withdrawnActions: withdrawn,
    })
    await executeTool({ name: 'update_company_metric', input: { companyId: 'c1' } })
    expect(withdrawn).toEqual([])
  })

  it('withdraw_proposal is offered only with drafts waiting, and only takes back those', async () => {
    const none = buildAnalystTools({ admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true })
    expect(none.tools.map(t => t.name)).not.toContain('withdraw_proposal')

    const withdrawn: string[] = []
    const { tools, executeTool } = buildAnalystTools({
      admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true,
      openProposals: [open({ actionType: 'update_company_metric' })], withdrawnActions: withdrawn,
    })
    expect(tools.map(t => t.name)).toContain('withdraw_proposal')

    const refused = await executeTool({ name: 'withdraw_proposal', input: { ids: ['someone-elses'] } })
    expect(refused).toContain('error')
    expect(updates).toHaveLength(0)

    const res = JSON.parse(await executeTool({ name: 'withdraw_proposal', input: { ids: ['old1'], reason: 'Person moved on' } }) as string)
    expect(res.withdrawn).toEqual(['old1'])
    expect(withdrawn).toEqual(['old1'])
    expect(audits[0]).toMatchObject({ action: 'pending_action.withdraw', reason: 'Person moved on' })

    // Already withdrawn: no longer in this conversation's open list.
    const again = await executeTool({ name: 'withdraw_proposal', input: { ids: ['old1'] } })
    expect(again).toContain('error')
  })

  it('reports a draft decided in the meantime as not waiting', async () => {
    decided = new Set(['old1'])
    const { executeTool } = buildAnalystTools({
      admin: makeAdmin(), fundId: 'f1', userId: 'u1', access: ctx(), enableDrafts: true,
      openProposals: [open({})], withdrawnActions: [],
    })
    const res = JSON.parse(await executeTool({ name: 'withdraw_proposal', input: { ids: ['old1'] } }) as string)
    expect(res).toEqual({ withdrawn: [], notWaiting: ['old1'] })
  })
})

describe('withdraw helpers', () => {
  it('a forecast revision for the same plan and entity replaces; another plan does not', () => {
    const next = { actionType: 'update_forecast_plan', vehicleId: 'v1', subject: proposalSubject({ planId: 'p1', vehicle: 'Example Fund I' }) }
    expect(replaces(next, open({ actionType: 'update_forecast_plan', vehicleId: 'v1', subject: 'planId:p1' }))).toBe(true)
    expect(replaces(next, open({ actionType: 'update_forecast_plan', vehicleId: 'v1', subject: 'planId:p2' }))).toBe(false)
    expect(replaces(next, open({ actionType: 'update_forecast_plan', vehicleId: 'v2', subject: 'planId:p1' }))).toBe(false)
  })

  it('a second new-forecast draft for the same entity replaces the first', () => {
    const next = { actionType: 'create_forecast_plan', vehicleId: 'v1', subject: proposalSubject({ vehicle: 'Example Fund I', name: 'Budget' }) }
    expect(replaces(next, open({ actionType: 'create_forecast_plan', vehicleId: 'v1', subject: null }))).toBe(true)
  })

  it('lists waiting drafts for the Analyst, and nothing when there are none', () => {
    expect(openProposalsBlock([])).toBe('')
    const block = openProposalsBlock([open({})])
    expect(block).toContain('old1')
    expect(block).toContain('withdraw_proposal')
  })
})
