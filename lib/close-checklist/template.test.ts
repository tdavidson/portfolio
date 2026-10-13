import { describe, expect, it } from 'vitest'
import {
  TASK_LIBRARY, administratorOf, buildChecklist, businessDayOnOrBefore, companyLeadDays, criticalTask, decideTaskChange,
  describeTaskUpdates, downstreamCounts, dueDateFor, findCycle, quarterEndBefore, touchesTieOut, type ChecklistParams,
} from './template'

const base: ChecklistParams = {
  fundKind: 'venture', portfolioCompanies: 18, administrator: 'Juniper Fund Services',
  periodEnd: '2026-09-30', lpDeliveryDate: '2026-11-16',
}
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()

describe('the task library', () => {
  it('has no dependency loops and names only real tasks, for either kind of fund', () => {
    for (const fundKind of ['venture', 'pe'] as const) {
      const { tasks } = buildChecklist({ ...base, fundKind })
      expect(findCycle(tasks), fundKind).toBeNull()
      const keys = new Set(tasks.map(t => t.key))
      expect(keys.size, `${fundKind}: keys are unique`).toBe(tasks.length)
      for (const t of tasks) for (const d of t.dependsOn) expect(keys, `${t.key} → ${d}`).toContain(d)
    }
  })

  it('covers all three owner groups when the administrator is outsourced', () => {
    const owners = new Set(buildChecklist(base).tasks.map(t => t.owner))
    expect([...owners].sort()).toEqual(['administrator', 'internal', 'portfolio_companies'])
  })

  it('gives PE funds their covenant and credit-facility work, and venture funds neither', () => {
    const keys = (fundKind: 'venture' | 'pe') => buildChecklist({ ...base, fundKind }).tasks.map(t => t.key)
    expect(keys('pe')).toEqual(expect.arrayContaining(['pc_covenants', 'adm_credit_facility']))
    expect(keys('venture')).not.toContain('pc_covenants')
    expect(keys('venture')).not.toContain('adm_credit_facility')
    // The library's PE-only dependency is dropped for venture rather than left dangling.
    expect(buildChecklist(base).tasks.find(t => t.key === 'adm_allocations')!.dependsOn).not.toContain('adm_credit_facility')
  })

  it('every library entry is reachable for at least one kind of fund', () => {
    const built = new Set([...buildChecklist(base).tasks, ...buildChecklist({ ...base, fundKind: 'pe' }).tasks].map(t => t.key))
    for (const t of TASK_LIBRARY) expect(built, t.key).toContain(t.key)
  })
})

describe('due dates, counted back from LP delivery', () => {
  it('falls on business days, after quarter-end and no later than delivery', () => {
    const { tasks, warnings } = buildChecklist(base)
    expect(warnings).toEqual([])
    for (const t of tasks) {
      expect(t.dueDate > base.periodEnd, t.key).toBe(true)
      expect(t.dueDate <= base.lpDeliveryDate, t.key).toBe(true)
      expect([0, 6], t.key).not.toContain(dow(t.dueDate))
    }
    const deliver = tasks.find(t => t.key === 'int_deliver')!
    expect(deliver.daysBeforeDelivery).toBe(0)
    expect(deliver.dueDate).toBe('2026-11-16') // a Monday
  })

  it('respects dependencies: nothing is due before what it waits on', () => {
    const { tasks } = buildChecklist(base)
    const byKey = new Map(tasks.map(t => [t.key, t]))
    for (const t of tasks) for (const d of t.dependsOn) expect(byKey.get(d)!.dueDate <= t.dueDate, `${d} before ${t.key}`).toBe(true)
  })

  it('rolls a weekend back to Friday', () => {
    expect(businessDayOnOrBefore('2026-11-14')).toBe('2026-11-13')
    expect(businessDayOnOrBefore('2026-11-15')).toBe('2026-11-13')
    expect(dueDateFor('2026-11-14', '2026-09-30', 0)).toBe('2026-11-13')
  })

  it('compresses a short window in proportion and says so', () => {
    const { tasks, warnings } = buildChecklist({ ...base, lpDeliveryDate: '2026-10-20' })
    expect(warnings.join(' ')).toMatch(/compressed/)
    for (const t of tasks) expect(t.dueDate > base.periodEnd, t.key).toBe(true)
    const byKey = new Map(tasks.map(t => [t.key, t]))
    expect(byKey.get('pc_financials')!.dueDate <= byKey.get('int_valuations')!.dueDate).toBe(true)
  })

  it('gives many companies more lead time to report', () => {
    expect(companyLeadDays(null)).toBe(0)
    expect(companyLeadDays(10)).toBe(0)
    expect(companyLeadDays(18)).toBe(1)
    expect(companyLeadDays(500)).toBe(10)
    const few = buildChecklist({ ...base, portfolioCompanies: 5 }).tasks.find(t => t.key === 'pc_financials')!
    const many = buildChecklist({ ...base, portfolioCompanies: 60 }).tasks.find(t => t.key === 'pc_financials')!
    expect(many.dueDate < few.dueDate).toBe(true)
    expect(many.title).toContain('60 portfolio companies')
  })

  it('defaults the quarter-end to the last one before delivery', () => {
    expect(quarterEndBefore('2026-11-16')).toBe('2026-09-30')
    expect(quarterEndBefore('2027-02-14')).toBe('2026-12-31')
  })

  it('refuses a delivery date on or before quarter-end', () => {
    expect(() => buildChecklist({ ...base, lpDeliveryDate: '2026-09-30' })).toThrow(/after the quarter-end/)
  })
})

describe('the administrator', () => {
  it('reads a name, "outsourced", or an in-house team', () => {
    expect(administratorOf('Juniper Fund Services')).toEqual({ outsourced: true, name: 'Juniper Fund Services' })
    expect(administratorOf('outsourced')).toEqual({ outsourced: true, name: null })
    expect(administratorOf('in-house')).toEqual({ outsourced: false, name: null })
    expect(administratorOf(null)).toEqual({ outsourced: false, name: null })
  })

  it('assigns the named administrator, and moves its tasks to the internal team when there is none', () => {
    expect(buildChecklist(base).tasks.find(t => t.key === 'adm_bank_rec')).toMatchObject({ owner: 'administrator', assignee: 'Juniper Fund Services' })
    const inHouse = buildChecklist({ ...base, administrator: 'in-house' })
    expect(inHouse.tasks.some(t => t.owner === 'administrator')).toBe(false)
    expect(inHouse.tasks.find(t => t.key === 'adm_bank_rec')).toMatchObject({ owner: 'internal' })
    expect(inHouse.warnings.join(' ')).toMatch(/internal team/)
  })
})

describe('the task that blocks the most downstream work', () => {
  it('is collecting the portfolio companies\' financials, in both kinds of fund', () => {
    for (const fundKind of ['venture', 'pe'] as const) {
      const { tasks } = buildChecklist({ ...base, fundKind })
      expect(criticalTask(tasks)!.task.key, fundKind).toBe('pc_financials')
    }
  })

  it('counts transitive dependents once each', () => {
    const counts = downstreamCounts([
      { key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a'] }, { key: 'c', dependsOn: ['a', 'b'] }, { key: 'd', dependsOn: ['c'] },
    ])
    expect(Object.fromEntries(counts)).toEqual({ a: 3, b: 2, c: 1, d: 0 })
  })

  it('moves on once the blocker is done, looking only at what is left', () => {
    const tasks = [
      { key: 'a', dependsOn: [], status: 'done' as const }, { key: 'b', dependsOn: ['a'], status: 'in_progress' as const },
      { key: 'c', dependsOn: ['b'] }, { key: 'd', dependsOn: ['c'] },
    ]
    expect(criticalTask(tasks)!.task.key).toBe('a')
    expect(criticalTask(tasks, { openOnly: true })).toMatchObject({ task: { key: 'b' }, downstream: 2 })
    expect(criticalTask(tasks.map(t => ({ ...t, status: 'done' as const })), { openOnly: true })).toBeNull()
  })

  it('finds a loop', () => {
    expect(findCycle([{ key: 'a', dependsOn: ['b'] }, { key: 'b', dependsOn: ['a'] }])).toEqual(['a', 'b', 'a'])
  })
})

describe('done versus tied out', () => {
  const alice = { userId: 'alice', isAdmin: false }
  const bob = { userId: 'bob', isAdmin: false }
  const admin = { userId: 'alice', isAdmin: true }
  const doneByAlice = { status: 'done' as const, tieOut: 'pending' as const, completedBy: 'alice' }

  it('ties out only a done task', () => {
    const r = decideTaskChange({ status: 'in_progress', tieOut: 'pending', completedBy: null }, { tieOut: 'tied_out' }, bob)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Only a done task/) })
  })

  it('lets a second person tie out, never the one who completed the task', () => {
    expect(decideTaskChange(doneByAlice, { tieOut: 'tied_out' }, bob)).toMatchObject({ ok: true, next: { tieOut: 'tied_out' } })
    expect(decideTaskChange(doneByAlice, { tieOut: 'tied_out' }, alice)).toMatchObject({ ok: false, error: expect.stringMatching(/someone else/) })
    // Marking done and tying out in one go is the same person on both columns.
    expect(decideTaskChange({ status: 'in_progress', tieOut: 'pending', completedBy: null }, { status: 'done', tieOut: 'tied_out' }, alice))
      .toMatchObject({ ok: false })
  })

  it('lets an admin tie out their own work only with a note', () => {
    expect(decideTaskChange(doneByAlice, { tieOut: 'tied_out' }, admin)).toMatchObject({ ok: false, error: expect.stringMatching(/note/) })
    expect(decideTaskChange(doneByAlice, { tieOut: 'tied_out', note: 'Sole finance person this quarter' }, admin))
      .toMatchObject({ ok: true, selfTieOut: true })
  })

  it('needs a note for an exception', () => {
    expect(decideTaskChange(doneByAlice, { tieOut: 'exception' }, bob)).toMatchObject({ ok: false, error: expect.stringMatching(/note/) })
    expect(decideTaskChange(doneByAlice, { tieOut: 'exception', note: 'Cash off by $1,240' }, bob)).toMatchObject({ ok: true })
  })

  it('un-ties a task that is reopened', () => {
    const r = decideTaskChange({ status: 'done', tieOut: 'tied_out', completedBy: 'alice' }, { status: 'in_progress' }, alice)
    expect(r).toMatchObject({ ok: true, next: { status: 'in_progress', tieOut: 'pending' }, resetTieOut: true })
  })

  it('will not tie out a task with no numbers until it is marked as needing one', () => {
    const none = { status: 'done' as const, tieOut: 'not_required' as const, completedBy: 'alice' }
    expect(decideTaskChange(none, { tieOut: 'tied_out' }, bob)).toMatchObject({ ok: false })
    expect(decideTaskChange(none, { tieOut: 'pending' }, bob)).toMatchObject({ ok: true })
  })
})

describe('describing a batch for approval', () => {
  it('knows which batches set a tie-out', () => {
    expect(touchesTieOut([{ task: 'a', status: 'done' }])).toBe(false)
    expect(touchesTieOut([{ task: 'a', status: 'done' }, { task: 'b', tie_out: 'tied_out' }])).toBe(true)
    expect(touchesTieOut(undefined)).toBe(false)
  })

  it('says what happens to each task', () => {
    expect(describeTaskUpdates([{ task: 'adm_bank_rec', tie_out: 'tied_out' }, { task: 'pc_financials', status: 'done', assignee: 'Dana' }]))
      .toEqual(['adm_bank_rec: tie out its numbers', 'pc_financials: mark done, assign to Dana'])
  })
})
