import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The access lockdown: the admin-only tier above write, the Tax area, role presets and access
 * that ends on a date. The middleware cases run the real proxy with the access_context RPC stubbed,
 * as tests/middleware-access-gate.test.ts does.
 */

const getUser = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null }) } },
    from,
    rpc,
  }),
}))

import { proxy } from '@/proxy'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import {
  ADMIN_ONLY_ROUTES, ADMIN_ONLY_TOOLS, ADMIN_ONLY_ACTIONS, HANDLER_CHECKED, UNREADABLE,
  adminOnlyRule, adminRuleNeedsBody, adminOnlyDenial,
} from '@/lib/access/admin-only'
import { ROUTE_DOMAINS } from '@/lib/access/route-domains'
import { PAGE_DOMAINS } from '@/lib/access/page-domains'
import { DOMAINS, DOMAIN_META, type Domain } from '@/lib/access/domains'
import { effectiveAccess, hasAccess, type AccessContext, type AccessLevel } from '@/lib/access/effective'
import { ACCESS_PRESETS, getPreset } from '@/lib/access/presets'
import { accessExpiryProblem, normalizeExpiry, endExpiredAccess } from '@/lib/access/expiry'
import { getTool } from '@/lib/accounting/agent-tools'
import { getWriteAction } from '@/lib/pending-actions/registry'
import { stagedAction } from '@/lib/pending-actions/staged'
import { memoryAdmin } from './helpers/memory-admin'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

// ── The middleware ──────────────────────────────────────────────────────────────────────────

let role = 'member'
let features: Record<string, string> = {}
let grants: Record<string, string> = {}
let defaults: Record<string, string> = {}

const req = (pathname: string, method = 'GET', body?: unknown) =>
  ({
    nextUrl: { pathname, search: '', clone: () => new URL(`https://x${pathname}`) },
    cookies: { getAll: () => [], set: () => {} },
    method,
    headers: new Headers(),
    clone: () => ({ json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body) }),
  }) as any

beforeEach(() => {
  vi.clearAllMocks()
  role = 'member'
  features = { accounting: 'everyone', lps: 'everyone', gp_economics: 'everyone', tax_reporting: 'everyone' }
  grants = {}
  defaults = {}
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  rpc.mockImplementation(async () => ({
    data: { fund_id: 'f1', role, features: { ...DEFAULT_FEATURE_VISIBILITY, ...features }, grants, defaults, vehicles_all: true, vehicles: [] },
    error: null,
  }))
  from.mockImplementation(() => {
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: async () => ({ data: null, error: null }) }
    return chain
  })
})

describe('admin-only operations, at the API boundary', () => {
  it('refuses a member with Fund accounting write who tries to unpost an entry', async () => {
    grants = { accounting: 'write' }
    const res = await proxy(req('/api/accounting/journal', 'PATCH', { action: 'unpost', id: 'e1' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only an admin can unpost or reverse a posted entry.' })
  })

  it('lets the same member edit a draft through the same route', async () => {
    grants = { accounting: 'write' }
    const res = await proxy(req('/api/accounting/journal', 'PATCH', { action: 'edit', id: 'e1' }))
    expect(res?.status).not.toBe(403)
  })

  it('lets an admin through', async () => {
    role = 'admin'
    const res = await proxy(req('/api/accounting/capital-calls', 'POST', { action: 'issue' }))
    expect(res?.status).not.toBe(403)
  })

  it('treats a body it cannot read as the admin-only request, not as a pass', async () => {
    grants = { accounting: 'write' }
    const res = await proxy(req('/api/accounting/capital-calls', 'POST'))
    expect(res.status).toBe(403)
  })

  it('refuses deleting a company, issuing a call and publishing statements to a member with write', async () => {
    grants = { portfolio: 'write', accounting: 'write' }
    for (const [p, m, b] of [
      ['/api/companies/c1', 'DELETE', undefined],
      ['/api/accounting/capital-calls', 'POST', { action: 'issue' }],
      ['/api/accounting/lp-statement/publish', 'POST', {}],
    ] as const) {
      expect((await proxy(req(p, m, b))).status, `${m} ${p}`).toBe(403)
    }
  })

  it('refuses deleting a deal room, removing a member and merging entities to a member with write, as the tools are', async () => {
    grants = { diligence: 'write', accounting: 'write', admin: 'write' }
    for (const [p, m, b] of [
      ['/api/diligence/d1', 'DELETE', undefined],
      ['/api/settings/members/m1', 'DELETE', undefined],
      ['/api/vehicles', 'PATCH', { id: 'v2', mergeIntoId: 'v1' }],
    ] as const) {
      expect((await proxy(req(p, m, b))).status, `${m} ${p}`).toBe(403)
    }
    // Renaming an entity is not a merge.
    expect((await proxy(req('/api/vehicles', 'PATCH', { id: 'v2', name: 'Fund II' })))?.status).not.toBe(403)
    expect(adminOnlyRule('api/vehicles', 'PATCH', { id: 'v2', mergeIntoId: 'v1' })?.label).toBe('merge entities')
    expect(adminOnlyRule('api/vehicles', 'PATCH', { id: 'v2', name: 'x' })).toBeUndefined()
    // The same words as the tools'.
    for (const [route, method, tool] of [
      ['api/diligence/[id]', 'DELETE', 'diligence_delete_deal'],
      ['api/settings/members/[id]', 'DELETE', 'remove_member'],
      ['api/vehicles', 'PATCH', 'merge_vehicles'],
    ] as const) {
      expect(adminOnlyRule(route, method, { mergeIntoId: 'v1' })?.label, route).toBe(ADMIN_ONLY_TOOLS[tool].label)
    }
  })

  it('lets a tax preparer post adjustments but not finalize K-1s or reopen the tax year', async () => {
    grants = { accounting: 'read', tax: 'write', gp_economics: 'read' }
    expect((await proxy(req('/api/accounting/tax-adjustments', 'POST', { taxYear: 2026 })))?.status).not.toBe(403)
    expect((await proxy(req('/api/accounting/k1-packages', 'POST', { action: 'generate' })))?.status).not.toBe(403)
    expect((await proxy(req('/api/accounting/k1-packages', 'POST', { action: 'finalize' }))).status).toBe(403)
    expect((await proxy(req('/api/accounting/tax-year', 'POST', { action: 'reopen' }))).status).toBe(403)
    expect((await proxy(req('/api/accounting/k1-deliveries', 'POST', { action: 'deliver' }))).status).toBe(403)
    // …and still cannot touch the books themselves.
    expect((await proxy(req('/api/accounting/journal', 'POST', {}))).status).toBe(403)
  })
})

describe('the admin-only list', () => {
  it('names only routes that exist, on methods they export', () => {
    for (const r of ADMIN_ONLY_ROUTES) {
      expect(ROUTE_DOMAINS[r.route], `${r.route} is not in ROUTE_DOMAINS`).toBeDefined()
      const file = path.join('app', r.route, 'route.ts')
      expect(existsSync(path.join(ROOT, file)), file).toBe(true)
      expect(read(file), `${file} has no ${r.method}`).toMatch(new RegExp(`export (async function|const) ${r.method}\\b`))
    }
  })

  it('reads the body only for routes that multiplex on it', () => {
    expect(adminRuleNeedsBody('api/accounting/journal', 'PATCH')).toBe(true)
    expect(adminRuleNeedsBody('api/companies/[id]', 'DELETE')).toBe(false)
    expect(adminRuleNeedsBody('api/accounting/journal', 'GET')).toBe(false)
    expect(adminOnlyRule('api/accounting/periods', 'POST', { action: 'close' })).toBeUndefined()
    expect(adminOnlyRule('api/accounting/periods', 'POST', { action: 'reopen' })?.label).toBe('reopen a closed period')
    expect(adminOnlyRule('api/accounting/periods', 'POST', UNREADABLE)).toBeDefined()
  })

  it('checks voiding a posted entry in the journal handler, where the database can say it is posted', () => {
    // The handler's state change lives in lib/accounting/journal-state.ts, shared with the void_entry tool.
    expect(read('app/api/accounting/journal/route.ts')).toContain('changeEntryState')
    expect(read('lib/accounting/journal-state.ts')).toContain('HANDLER_CHECKED.voidPostedEntry')
    expect(adminOnlyDenial('member', HANDLER_CHECKED.voidPostedEntry)).toBe('Only an admin can void a posted entry.')
    expect(adminOnlyDenial('admin', HANDLER_CHECKED.voidPostedEntry)).toBeNull()
  })

  it('names only tools and Analyst actions that exist, and marks them for approval', () => {
    for (const tool of Object.keys(ADMIN_ONLY_TOOLS)) {
      expect(getTool(tool), tool).toBeDefined()
      expect(stagedAction('agent_tool_call', { tool, input: {} })?.adminOnly, tool).toBeTruthy()
    }
    for (const action of Object.keys(ADMIN_ONLY_ACTIONS)) {
      expect(getWriteAction(action), action).toBeDefined()
      expect(stagedAction(action, {})?.adminOnly, action).toBe(ADMIN_ONLY_ACTIONS[action])
    }
    expect(stagedAction('agent_tool_call', { tool: 'add_account', input: {} })?.adminOnly).toBeUndefined()
  })
})

// ── The Tax area ────────────────────────────────────────────────────────────────────────────

const ctx = (g: Partial<Record<Domain, AccessLevel>>, d: Partial<Record<Domain, AccessLevel>> = {}, r: AccessContext['role'] = 'member'): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: r, grants: g, defaults: d, vehicles: { all: true, ids: [] },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone', tax_reporting: 'everyone' } as FeatureVisibilityMap,
})

describe('the Tax area', () => {
  it('gives tax write without journal write', () => {
    const preparer = ctx({ accounting: 'read', tax: 'write' })
    expect(effectiveAccess(preparer, 'tax')).toBe('write')
    expect(effectiveAccess(preparer, 'accounting')).toBe('read')
  })

  it('is closed to anyone who cannot read the books, whatever its own grant says', () => {
    expect(effectiveAccess(ctx({ tax: 'write' }), 'tax')).toBe('none')
    expect(effectiveAccess(ctx({ accounting: 'none', tax: 'write' }, { accounting: 'write' }), 'tax')).toBe('none')
  })

  it('falls back to the accounting level until the fund has a tax default, so the deploy locks no one out', () => {
    expect(effectiveAccess(ctx({ accounting: 'write' }), 'tax')).toBe('write')
    expect(effectiveAccess(ctx({}, { accounting: 'read' }), 'tax')).toBe('read')
    // Once the migration seeds a default, it decides.
    expect(effectiveAccess(ctx({ accounting: 'write' }, { tax: 'none' }), 'tax')).toBe('none')
  })

  it('is off for everyone, admins included, when the fund does not do tax reporting', () => {
    const off = { ...ctx({ accounting: 'write', tax: 'write' }, {}, 'admin'), features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone' } as FeatureVisibilityMap }
    expect(effectiveAccess(off, 'tax')).toBe('none')
  })

  it('gates every tax route and the tax page on the Tax area', () => {
    const taxRoutes = Object.entries(ROUTE_DOMAINS).filter(([, e]) => e.feature === 'tax_reporting')
    expect(taxRoutes.length).toBeGreaterThanOrEqual(9)
    for (const [key, entry] of taxRoutes) expect(entry.domain, key).toBe('tax')
    expect(PAGE_DOMAINS['funds/[id]/tax']).toMatchObject({ domain: 'tax' })
    expect(read('app/(app)/funds/[id]/tax/page.tsx')).toContain("domain: 'tax'")
  })

  it('ships a migration that copies everyone’s accounting access into tax', () => {
    const sql = read('supabase/migrations/20261012150000_tax_domain.sql')
    expect(sql).toMatch(/insert into public\.fund_domain_defaults[\s\S]*'tax'[\s\S]*d\.domain = 'accounting'/)
    expect(sql).toMatch(/insert into public\.fund_member_access[\s\S]*'tax'[\s\S]*a\.domain = 'accounting'/)
    expect(sql).toContain("('tax', 'write')")
  })
})

// ── Presets ─────────────────────────────────────────────────────────────────────────────────

describe('role presets', () => {
  const grantable = DOMAINS.filter(d => !DOMAIN_META[d].adminOnly)

  it('set every grantable area, so applying one leaves nothing on a stale grant', () => {
    for (const p of ACCESS_PRESETS) expect(Object.keys(p.grants).sort(), p.key).toEqual([...grantable].sort())
  })

  it('give an auditor read on every financial area and write on none', () => {
    const auditor = getPreset('auditor')!
    expect(Object.values(auditor.grants)).not.toContain('write')
    for (const d of ['accounting', 'lp_capital', 'gp_economics', 'management_company', 'tax', 'lp_relations', 'compliance'] as const) {
      expect(auditor.grants[d], d).toBe('read')
    }
    expect(auditor.grants.dealflow).toBe('none')
    expect(auditor.grants.relationships).toBe('none')
  })

  it('let a tax preparer change only the Tax area, and actually hold it', () => {
    const tax = getPreset('tax')!
    const writes = Object.entries(tax.grants).filter(([, l]) => l === 'write').map(([d]) => d)
    expect(writes).toEqual(['tax'])
    const resolved = ctx(tax.grants)
    expect(effectiveAccess(resolved, 'tax')).toBe('write')
    expect(hasAccess(resolved, 'accounting', 'write')).toBe(false)
  })

  it('keep the investment team out of the books and LP capital', () => {
    const team = getPreset('investment_team')!
    const resolved = ctx(team.grants)
    for (const d of ['accounting', 'lp_capital', 'gp_economics', 'tax'] as const) expect(effectiveAccess(resolved, d), d).toBe('none')
  })

  it('are offered by the settings route and applied as one grant per area', () => {
    const src = read('app/api/settings/access/route.ts')
    expect(src).toContain('getPreset(body.preset)')
    expect(src).toContain("onConflict: 'fund_id,user_id,domain'")
  })
})

// ── Access that ends on a date ──────────────────────────────────────────────────────────────

describe('access expiry', () => {
  const now = new Date('2026-10-12T12:00:00Z')

  it('refuses a date on an admin, on the demo account, or in the past', () => {
    expect(accessExpiryProblem({ target: { role: 'admin' }, expiresAt: '2027-01-01', now })?.status).toBe(400)
    expect(accessExpiryProblem({ target: { role: 'viewer' }, expiresAt: '2027-01-01', now })?.status).toBe(400)
    expect(accessExpiryProblem({ target: { role: 'member' }, expiresAt: '2026-01-01', now })?.error).toMatch(/future/)
    expect(accessExpiryProblem({ target: { role: 'member' }, expiresAt: 'soon', now })?.status).toBe(400)
    expect(accessExpiryProblem({ target: null, expiresAt: '2027-01-01', now })?.status).toBe(404)
  })

  it('accepts a future date on a member, and clearing one on anyone', () => {
    expect(accessExpiryProblem({ target: { role: 'member' }, expiresAt: '2027-03-31', now })).toBeNull()
    expect(accessExpiryProblem({ target: { role: 'admin' }, expiresAt: null, now })).toBeNull()
  })

  it('ends a date-only value at the end of that day', () => {
    expect(normalizeExpiry('2027-03-31')).toBe('2027-03-31T23:59:59.999Z')
  })

  it('removes expired members and their entity grants, and never an admin', async () => {
    const store = memoryAdmin({
      fund_members: [
        { id: 'm1', fund_id: 'f1', user_id: 'auditor', role: 'member', access_expires_at: '2026-10-01T00:00:00Z' },
        { id: 'm2', fund_id: 'f1', user_id: 'tax', role: 'member', access_expires_at: '2027-04-15T00:00:00Z' },
        { id: 'm3', fund_id: 'f1', user_id: 'boss', role: 'admin', access_expires_at: '2026-01-01T00:00:00Z' },
        { id: 'm4', fund_id: 'f1', user_id: 'staff', role: 'member', access_expires_at: null },
      ],
      fund_member_vehicles: [{ fund_id: 'f1', user_id: 'auditor', vehicle_id: 'v1' }, { fund_id: 'f1', user_id: 'tax', vehicle_id: 'v1' }],
      fund_settings: [],
      user_activity_logs: [],
    })
    const ended = await endExpiredAccess(store.admin as any, now)
    expect(ended).toEqual([{ fundId: 'f1', userId: 'auditor' }])
    expect(store.tables.fund_members.map((m: any) => m.user_id).sort()).toEqual(['boss', 'staff', 'tax'])
    expect(store.tables.fund_member_vehicles.map((g: any) => g.user_id)).toEqual(['tax'])
  })

  it('stops resolving an expired membership in access_context itself, so every surface refuses at once', () => {
    const sql = read('supabase/migrations/20261012160000_member_access_expiry.sql')
    expect(sql).toContain('create or replace function public.access_context(')
    expect(sql).toMatch(/m\.role = 'admin' or m\.access_expires_at is null or m\.access_expires_at > now\(\)/)
  })

  it('runs the sweep on a schedule, behind the cron secret', () => {
    const vercel = JSON.parse(read('vercel.json'))
    expect(vercel.crons.map((c: any) => c.path)).toContain('/api/cron/access-expiry')
    expect(read('app/api/cron/access-expiry/route.ts')).toContain('cronAuthDenial(req)')
  })
})
