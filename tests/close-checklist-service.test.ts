// The close checklist service end to end over the in-memory admin client: build, read, work the
// tasks, tie out under the four-eyes rule, move the delivery date — and the access around it.

import { describe, expect, it } from 'vitest'
import { memoryAdmin } from './helpers/memory-admin'
import {
  addTask, createChecklist, getChecklist, listChecklists, updateChecklist, updateTasks, CloseChecklistError,
  type CloseChecklistContext,
} from '@/lib/close-checklist/service'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { getTool } from '@/lib/accounting/agent-tools'
import { isDraftOnlyCall, shouldStage } from '@/lib/agent/dispatch'

const FUND = 'fund-1'

const access = (
  userId: string,
  grants: Partial<Record<Domain, AccessLevel>>,
  opts: { role?: 'admin' | 'member'; vehicles?: AccessContext['vehicles'] } = {},
): AccessContext => ({
  fundId: FUND, userId, vehicles: opts.vehicles ?? { all: true, ids: [] }, role: opts.role ?? 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

function setup() {
  const m = memoryAdmin({
    close_checklists: [], close_checklist_tasks: [], accounting_audit_events: [],
    fund_members: [
      { fund_id: FUND, user_id: 'alice', display_name: 'Alice Chen' },
      { fund_id: FUND, user_id: 'bob', display_name: 'Bob Ruiz' },
    ],
    fund_vehicles: [{ id: 'veh-1', fund_id: FUND, name: 'Fund II', aliases: [] }],
  })
  const as = (userId: string, grants: Partial<Record<Domain, AccessLevel>> = { accounting: 'write' }, opts = {}): CloseChecklistContext =>
    ({ admin: m.admin, fundId: FUND, userId, access: access(userId, grants, opts) })
  return { m, as }
}

const PROMPT = { fundKind: 'venture', portfolioCompanies: 18, administrator: 'outsourced', lpDeliveryDate: '2026-11-16' }

describe('building a checklist', () => {
  it('saves the tasks by owner with the critical task and a separate tied-out column', async () => {
    const { m, as } = setup()
    const view = await createChecklist(as('alice'), PROMPT)
    expect(view.checklist).toMatchObject({ title: 'Q3 2026 close (Venture)', periodEnd: '2026-09-30', lpDeliveryDate: '2026-11-16' })
    expect(view.groups.map(g => g.label)).toEqual(['Fund administrator', 'Portfolio companies', 'Internal team'])
    expect(view.criticalTask).toMatchObject({ key: 'pc_financials', downstream: 11 })
    const tasks = view.groups.flatMap(g => g.tasks)
    expect(tasks.filter(t => t.isCritical).map(t => t.key)).toEqual(['pc_financials'])
    expect(tasks.find(t => t.key === 'adm_bank_rec')).toMatchObject({ status: 'not_started', tieOut: 'pending', tieOutLabel: 'Not yet' })
    expect(tasks.find(t => t.key === 'int_signoff')).toMatchObject({ tieOut: 'not_required' })
    expect(view.columns).toMatch(/not a verified number/)
    expect(m.tables.close_checklist_tasks.length).toBe(tasks.length)
    expect(m.tables.accounting_audit_events).toEqual([expect.objectContaining({ action: 'close_checklist.create', source: 'web', actor_id: 'alice' })])
  })

  it('refuses a second checklist for the same quarter', async () => {
    const { as } = setup()
    await createChecklist(as('alice'), PROMPT)
    await expect(createChecklist(as('alice'), PROMPT)).rejects.toMatchObject({ status: 409 })
  })

  it('needs write on Fund accounting to build one, and read to see one', async () => {
    const { as } = setup()
    await expect(createChecklist(as('carol', { accounting: 'read' }), PROMPT)).rejects.toMatchObject({ status: 403 })
    await createChecklist(as('alice'), PROMPT)
    await expect(getChecklist(as('dan', { portfolio: 'write' }), 'latest')).rejects.toMatchObject({ status: 403 })
    expect((await getChecklist(as('carol', { accounting: 'read' }), 'latest')).summary.tasks).toBeGreaterThan(0)
  })

  it('keeps a fund-wide checklist from a member who sees only some entities', async () => {
    const { as } = setup()
    await createChecklist(as('alice'), PROMPT)
    const scoped = as('erin', { accounting: 'write' }, { vehicles: { all: false, ids: ['veh-1'] } })
    expect((await listChecklists(scoped)).checklists).toEqual([])
    await expect(getChecklist(scoped, 'latest')).rejects.toMatchObject({ status: 404 })
    await expect(createChecklist(scoped, PROMPT)).rejects.toMatchObject({ status: 403 })
  })
})

describe('working the checklist', () => {
  it('ties out only through a second person, and records who', async () => {
    const { m, as } = setup()
    await createChecklist(as('alice'), PROMPT)
    await updateTasks(as('alice'), 'latest', [{ task: 'adm_bank_rec', status: 'done' }])
    await expect(updateTasks(as('alice'), 'latest', [{ task: 'adm_bank_rec', tie_out: 'tied_out' }]))
      .rejects.toThrow(/someone else has to tie it out/)
    const view = await updateTasks(as('bob'), 'latest', [{ task: 'adm_bank_rec', tie_out: 'tied_out' }])
    const t = view.groups.flatMap(g => g.tasks).find(x => x.key === 'adm_bank_rec')!
    expect(t).toMatchObject({ status: 'done', completedBy: 'Alice Chen', tieOut: 'tied_out', tiedOutBy: 'Bob Ruiz' })
    expect(view.summary).toMatchObject({ tiedOut: 1, doneNotTiedOut: 0 })
    expect(m.tables.accounting_audit_events.at(-1)).toMatchObject({ action: 'close_checklist.tie_out', actor_id: 'bob' })
  })

  it('un-ties a task that is reopened, and counts done-but-unchecked work', async () => {
    const { as } = setup()
    await createChecklist(as('alice'), PROMPT)
    await updateTasks(as('alice'), 'latest', [{ task: 'adm_bank_rec', status: 'done' }, { task: 'adm_capital_activity', status: 'done' }])
    await updateTasks(as('bob'), 'latest', [{ task: 'adm_bank_rec', tie_out: 'tied_out' }])
    const view = await updateTasks(as('alice'), 'latest', [{ task: 'adm_bank_rec', status: 'in_progress' }])
    const t = view.groups.flatMap(g => g.tasks).find(x => x.key === 'adm_bank_rec')!
    expect(t).toMatchObject({ status: 'in_progress', tieOut: 'pending', tiedOutBy: null, completedBy: null })
    expect(view.summary.doneNotTiedOut).toBe(1)
  })

  it('refuses the whole batch when one line is wrong', async () => {
    const { m, as } = setup()
    await createChecklist(as('alice'), PROMPT)
    await expect(updateTasks(as('alice'), 'latest', [
      { task: 'pc_financials', status: 'done' },
      { task: 'adm_bank_rec', tie_out: 'tied_out' },
    ])).rejects.toBeInstanceOf(CloseChecklistError)
    expect(m.tables.close_checklist_tasks.find(t => t.key === 'pc_financials')!.status).toBe('not_started')
  })

  it('moves the next blocker once the critical task is done', async () => {
    const { as } = setup()
    await createChecklist(as('alice'), PROMPT)
    const view = await updateTasks(as('alice'), 'latest', [{ task: 'Collect quarterly financials', status: 'done' }])
    expect(view.criticalTask?.key).toBe('pc_financials')
    expect(view.currentBlocker?.key).not.toBe('pc_financials')
  })

  it('moves every task with the delivery date, except one given its own date', async () => {
    const { as } = setup()
    const first = await createChecklist(as('alice'), PROMPT)
    const before = new Map(first.groups.flatMap(g => g.tasks).map(t => [t.key, t.dueDate]))
    await updateTasks(as('alice'), 'latest', [{ task: 'int_lp_letter', due_date: '2026-11-02' }])
    const view = await updateChecklist(as('alice'), 'latest', { lpDeliveryDate: '2026-11-30' })
    const after = new Map(view.groups.flatMap(g => g.tasks).map(t => [t.key, t.dueDate]))
    expect(after.get('int_deliver')).toBe('2026-11-30')
    expect(after.get('pc_financials')! > before.get('pc_financials')!).toBe(true)
    expect(after.get('int_lp_letter')).toBe('2026-11-02')
    expect(view.moved).toBeGreaterThan(10)
  })

  it('adds a task of the fund\'s own, and refuses one that would loop', async () => {
    const { as } = setup()
    await createChecklist(as('alice'), PROMPT)
    const view = await addTask(as('alice'), 'latest', {
      title: 'Confirm side-letter fee offsets', owner: 'internal', days_before_delivery: 28, depends_on: ['adm_capital_activity'],
    })
    expect(view.added).toBe('custom_confirm_side_letter_fee_offsets')
    expect(view.groups.flatMap(g => g.tasks).find(t => t.key === view.added)).toMatchObject({ dueDate: '2026-10-19', tieOut: 'pending' })
    await expect(updateTasks(as('alice'), 'latest', [{ task: 'nope', status: 'done' }])).rejects.toMatchObject({ status: 404 })
  })
})

describe('from chat', () => {
  it('serves the checklist as accounting tools, fund-scoped', () => {
    for (const name of ['close_checklist_create', 'close_checklist', 'close_checklist_list', 'close_checklist_update_tasks', 'close_checklist_add_task', 'close_checklist_update']) {
      const tool = getTool(name)!
      expect(tool, name).toBeTruthy()
      expect(tool.accessDomain, name).toBe('accounting')
      expect(tool.domain, name).toBe('portfolio')
    }
  })

  it('applies planning changes directly, and stages a tie-out for a person to approve', () => {
    const oauth = { keyId: 'oauth:abc' }
    const tasks = getTool('close_checklist_update_tasks')!
    expect(shouldStage(getTool('close_checklist_create')!, { lp_delivery_date: '2026-11-16' }, oauth)).toBe(false)
    expect(shouldStage(tasks, { updates: [{ task: 'pc_financials', status: 'done' }] }, oauth)).toBe(false)
    expect(shouldStage(tasks, { updates: [{ task: 'adm_bank_rec', tie_out: 'tied_out' }] }, oauth)).toBe(true)
    expect(isDraftOnlyCall(tasks, { updates: [{ task: 'x', tie_out: 'not_required' }] })).toBe(false)
  })
})
