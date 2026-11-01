import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Fund records (lib/records): what a person or their assistant files from a session. Pins who may
 * file and read (read on the area, the entity in scope), the shape of a filing, and that the web
 * route and every tool door reach the same rule.
 */

import { matchEntity, parseFiling, visible } from './index'
import { RECORD_AREAS, readableAreas, recordAccessProblem } from './areas'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { ACCESS_PRESETS } from '@/lib/access/presets'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { authorizeToolCall, getTool, toolListedFor, accessDomainForCall } from '@/lib/accounting/agent-tools'
import { authorizeMcpTool, listableTools, MCP_TOOLS } from '@/lib/mcp-apps/server'
import type { ResolvedKey } from '@/lib/accounting/api-keys'

const ALL_ON = Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap
const person = (
  role: AccessContext['role'],
  grants: Partial<Record<Domain, AccessLevel>> = {},
  vehicles: AccessContext['vehicles'] = { all: true, ids: [] },
): AccessContext => ({ fundId: 'f1', userId: 'u1', role, features: ALL_ON, grants, defaults: {}, vehicles })
const preset = (label: string) => person('member', ACCESS_PRESETS.find(p => p.label === label)!.grants)
const key = (scopes: ('read' | 'write')[] = ['read', 'write']): ResolvedKey => ({ fundId: 'f1', keyId: 'k1', userId: 'u1', role: 'member', scopes })

describe('who may file and read', () => {
  it('lets a reader file in their area: an auditor into accounting, a tax preparer into tax', () => {
    expect(recordAccessProblem(preset('Auditor'), { area: 'accounting', filing: true })).toBeNull()
    expect(recordAccessProblem(preset('Tax preparer'), { area: 'tax', filing: true })).toBeNull()
  })

  it('refuses an area the person cannot read', () => {
    expect(recordAccessProblem(preset('Investment team'), { area: 'tax', filing: true })).toMatch(/do not have access/)
    expect(recordAccessProblem(person('member'), { filing: false })).toMatch(/no area/)
  })

  it('makes a filing name its area, and refuses an unknown one', () => {
    expect(recordAccessProblem(person('admin'), { filing: true })).toMatch(/Name the area/)
    expect(recordAccessProblem(person('admin'), { area: 'admin', filing: true })).toMatch(/Unknown area/)
  })

  it('lets the read-only demo read but never file', () => {
    expect(recordAccessProblem(person('viewer'), { area: 'accounting', filing: false })).toBeNull()
    expect(recordAccessProblem(person('viewer'), { area: 'accounting', filing: true })).toMatch(/demo/)
  })

  it('shows a record only with read on its area and its entity in scope', () => {
    const scoped = person('member', { accounting: 'read' }, { all: false, ids: ['v1'] })
    expect(visible(scoped, { area: 'accounting', vehicle_id: 'v1' })).toBe(true)
    expect(visible(scoped, { area: 'accounting', vehicle_id: 'v2' })).toBe(false)
    expect(visible(scoped, { area: 'accounting', vehicle_id: null })).toBe(false)
    expect(visible(scoped, { area: 'lp_relations', vehicle_id: 'v1' })).toBe(false)
    expect(visible(person('admin'), { area: 'tax', vehicle_id: null })).toBe(true)
  })

  it('never offers admin as an area', () => {
    expect(RECORD_AREAS as readonly string[]).not.toContain('admin')
    expect(readableAreas(person('admin'))).toEqual([...RECORD_AREAS])
  })
})

describe('a filing', () => {
  const ok = { area: 'accounting', title: 'Q3 journal review', body: 'Two reclasses proposed.' }

  it('defaults to a summary and keeps the entity as given', () => {
    expect(parseFiling({ ...ok, entity: ' Example Fund I ' })).toMatchObject({ kind: 'summary', entity: 'Example Fund I', subjectType: null })
  })

  it('needs a title and a body, within limits', () => {
    expect(parseFiling({ ...ok, title: ' ' })).toHaveProperty('error')
    expect(parseFiling({ ...ok, body: '' })).toHaveProperty('error')
    expect(parseFiling({ ...ok, title: 'x'.repeat(201) })).toHaveProperty('error')
    expect(parseFiling({ ...ok, body: 'x'.repeat(100_001) })).toHaveProperty('error')
  })

  it('takes a subject only as a known type with an id', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(parseFiling({ ...ok, subject_type: 'journal_entry', subject_id: id })).toMatchObject({ subjectType: 'journal_entry', subjectId: id })
    expect(parseFiling({ ...ok, subject_type: 'journal_entry' })).toHaveProperty('error')
    expect(parseFiling({ ...ok, subject_type: 'spaceship', subject_id: id })).toHaveProperty('error')
    expect(parseFiling({ ...ok, subject_type: 'company', subject_id: 'Acme' })).toHaveProperty('error')
    expect(parseFiling({ ...ok, kind: 'gossip' })).toHaveProperty('error')
  })

  it('finds an entity by id or by name, and says when a name is ambiguous', () => {
    const names = new Map([['v1', 'Example Fund I'], ['v2', 'Example Fund II'], ['v3', 'example fund ii']])
    expect(matchEntity(names, 'v1')).toBe('v1')
    expect(matchEntity(names, 'EXAMPLE FUND I')).toBe('v1')
    expect(matchEntity(names, 'Example Fund II')).toBe('ambiguous')
    expect(matchEntity(names, 'Northwind')).toBeNull()
  })
})

describe('every door', () => {
  const file = getTool('file_to_record')!
  const list = getTool('list_records')!

  it('files directly from a chat, since it changes nothing else', () => {
    expect(file).toMatchObject({ scope: 'write', runsDirectly: true, areaInput: true })
    expect(file.stagesAs).toBeUndefined()
    expect(file.destructive).toBeUndefined()
  })

  it('answers the same on MCP and the API, by the rule the web route uses', () => {
    const people = [person('admin'), person('viewer'), person('member'), ...ACCESS_PRESETS.map(p => person('member', p.grants))]
    const mcpFile = MCP_TOOLS.find(t => t.name === 'file_to_record')!
    for (const access of people) {
      for (const area of RECORD_AREAS) {
        const web = recordAccessProblem(access, { area, filing: true })
        const api = authorizeToolCall(file, key(), access, { area })
        const mcp = authorizeMcpTool(mcpFile, key(), access, { area })
        expect([api, mcp], `${access.role} ${area}`).toEqual([web, web])
      }
    }
  })

  it('needs a credential that may write to file, but not to read', () => {
    expect(authorizeToolCall(file, key(['read']), person('admin'), { area: 'accounting' })).toMatch(/read-only/)
    expect(authorizeToolCall(list, key(['read']), person('admin'), {})).toBeNull()
  })

  it('lists the tools for anyone who reads some area, on MCP and the API alike', () => {
    expect(toolListedFor(preset('Auditor'), file)).toBe(true)
    expect(toolListedFor(person('member'), list)).toBe(false)
    expect(toolListedFor(person('viewer'), file)).toBe(false)
    expect(toolListedFor(person('viewer'), list)).toBe(true)
    expect(listableTools(preset('Auditor')).some(t => t.name === 'file_to_record')).toBe(true)
  })

  it('records a staged call\'s domain as the area it names', () => {
    expect(accessDomainForCall(file, { area: 'tax' })).toBe('tax')
  })

  it('routes the web through lib/records, and keeps the table to the service role', () => {
    const root = join(__dirname, '..', '..')
    const route = readFileSync(join(root, 'app/api/records/route.ts'), 'utf8')
    for (const fn of ['fileRecord(', 'listRecords(', 'readRecord(']) expect(route).toContain(fn)
    const sql = readFileSync(join(root, 'supabase/migrations/20261101140000_fund_records.sql'), 'utf8')
    expect(sql).toContain('revoke all on public.fund_records from anon, authenticated;')
    expect(sql).toContain('alter table public.fund_records enable row level security;')
    expect(sql).not.toMatch(/grant[^;]*update[^;]*fund_records/i)
  })
})
