import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Setting a fund up without the web app: the `setup_fund` plan (MCP and POST /api/agent), the
 * consent screen creating a fund for someone who has none, and the setup prompt.
 */

vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: vi.fn(async () => {}) }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: vi.fn() }))

import { memoryAdmin } from './helpers/memory-admin'
import { addProducts, applySetupPlan, describeSetupPlan, parseSetupPlan, type SetupPlan } from '@/lib/onboarding/setup-plan'
import { fundCreationRefusal, newSettingsRow } from '@/lib/onboarding/create-fund'
import { buildFeatureVisibility } from '@/lib/onboarding/wizard'
import { DOMAIN_META } from '@/lib/access/domains'
import { getPreset } from '@/lib/access/presets'
import { AGENT_TOOLS, getTool } from '@/lib/accounting/agent-tools'
import { STEP_TOOLS } from '@/lib/agent/setup-tools'
import { SETUP_PROMPT } from '@/lib/onboarding/setup-prompt'
import { PROMPT_TEMPLATES } from '@/lib/agent/getting-started'

const NOW = new Date('2026-10-12T12:00:00Z')

function plan(raw: unknown): SetupPlan {
  const p = parseSetupPlan(raw, NOW)
  if ('error' in p) throw new Error(p.error)
  return p
}

describe('parseSetupPlan', () => {
  it('takes only the no-key AI choice; a server key is never set from a plan', () => {
    expect(parseSetupPlan({ aiMode: 'assistant' }, NOW)).toEqual({ aiMode: 'assistant' })
    expect(parseSetupPlan({ aiMode: 'server_key' }, NOW)).toEqual({ error: expect.stringMatching(/Settings/) })
    expect(describeSetupPlan({ aiMode: 'assistant' })).toEqual(['Run AI through your own assistant, with no server key'])
  })

  it('refuses an empty plan, an unknown product, a duplicate email and a preset on an admin', () => {
    expect(parseSetupPlan({}, NOW)).toEqual({ error: expect.stringMatching(/empty/) })
    expect(parseSetupPlan({ products: ['crypto'] }, NOW)).toEqual({ error: expect.stringMatching(/products must be/) })
    expect(parseSetupPlan({ team: [{ email: 'a@x.com' }, { email: 'A@x.com ' }] }, NOW)).toEqual({ error: 'a@x.com is listed twice.' })
    expect(parseSetupPlan({ team: [{ email: 'a@x.com', role: 'admin', preset: 'cfo' }] }, NOW)).toEqual({ error: expect.stringMatching(/preset is for members/) })
    expect(parseSetupPlan({ team: [{ email: 'a@x.com', preset: 'nope' }] }, NOW)).toEqual({ error: expect.stringMatching(/preset must be one of/) })
    expect(parseSetupPlan({ team: [{ email: 'not-an-email' }] }, NOW)).toEqual({ error: expect.stringMatching(/valid email/) })
  })

  it('refuses an end date in the past, and an end date on an admin', () => {
    expect(parseSetupPlan({ team: [{ email: 'a@x.com', preset: 'auditor', accessEndsOn: '2026-01-01' }] }, NOW)).toHaveProperty('error')
    expect(parseSetupPlan({ team: [{ email: 'a@x.com', role: 'admin', accessEndsOn: '2027-01-01' }] }, NOW)).toHaveProperty('error')
  })

  it('normalizes emails, defaults members to every entity, and accepts senders as bare strings', () => {
    const p = plan({ team: [{ email: ' CFO@Firm.com ', preset: 'cfo' }], authorizedSenders: ['Updates@Co.com'] })
    expect(p.team).toEqual([{ email: 'cfo@firm.com', role: 'member', preset: 'cfo', accessEndsOn: null, entities: 'all' }])
    expect(p.authorizedSenders).toEqual([{ email: 'updates@co.com', label: null }])
  })

  it('describes every change for the approval preview', () => {
    const lines = describeSetupPlan(plan({
      fundName: 'Hemrock I', products: ['portfolio_reporting'], entities: [{ name: 'Fund I', kind: 'fund' }],
      team: [{ email: 'a@x.com', preset: 'auditor', accessEndsOn: '2027-03-31' }], authorizedSenders: ['u@co.com'], finish: true,
    }))
    expect(lines[0]).toBe('Name the fund "Hemrock I"')
    expect(lines.some(l => l.startsWith('Create the entity "Fund I"'))).toBe(true)
    expect(lines.some(l => l.includes('a@x.com') && l.includes('access ends 2027-03-31'))).toBe(true)
    expect(lines).toContain('Mark setup as finished')
  })
})

describe('addProducts', () => {
  it('turns products on and never switches anything off', () => {
    const current = buildFeatureVisibility(['portfolio_reporting', 'fund_operations'])
    const next = addProducts(current, ['portfolio_reporting', 'management_company'])
    for (const [k, v] of Object.entries(current)) {
      if (v !== 'off' && v !== 'hidden') expect(next[k as keyof typeof next]).toBe(v)
    }
    expect(next.management_company).toBe('admin')
  })
})

// --- applying a plan --------------------------------------------------------------------------

const FUND = 'fund-1'
const ACTOR = 'u-admin'

function setup(opts: { users?: { id: string; email: string }[]; settings?: Record<string, unknown>; seed?: Record<string, any[]> } = {}) {
  const users = [{ id: ACTOR, email: 'gp@firm.com' }, ...(opts.users ?? [])]
  const mem = memoryAdmin({
    funds: [{ id: FUND, name: 'Untitled' }],
    fund_settings: [{ fund_id: FUND, feature_visibility: buildFeatureVisibility(['portfolio_reporting']), onboarding: null, ...opts.settings }],
    fund_members: [{ fund_id: FUND, user_id: ACTOR, role: 'admin' }],
    ...opts.seed,
  }, { unique: [{ table: 'allowed_signups', key: r => `${r.fund_id}|${r.email_pattern}` }] })
  const invites: string[] = []
  ;(mem.admin as any).auth = {
    admin: {
      listUsers: async () => ({ data: { users }, error: null }),
      inviteUserByEmail: async (email: string) => {
        invites.push(email)
        const u = { id: `u-${email}`, email }
        users.push(u)
        return { data: { user: u }, error: null }
      },
    },
  }
  return { ...mem, invites }
}

describe('applySetupPlan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets a new fund up: name, products, entities, senders, a member with a preset, finished', async () => {
    const { admin, tables, invites } = setup()
    const p = plan({
      fundName: 'Hemrock Ventures',
      products: ['portfolio_reporting', 'fund_operations'],
      entities: [{ name: 'Hemrock Fund I', kind: 'fund', vintageYear: 2026 }],
      team: [{ email: 'cfo@firm.com', preset: 'cfo', accessEndsOn: '2027-06-30' }],
      authorizedSenders: [{ email: 'updates@portco.com', label: 'Portco' }],
      finish: true,
    })
    const r = await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, p)

    expect(r.fundName).toBe('Hemrock Ventures')
    expect(tables.funds[0].name).toBe('Hemrock Ventures')
    expect(r.products).toEqual({ mode: 'chosen', on: ['portfolio_reporting', 'fund_operations'] })
    expect(r.entities).toEqual([{ name: 'Hemrock Fund I', status: 'created', id: expect.any(String) }])
    expect(tables.fund_vehicles).toHaveLength(1)
    expect(r.authorizedSenders).toEqual([{ email: 'updates@portco.com', status: 'created' }])

    // The member: allowed to sign up, invited, added, their preset and end date applied.
    expect(r.team).toEqual([{ email: 'cfo@firm.com', status: 'invited' }])
    expect(invites).toEqual(['cfo@firm.com'])
    expect(tables.allowed_signups.map(a => [a.email_pattern, a.fund_id])).toEqual([['cfo@firm.com', FUND]])
    const member = tables.fund_members.find(m => m.user_id === 'u-cfo@firm.com')!
    expect(member).toMatchObject({ role: 'member', invited_by: ACTOR, all_entities: true, access_expires_at: expect.stringMatching(/^2027-06-30/) })
    const grants = tables.fund_member_access.filter(g => g.user_id === member.user_id)
    expect(Object.fromEntries(grants.map(g => [g.domain, g.level]))).toEqual(getPreset('cfo')!.grants)

    // Every area the preset grants that the fund kept "Admins only" is opened, with its default none.
    const vis = tables.fund_settings[0].feature_visibility
    for (const [domain, level] of Object.entries(getPreset('cfo')!.grants)) {
      if (level === 'none') continue
      const meta = DOMAIN_META[domain as keyof typeof DOMAIN_META]
      for (const key of meta.primaryFeature ? [meta.primaryFeature] : meta.features) expect(vis[key]).not.toBe('admin')
    }
    expect(r.openedToMembers.length).toBeGreaterThan(0)
    for (const label of r.openedToMembers) {
      const domain = Object.entries(DOMAIN_META).find(([, m]) => m.label === label)![0]
      expect(tables.fund_domain_defaults.find(x => x.domain === domain)).toMatchObject({ level: 'none', updated_by: ACTOR })
    }
    expect(r.finished).toBe(true)
    expect(tables.fund_settings[0].onboarding.completed_at).toBeTruthy()
  })

  it('is safe to re-run: the entity and member are found, not duplicated', async () => {
    const { admin, tables, invites } = setup()
    const p = plan({ entities: [{ name: 'Fund I', kind: 'fund' }], team: [{ email: 'ir@firm.com', preset: 'investor_relations' }] })
    await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, p)
    const again = await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, p)
    expect(again.entities[0].status).toBe('exists')
    expect(again.team).toEqual([{ email: 'ir@firm.com', status: 'updated' }])
    expect(invites).toEqual(['ir@firm.com'])
    expect(tables.fund_vehicles).toHaveLength(1)
    expect(tables.fund_members.filter(m => m.user_id === 'u-ir@firm.com')).toHaveLength(1)
  })

  it('refuses someone who belongs to another fund, and turns management company books on to create one', async () => {
    const { admin, tables } = setup({
      users: [{ id: 'u-other', email: 'other@elsewhere.com' }],
      seed: { fund_members: [{ fund_id: FUND, user_id: ACTOR, role: 'admin' }, { fund_id: 'fund-2', user_id: 'u-other', role: 'member' }] },
    })
    const r = await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, plan({
      team: [{ email: 'other@elsewhere.com' }], entities: [{ name: 'Hemrock Management', kind: 'manco' }],
    }))
    expect(r.team).toEqual([{ email: 'other@elsewhere.com', status: 'error', error: 'They already belong to another fund.' }])
    expect(tables.fund_members.find(m => m.user_id === 'u-other')!.fund_id).toBe('fund-2')
    expect(r.entities[0]).toMatchObject({ name: 'Hemrock Management', status: 'created' })
    expect(r.warnings.some(w => /management company books/.test(w))).toBe(true)
    expect(tables.fund_settings[0].feature_visibility.management_company).toBe('admin')
  })

  it('only adds products to a fund that already finished setup', async () => {
    const before = buildFeatureVisibility(['portfolio_reporting', 'fund_operations'])
    const { admin, tables } = setup({ settings: { feature_visibility: before, onboarding: { completed_at: '2026-01-01T00:00:00Z' } } })
    const r = await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, plan({ products: ['portfolio_reporting'] }))
    expect(r.products?.mode).toBe('added')
    expect(r.warnings.some(w => /left on/.test(w))).toBe(true)
    expect(tables.fund_settings[0].feature_visibility).toEqual(addProducts(before, ['portfolio_reporting']))
  })

  it('will not let the admin demote themselves', async () => {
    const { admin, tables } = setup()
    const r = await applySetupPlan(admin, { fundId: FUND, actorId: ACTOR }, plan({ team: [{ email: 'gp@firm.com', role: 'member' }] }))
    expect(r.team[0]).toMatchObject({ status: 'error', error: 'You cannot change your own role.' })
    expect(tables.fund_members.find(m => m.user_id === ACTOR)!.role).toBe('admin')
  })
})

// --- tools, prompt, docs ------------------------------------------------------------------------

describe('the setup tools', () => {
  it('are admin-only, and setup_fund is a write (staged for approval over OAuth)', () => {
    expect(getTool('setup_status')).toMatchObject({ scope: 'read', accessDomain: 'admin' })
    expect(getTool('setup_fund')).toMatchObject({ scope: 'write', accessDomain: 'admin' })
  })

  it('point every setup step at a tool that exists', () => {
    const names = new Set(AGENT_TOOLS.map(t => t.name))
    for (const tool of Object.values(STEP_TOOLS)) expect(names.has(tool!)).toBe(true)
  })

  it('ship the setup prompt to admins only, and the guide quotes it verbatim', async () => {
    const prompt = PROMPT_TEMPLATES.find(p => p.name === 'set_up_fund')!
    expect(prompt.domain).toBe('admin')
    expect(SETUP_PROMPT).toMatch(/setup_status/)
    expect(SETUP_PROMPT).toMatch(/setup_fund/)
    const { readFileSync } = await import('fs')
    expect(readFileSync('DOCS.md', 'utf8')).toContain(SETUP_PROMPT)
  })
})

describe('creating a fund from an agent', () => {
  it('turns agent access on only when asked', () => {
    const kek = 'a'.repeat(64)
    expect(newSettingsRow('f', kek, null).row.agent_api_enabled).toBeUndefined()
    expect(newSettingsRow('f', kek, null, { agentApiEnabled: true }).row.agent_api_enabled).toBe(true)
  })

  it('is refused to someone in a fund already, and to an LP account', async () => {
    const { admin } = memoryAdmin({
      fund_members: [{ fund_id: 'f', user_id: 'member' }],
      lp_accounts: [{ id: 'lp1', auth_user_id: 'lp' }],
    })
    expect(await fundCreationRefusal(admin, 'member')).toMatch(/already belong/)
    expect(await fundCreationRefusal(admin, 'lp')).toMatch(/investor portal/)
    expect(await fundCreationRefusal(admin, 'new')).toBeNull()
  })
})
