// The LP portal and outreach tools (lib/agent/lp-portal-tools.ts) and the functions they share with
// the LP Portal page's routes (lib/lps/portal-access.ts, lib/lps/outreach.ts): who gets invited,
// that a preview sends and writes nothing, that every one of them is an admin's, and that a chat
// sees the preview before anything goes out.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendLpInvite: vi.fn(),
  sendOutboundEmail: vi.fn(),
  getOutboundConfig: vi.fn(),
  resolveLpRecipients: vi.fn(),
}))
vi.mock('@/lib/lp-invites', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/lp-invites')>()),
  sendLpInvite: mocks.sendLpInvite,
}))
vi.mock('@/lib/email', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  getOutboundConfig: mocks.getOutboundConfig,
  sendOutboundEmail: mocks.sendOutboundEmail,
}))
vi.mock('@/lib/lp-recipients', () => ({ resolveLpRecipients: mocks.resolveLpRecipients }))
vi.mock('@/lib/access/lp-scope', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/lp-scope')>()),
  loadLpScope: async () => ({ scope: null, entityIds: null, investorIds: null }),
}))
vi.mock('@/lib/cache/tags', () => ({ expireTag: vi.fn() }))

import { memoryAdmin, type Row } from './helpers/memory-admin'
import {
  bulkInvite, inviteMissing, planMissingInvites, portalSwitchUpdates, setPortalSwitches,
} from '@/lib/lps/portal-access'
import { announceToLps, sendPortalItem, NO_PDF_RENDERER_MESSAGE } from '@/lib/lps/outreach'
import { AGENT_TOOLS, getTool } from '@/lib/accounting/agent-tools'
import { ADMIN_ONLY_TOOLS } from '@/lib/access/admin-only'
import { adminOnlyRefusal, isDraftOnlyCall, shouldStage } from '@/lib/agent/dispatch'

const FUND = 'f1'
const actor = { fundId: FUND, userId: 'u1' }
const linkUnique = { table: 'lp_account_links', key: (r: Row) => `${r.lp_account_id}:${r.lp_investor_id}` }

function seed(): Record<string, Row[]> {
  return {
    funds: [{ id: FUND, name: 'Hemrock Fund I' }],
    fund_settings: [{ fund_id: FUND, lp_portal_enabled: true, lp_agent_enabled: false }],
    lp_investors: [
      { id: 'iA', fund_id: FUND, name: 'Alpha Family', contact_email: 'Ann@Alpha.example ' },
      { id: 'iB', fund_id: FUND, name: 'Beta LLC', contact_email: 'b@beta.example' },
      { id: 'iC', fund_id: FUND, name: 'Gamma Trust', contact_email: null },
      { id: 'iD', fund_id: FUND, name: 'Delta', contact_email: 'not an email' },
      { id: 'iE', fund_id: FUND, name: 'Epsilon', contact_email: null },
    ],
    lp_entities: [
      { id: 'eA', fund_id: FUND, investor_id: 'iA', entity_name: 'Alpha Family', notice_email: null },
      { id: 'eC', fund_id: FUND, investor_id: 'iC', entity_name: 'Gamma Trust', notice_email: 'notices@gamma.example' },
      { id: 'eE1', fund_id: FUND, investor_id: 'iE', entity_name: 'Epsilon I', notice_email: 'one@eps.example' },
      { id: 'eE2', fund_id: FUND, investor_id: 'iE', entity_name: 'Epsilon II', notice_email: 'two@eps.example' },
    ],
    lp_accounts: [{ id: 'acctB', email: 'b@beta.example', status: 'active', kind: 'lp', auth_user_id: 'auB' }],
    lp_account_links: [{ id: 'linkB', fund_id: FUND, lp_account_id: 'acctB', lp_investor_id: 'iB' }],
  }
}

const access = (role: 'admin' | 'member') => ({
  fundId: FUND, userId: 'u1', role, grants: {}, defaults: {}, vehicles: { all: true, ids: [] }, features: {},
}) as any
const toolCtx = (admin: any, role: 'admin' | 'member' = 'admin') => ({ admin, fundId: FUND, portfolioGroup: '', userId: 'u1', access: access(role) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendLpInvite.mockResolvedValue({ method: 'outbound', authUserId: null, error: null })
})

describe('inviting everyone who is missing', () => {
  it('finds every investor with an address and no portal account, and says why the rest are left out', async () => {
    const { admin } = memoryAdmin(seed())
    const plan = await planMissingInvites(admin, FUND, null)
    expect(plan.candidates).toEqual([
      { lp_investor_id: 'iA', investor: 'Alpha Family', email: 'ann@alpha.example', source: 'contact_email' },
      { lp_investor_id: 'iC', investor: 'Gamma Trust', email: 'notices@gamma.example', source: 'notice_email' },
    ])
    expect(plan.already_linked).toBe(1)
    expect(plan.no_email.map(n => n.investor)).toEqual(['Delta', 'Epsilon'])
    // Two different notice emails is not a guess the tool makes.
    expect(plan.no_email.find(n => n.investor === 'Epsilon')!.reason).toMatch(/2 different notice emails/)
  })

  it('keeps to the investors it is given (those in the named vehicles)', async () => {
    const { admin } = memoryAdmin(seed())
    const plan = await planMissingInvites(admin, FUND, new Set(['iC', 'iB']))
    expect(plan.candidates.map(c => c.investor)).toEqual(['Gamma Trust'])
    expect(plan.already_linked).toBe(1)
    expect(plan.no_email).toEqual([])
  })

  it('commits by investor id: an account, a link and an invite each', async () => {
    const { admin, tables } = memoryAdmin(seed(), { unique: [linkUnique] })
    const plan = await planMissingInvites(admin, FUND, null)
    mocks.sendLpInvite.mockImplementation(async (_a: any, t: any) =>
      t.email === 'notices@gamma.example' ? { method: null, authUserId: null, error: 'bounced' } : { method: 'outbound', authUserId: null, error: null })
    const summary = await inviteMissing(admin, actor, plan)
    expect(tables.lp_account_links.map(l => l.lp_investor_id).sort()).toEqual(['iA', 'iB', 'iC'])
    expect(tables.lp_accounts.map(a => a.email).sort()).toEqual(['ann@alpha.example', 'b@beta.example', 'notices@gamma.example'])
    expect(mocks.sendLpInvite).toHaveBeenCalledTimes(2)
    expect(summary.failed).toEqual(['notices@gamma.example'])
    expect(summary.errors[0].message).toMatch(/bounced/)
    // The invite names the fund and the person who asked.
    expect(mocks.sendLpInvite.mock.calls[0][1]).toMatchObject({ fundId: FUND, fundName: 'Hemrock Fund I', sentBy: 'u1' })
  })
})

describe('a bulk sheet', () => {
  const rows = [
    { name: 'alpha family', email: 'ann@alpha.example' },
    { name: 'New Partner LP', email: 'np@new.example', authorized_emails: ['adv@cpa.example'] },
    { name: '', email: 'x@y.example' },
    { name: 'Bad', email: 'nope' },
  ]

  it('previews without writing or emailing', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const out = await bulkInvite(admin, actor, rows, false)
    expect(out).toEqual({ ok: true, value: expect.objectContaining({
      rows: 4, matched: 1, toCreate: ['New Partner LP'], lpInvites: 2, authorizedInvites: 1, committed: false,
    }) })
    expect(out.ok && out.value.errors.map(e => e.row)).toEqual([3, 4])
    expect(tables.lp_investors).toHaveLength(5)
    expect(tables.lp_account_links).toHaveLength(1)
    expect(mocks.sendLpInvite).not.toHaveBeenCalled()
  })

  it('commits: creates the new investor, links both, delegates the advisor and emails all three', async () => {
    const { admin, tables } = memoryAdmin(seed(), { unique: [linkUnique] })
    const out = await bulkInvite(admin, actor, rows, true)
    expect(out.ok).toBe(true)
    expect(tables.lp_investors.map(i => i.name)).toContain('New Partner LP')
    expect(tables.lp_authorized_users).toHaveLength(1)
    expect(mocks.sendLpInvite).toHaveBeenCalledTimes(3)
  })

  it('refuses an empty or oversized sheet with the route\'s words', async () => {
    const { admin } = memoryAdmin(seed())
    expect(await bulkInvite(admin, actor, [], false)).toMatchObject({ ok: false, status: 400, error: 'No rows provided' })
    expect(await bulkInvite(admin, actor, Array(2001).fill({}), false)).toMatchObject({ ok: false, status: 400, error: 'Too many rows (max 2000)' })
  })
})

describe('the portal switches', () => {
  it('builds only the columns given', () => {
    expect(portalSwitchUpdates({})).toEqual({})
    expect(portalSwitchUpdates({ lpPortalEnabled: 1 })).toEqual({ lp_portal_enabled: true })
    expect(portalSwitchUpdates({ lpPortalEnabled: false, lpAgentEnabled: true })).toEqual({ lp_portal_enabled: false, lp_agent_enabled: true })
  })

  it('applies them and reports both as they stand', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const out = await setPortalSwitches(admin, actor, { lpAgentEnabled: true })
    expect(out).toEqual({ lpPortalEnabled: true, lpAgentEnabled: true, changed: ['lp_agent_enabled'] })
    expect(tables.fund_settings[0].lp_agent_enabled).toBe(true)
  })
})

describe('email to LPs', () => {
  const group = { primaryAccountId: 'acctB', primaryEmail: 'b@beta.example', primaryName: 'Bea', investorIds: ['iB'], ccEmails: ['adv@cpa.example'] }

  it('an announcement preview returns the addresses and the email, and sends nothing', async () => {
    const { admin, tables } = memoryAdmin(seed())
    mocks.resolveLpRecipients.mockResolvedValue([group])
    const out = await announceToLps(admin, { ...actor, role: 'admin' }, { subject: 'Closing', body: 'We closed.', preview: true })
    expect(out).toMatchObject({ ok: true, value: {
      preview: true, subject: 'Hemrock Fund I: Closing',
      recipients: [{ to: 'b@beta.example', name: 'Bea', cc: ['adv@cpa.example'], investorCount: 1 }],
      unreachable: 4,
    } })
    expect(out.ok && 'html' in out.value && out.value.html).toContain('We closed.')
    expect(mocks.sendOutboundEmail).not.toHaveBeenCalled()
    expect(tables.lp_messages ?? []).toHaveLength(0)
  })

  it('a send records the message in the portal and the email per investor', async () => {
    const { admin, tables } = memoryAdmin(seed())
    mocks.resolveLpRecipients.mockResolvedValue([group])
    mocks.getOutboundConfig.mockResolvedValue({ provider: 'resend' })
    mocks.sendOutboundEmail.mockResolvedValue({ id: 'm1' })
    const out = await announceToLps(admin, { ...actor, role: 'admin' }, { subject: 'Closing', body: 'We closed.', lp_investor_ids: ['iB'] })
    expect(out).toMatchObject({ ok: true, value: { ok: true, sent: 1, primaryRecipients: 1, ccRecipients: 1, failures: [] } })
    expect(tables.lp_messages).toHaveLength(1)
    expect(tables.lp_deliveries).toHaveLength(1)
  })

  it('sending a statement or letter as a rendered attachment needs a renderer (the tool passes remote ones: agent-remote-pdf.test.ts)', async () => {
    const { admin } = memoryAdmin(seed())
    for (const kind of ['snapshot', 'letter']) {
      expect(await sendPortalItem(admin, actor, { kind, id: 'x', lp_investor_ids: ['iB'], delivery: 'attachment' }, null))
        .toMatchObject({ ok: false, status: 400, error: NO_PDF_RENDERER_MESSAGE })
    }
  })
})

describe('the tools', () => {
  const PORTAL_WRITES = [
    'lp_portal_invite', 'lp_portal_invite_bulk', 'lp_portal_account_status', 'lp_portal_resend_invite', 'lp_portal_unlink',
    'lp_authorized_user_add', 'lp_authorized_user_remove', 'lp_announce', 'lp_send_item', 'lp_portal_settings',
  ]

  it('every portal write and every proposed-call write is admin-only; viewing proposals is not', () => {
    const CALL_WRITES = ['lp_proposed_call_propose', 'lp_proposed_call_revise', 'lp_proposed_call_discard', 'lp_proposed_call_approve']
    for (const name of [...PORTAL_WRITES, ...CALL_WRITES]) {
      expect(getTool(name)?.scope, name).toBe('write')
      expect(ADMIN_ONLY_TOOLS[name], name).toBeDefined()
    }
    expect(getTool('lp_proposed_calls')?.scope).toBe('read')
    expect(ADMIN_ONLY_TOOLS.lp_proposed_calls).toBeUndefined()
  })

  it('are gated like the LP Portal page: LP relations under the portal switch, the switches as admin settings', () => {
    for (const t of AGENT_TOOLS.filter(t => /^lp_(portal|authorized|announce|send)/.test(t.name))) {
      if (t.name === 'lp_portal_settings') expect(t.accessDomain).toBe('admin')
      else expect(t, t.name).toMatchObject({ domain: 'lp', accessDomain: 'lp_relations', accessFeature: 'lp_portal' })
    }
    for (const t of AGENT_TOOLS.filter(t => t.name.startsWith('lp_proposed_call'))) {
      expect(t, t.name).toMatchObject({ domain: 'lp', accessDomain: 'lp_capital' })
      expect(t.accessFeature, t.name).toBeUndefined()
    }
  })

  it('previews and dry runs run directly; the send and the commit stage from a chat', () => {
    const chat = { keyId: 'oauth:c1' }
    for (const [name, preview, real] of [
      ['lp_announce', { preview: true }, {}],
      ['lp_send_item', { preview: true }, { preview: false }],
      ['lp_portal_invite', { preview: true }, {}],
      ['lp_portal_resend_invite', { preview: true }, {}],
      ['lp_authorized_user_add', { preview: true }, {}],
      ['lp_portal_invite_bulk', {}, { commit: true }],
    ] as const) {
      const tool = getTool(name)!
      expect(isDraftOnlyCall(tool, preview), name).toBe(true)
      expect(shouldStage(tool, preview, chat), name).toBe(false)
      expect(shouldStage(tool, real, chat), name).toBe(true)
    }
  })

  it('a member\'s key is refused, preview or not; a member\'s chat may propose', () => {
    const memberKey = { keyId: 'lk_1', role: 'member' } as any
    expect(adminOnlyRefusal(getTool('lp_announce')!, { preview: true }, memberKey)).toBe('Only an admin can announce to LPs.')
    expect(adminOnlyRefusal(getTool('lp_portal_invite_bulk')!, {}, memberKey)).toBe('Only an admin can invite LPs to the portal.')
    expect(adminOnlyRefusal(getTool('lp_announce')!, {}, { keyId: 'oauth:c1', role: 'member' } as any)).toBeNull()
    expect(adminOnlyRefusal(getTool('lp_announce')!, {}, { keyId: 'lk_1', role: 'admin' } as any)).toBeNull()
  })

  it('a member cannot read the accounts or run a preview from a chat either', async () => {
    const { admin } = memoryAdmin(seed())
    await expect(getTool('lp_portal_accounts')!.handler(toolCtx(admin, 'member'), {})).rejects.toThrow('Only an admin can see LP portal accounts.')
    await expect(getTool('lp_portal_invite_bulk')!.handler(toolCtx(admin, 'member'), {})).rejects.toThrow(/Only an admin/)
  })

  it('lp_portal_invite_bulk previews who would be invited and the email, then commits on a second call', async () => {
    const { admin, tables } = memoryAdmin(seed(), { unique: [linkUnique] })
    const tool = getTool('lp_portal_invite_bulk')!
    const preview = await tool.handler(toolCtx(admin), {})
    expect(preview).toMatchObject({
      preview: true, scope: 'every LP in the fund',
      would_invite: [
        { investor: 'Alpha Family', email: 'ann@alpha.example', from: 'contact_email' },
        { investor: 'Gamma Trust', email: 'notices@gamma.example', from: 'notice_email' },
      ],
      already_have_portal_account: 1,
      invite_email: { subject: 'Hemrock Fund I: set up your investor portal access', sample_to: 'ann@alpha.example' },
    })
    expect(preview.not_invited_no_email.map((n: any) => n.investor)).toEqual(['Delta', 'Epsilon'])
    expect(preview.next).toMatch(/explicitly say yes/)
    expect(tables.lp_account_links).toHaveLength(1)
    expect(mocks.sendLpInvite).not.toHaveBeenCalled()

    const done = await tool.handler(toolCtx(admin), { commit: true })
    expect(done.invited).toEqual([
      { investor: 'Alpha Family', email: 'ann@alpha.example' },
      { investor: 'Gamma Trust', email: 'notices@gamma.example' },
    ])
    expect(tables.lp_account_links).toHaveLength(3)
    expect(mocks.sendLpInvite).toHaveBeenCalledTimes(2)
  })

  it('lp_portal_invite previews the email by investor name and changes nothing', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const out = await getTool('lp_portal_invite')!.handler(toolCtx(admin), { investor: 'gamma trust', email: 'G@Gamma.example', preview: true })
    expect(out).toMatchObject({ preview: true, investor: 'Gamma Trust', to: 'g@gamma.example', existing_account: null, would_email: true })
    expect(out.html).toContain('/portal/welcome?email=g%40gamma.example')
    expect(tables.lp_accounts).toHaveLength(1)
  })

  it('lp_portal_settings changes only the switches given', async () => {
    const { admin, tables } = memoryAdmin(seed())
    const tool = getTool('lp_portal_settings')!
    await expect(tool.handler(toolCtx(admin), {})).rejects.toThrow(/portal_enabled/)
    const out = await tool.handler(toolCtx(admin), { portal_enabled: false })
    expect(out).toMatchObject({ portal_enabled: false, investor_connector_enabled: false, changed: ['lp_portal_enabled'] })
    expect(tables.fund_settings[0].lp_portal_enabled).toBe(false)
  })
})
