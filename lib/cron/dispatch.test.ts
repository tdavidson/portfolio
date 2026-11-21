import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { CRON_WORKERS } from './kick'
import { dueWorkers, GATES } from './dispatch'

// A fake client: each table answers with whether it has a matching row. Filters are accepted and
// ignored; the gates' filters are pinned by reading them, not by re-implementing PostgREST.
function fakeAdmin(withRows: Record<string, boolean>, failing: string[] = []) {
  const builder = (table: string): any => {
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'lt', 'lte', 'not']) b[m] = () => b
    b.limit = () => Promise.resolve(failing.includes(table)
      ? { data: null, error: { message: 'relation does not exist' } }
      : { data: withRows[table] ? [{ id: 'x' }] : [], error: null })
    return b
  }
  return { from: builder }
}

const MONDAY = new Date('2026-11-23T13:10:00Z')
const TUESDAY = new Date('2026-11-24T13:10:00Z')

describe('cron tick dispatch', () => {
  it('starts nothing when no optional feature has work', async () => {
    expect(await dueWorkers(fakeAdmin({}), { now: MONDAY })).toEqual([])
  })

  it('starts only the workers whose feature has work', async () => {
    const admin = fakeAdmin({ company_update_artifacts: true, fund_settings: true })
    expect(await dueWorkers(admin, { now: TUESDAY })).toEqual(['company-updates-ocr', 'ops-reminders'])
  })

  it('sends the digest on Mondays only', async () => {
    const admin = fakeAdmin({ fund_settings: true })
    expect(await dueWorkers(admin, { now: MONDAY })).toContain('deals-digest')
    expect(await dueWorkers(admin, { now: TUESDAY })).not.toContain('deals-digest')
  })

  it('the queues scope never runs a once-a-day job', async () => {
    const all = Object.fromEntries(['memo_agent_jobs', 'company_update_artifacts', 'entity_documents', 'inbound_deals',
      'company_update_backfill_jobs', 'diligence_deals', 'fund_members', 'fund_settings'].map(t => [t, true]))
    expect(await dueWorkers(fakeAdmin(all), { scope: 'queues', now: MONDAY })).toEqual([
      'memo-agent-worker', 'company-updates-ocr', 'entity-documents-ocr', 'deal-research', 'company-updates-backfill',
    ])
  })

  it('treats a failed read (e.g. a migration not yet applied) as no work', async () => {
    const admin = fakeAdmin({ memo_agent_jobs: true, entity_documents: true }, ['entity_documents'])
    expect(await dueWorkers(admin, { now: TUESDAY })).toEqual(['memo-agent-worker'])
  })

  it('every worker has a gate and a route, and vercel.json schedules only the tick', () => {
    expect(GATES.map(g => g.worker).sort()).toEqual([...CRON_WORKERS].sort())
    const dir = path.join(__dirname, '..', '..', 'app/api/cron')
    const routes = readdirSync(dir).filter(d => d !== 'tick').sort()
    expect(routes).toEqual([...CRON_WORKERS].sort())
    const vercel = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'vercel.json'), 'utf8'))
    expect(vercel.crons).toEqual([{ path: '/api/cron/tick', schedule: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }])
  })
})
