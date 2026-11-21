import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Audit (lib/audit-log): the automatic log of outside firms. Pins the switch, who sees it, how
 * the sources read as lines, the one write it adds, and that the tools follow the same rules.
 */

import {
  activityEntry, auditAccessProblem, auditOn, auditTrailEntry, auditVisibility, isChangeRequest, logWebChange,
  mergeEntries, readAuditLog, routeLabel, setAuditVisibility, type AuditEntry,
} from './index'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibility, type FeatureVisibilityMap } from '@/lib/types/features'
import { getTool, toolListedFor } from '@/lib/accounting/agent-tools'

const features = (audit: FeatureVisibility): FeatureVisibilityMap => ({ ...DEFAULT_FEATURE_VISIBILITY, audit })
const person = (
  role: AccessContext['role'],
  audit: FeatureVisibility,
  grants: Partial<Record<Domain, AccessLevel>> = {},
): AccessContext => ({ fundId: 'f1', userId: 'u1', role, features: features(audit), grants, defaults: {}, vehicles: { all: true, ids: [] } })

const email = (id: string | null) => (id ? `${id}@firm.example` : null)

describe('the switch', () => {
  it('is off by default, and reads in the words the settings use', () => {
    expect(DEFAULT_FEATURE_VISIBILITY.audit).toBe('off')
    expect(auditVisibility(features('everyone'))).toBe('members')
    expect(auditVisibility(features('admin'))).toBe('admins')
    expect(auditVisibility(features('hidden'))).toBe('off')
    expect(auditOn(features('off'))).toBe(false)
    expect(auditOn(null)).toBe(false)
  })

  it('shows members or only admins, and nobody while off', () => {
    expect(auditAccessProblem(person('admin', 'off'))).toMatch(/off/)
    expect(auditAccessProblem(person('admin', 'admin'))).toBeNull()
    expect(auditAccessProblem(person('member', 'admin', { records: 'write' }))).toMatch(/admins only/)
    expect(auditAccessProblem(person('member', 'everyone', { records: 'read' }))).toBeNull()
    expect(auditAccessProblem(person('member', 'everyone', { records: 'none' }))).toMatch(/do not have access/)
  })

  it('lets only an admin change it, to one of three values', async () => {
    const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { feature_visibility: { accounting: 'admin' } }, error: null }) }) }),
        update,
      }),
    }
    expect((await setAuditVisibility(db as any, person('member', 'everyone', { records: 'write' }), 'off')).ok).toBe(false)
    expect((await setAuditVisibility(db as any, person('admin', 'off'), 'sometimes')).ok).toBe(false)
    const r = await setAuditVisibility(db as any, person('admin', 'off'), 'admins')
    expect(r).toEqual({ ok: true, value: { visibility: 'admins' } })
    expect(update).toHaveBeenCalledWith({ feature_visibility: { accounting: 'admin', audit: 'admin' } })
  })
})

describe('the lines', () => {
  it('names the tool for an MCP or API write, and the subject for a change to the books', () => {
    const tool = auditTrailEntry({ created_at: '2026-01-02T10:00:00Z', actor_id: 'p1', action: 'agent.write', subject_type: 'agent_tool', subject_id: 'post_entry', source: 'mcp', tool: 'post_entry' }, email)
    expect(tool).toMatchObject({ door: 'mcp', type: 'change', summary: 'Ran post_entry', subject: null, person: 'p1@firm.example' })
    const entry = auditTrailEntry({ created_at: '2026-01-02T10:00:00Z', actor_id: 'p1', action: 'entry.void', subject_type: 'journal_entry', subject_id: 'e1', source: 'web' }, email)
    expect(entry).toMatchObject({ door: 'web', summary: 'entry void', subject: 'journal_entry e1' })
  })

  it('reads a connect entry as a session and a web change by its route', () => {
    expect(activityEntry({ created_at: '2026-01-02T09:00:00Z', user_id: 'p1', action: 'connect', metadata: { changeSource: 'mcp' } }, email))
      .toMatchObject({ type: 'session', door: 'mcp', summary: 'Connected an assistant (MCP)' })
    expect(activityEntry({ created_at: '2026-01-02T09:00:00Z', user_id: 'p1', action: 'web.change', metadata: { method: 'DELETE', route: 'api/compliance/items/[id]', path: '/api/compliance/items/x' } }, email))
      .toMatchObject({ type: 'change', door: 'web', summary: 'Deleted compliance › items' })
    expect(routeLabel('api/companies/[id]/notes')).toBe('companies › notes')
  })

  it('drops a web change when a more specific web line for the same person sits beside it', () => {
    const line = (at: string, action: string, personId = 'p1', door: AuditEntry['door'] = 'web'): AuditEntry =>
      ({ at, personId, person: null, door, type: 'change', action, summary: action, subject: null })
    const merged = mergeEntries([
      line('2026-01-02T10:00:05Z', 'web.change'),
      line('2026-01-02T10:00:04Z', 'entry.void'),
      line('2026-01-02T11:00:00Z', 'web.change'),
      line('2026-01-02T10:00:05Z', 'web.change', 'p2'),
      line('2026-01-02T10:00:04Z', 'agent.write', 'p1', 'mcp'),
    ])
    expect(merged.map(e => `${e.at.slice(11, 19)} ${e.personId} ${e.action}`)).toEqual([
      '11:00:00 p1 web.change',
      '10:00:05 p2 web.change',
      '10:00:04 p1 entry.void',
      '10:00:04 p1 agent.write',
    ])
  })
})

describe('the one write', () => {
  it('logs only changes, and only for someone on an engagement', async () => {
    expect(isChangeRequest('GET')).toBe(false)
    expect(isChangeRequest('patch')).toBe(true)

    const inserts: any[] = []
    const db = (engagement: string | null) => ({
      from: (table: string) => table === 'fund_members'
        ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { engagement_id: engagement } }) }) }) }) }
        : { insert: async (row: any) => { inserts.push(row) } },
    })
    const args = { fundId: 'f1', userId: 'u1', method: 'post', route: 'api/compliance/items', path: '/api/compliance/items' }
    await logWebChange(db(null), args)
    expect(inserts).toHaveLength(0)
    await logWebChange(db('eng1'), args)
    expect(inserts).toEqual([{
      fund_id: 'f1', user_id: 'u1', action: 'web.change',
      metadata: { method: 'POST', route: 'api/compliance/items', path: '/api/compliance/items', engagementId: 'eng1', changeSource: 'web' },
    }])
  })

  it('is wired into the proxy behind the switch, for members, after the gate', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'proxy.ts'), 'utf8')
    expect(src).toMatch(/!denial && access\.role === 'member' && isChangeRequest\(request\.method\) && auditOn\(access\.features\)/)
  })
})

describe('reading the log', () => {
  /** A fake admin client answering each table from fixed rows, honouring the filters the log uses. */
  function fakeDb(rows: Record<string, any[]>) {
    const query = (table: string) => {
      let data = [...(rows[table] ?? [])]
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => { data = data.filter(r => r[col] === undefined || r[col] === v); return q },
        in: (col: string, vs: unknown[]) => { data = data.filter(r => vs.includes(r[col])); return q },
        not: () => { data = data.filter(r => r.engagement_id); return q },
        is: (col: string) => { data = data.filter(r => r[col] == null); return q },
        or: () => q,
        gte: () => q, lte: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (res: (v: any) => unknown) => res({ data, error: null }),
      }
      return q
    }
    return { from: query, auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@firm.example` } } }) } } }
  }

  const rows = {
    engagements: [
      { id: 'e1', fund_id: 'f1', name: 'Acme Audit', kind: 'audit', member_history: ['p1'], ended_at: '2026-01-31T00:00:00Z' },
      { id: 'e2', fund_id: 'f1', name: 'Northwind Admin', kind: 'fund_admin', member_history: ['p2'] },
    ],
    fund_members: [{ user_id: 'p2', engagement_id: 'e2' }],
    accounting_audit_events: [
      { created_at: '2026-01-10T10:00:00Z', actor_id: 'p1', action: 'agent.write', subject_type: 'agent_tool', subject_id: 'post_entry', source: 'mcp', tool: 'post_entry' },
      { created_at: '2026-01-11T10:00:00Z', actor_id: 'p2', action: 'entry.post', subject_type: 'journal_entry', subject_id: 'j1', source: 'web' },
    ],
    user_activity_logs: [{ created_at: '2026-01-09T08:00:00Z', user_id: 'p1', action: 'connect', metadata: { changeSource: 'mcp' } }],
    fund_records: [],
  }

  it('groups by firm, keeps an ended firm, and shows someone on an engagement only their own', async () => {
    const admin = await readAuditLog(fakeDb(rows) as any, person('admin', 'admin'), { now: new Date('2026-02-01T00:00:00Z') })
    expect(admin.ok).toBe(true)
    if (!admin.ok) return
    expect(admin.value.firms.map(f => [f.name, f.entries.length, f.endedAt != null])).toEqual([
      ['Acme Audit', 2, true],
      ['Northwind Admin', 1, false],
    ])
    expect(admin.value.firms[0].entries.map(e => e.summary)).toEqual(['Ran post_entry', 'Connected an assistant (MCP)'])

    // p2 is on Northwind's engagement: the log narrows to it, whatever they ask for.
    const outsider = { ...person('member', 'everyone', { records: 'read' }), userId: 'p2' }
    const db = fakeDb({ ...rows, fund_members: [{ user_id: 'p2', engagement_id: 'e2', fund_id: 'f1' }] })
    const theirs = await readAuditLog(db as any, outsider, { now: new Date('2026-02-01T00:00:00Z') })
    expect(theirs.ok && theirs.value.firms.map(f => f.name)).toEqual(['Northwind Admin'])
    const other = await readAuditLog(db as any, outsider, { firm: 'Acme Audit' })
    expect(other.ok).toBe(false)
  })

  it('refuses while Audit is off', async () => {
    const r = await readAuditLog(fakeDb(rows) as any, person('admin', 'off'))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })
})

describe('the tools', () => {
  it('reads under the records grant and the audit switch, and only an admin changes the switch', () => {
    const log = getTool('audit_log')!
    const settings = getTool('audit_settings')!
    expect(log).toMatchObject({ scope: 'read', accessDomain: 'records', accessFeature: 'audit' })
    expect(settings).toMatchObject({ scope: 'write', accessDomain: 'admin' })
    expect(getTool('list_records')).toBeUndefined()

    expect(toolListedFor(person('member', 'everyone', { records: 'read' }), log)).toBe(true)
    expect(toolListedFor(person('member', 'admin', { records: 'write' }), log)).toBe(false)
    expect(toolListedFor(person('admin', 'off'), log)).toBe(false)
    expect(toolListedFor(person('admin', 'off'), settings)).toBe(true)
    expect(toolListedFor(person('member', 'everyone', { records: 'write' }), settings)).toBe(false)
  })
})
