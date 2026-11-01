import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Inviting an LP used to report "Invited" whether or not an email went out: Supabase's refusal
 * to invite an address it already knows was logged to the console and swallowed. The route now
 * sends from the fund's own email when a provider is configured (Supabase's project-wide invite
 * template is the fallback), says what happened, and records every attempt.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const inviteUserByEmail = vi.hoisted(() => vi.fn())
const createUser = vi.hoisted(() => vi.fn())
const getOutboundConfig = vi.hoisted(() => vi.fn())
const sendOutboundEmail = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from, auth: { admin: { inviteUserByEmail, createUser } } }) }))
vi.mock('@/lib/email', () => ({ getOutboundConfig, sendOutboundEmail }))

import { POST, PATCH } from '@/app/api/lps/invites/route'

let deliveries: Record<string, unknown>[] = []
let accountUpdates: Record<string, unknown>[] = []
let linkUpdates: Record<string, unknown>[] = []
let links: Record<string, unknown>[] = []
let entitiesCreated: Record<string, unknown>[] = []
let existingAccount: { id: string; auth_user_id: string | null; status: string } | null = null
/** lp_account_links rows that exist for the PATCH lookup, keyed by lp_account_id. */
let linkedAccounts: Record<string, { id: string; status: string; auth_user_id: string | null }> = {}

function stub() {
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters[col] = val; return chain },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table === 'fund_members') return { data: { fund_id: 'fund-1', role: 'admin' }, error: null }
        if (table === 'lp_investors') return { data: filters.id === 'inv-1' && filters.fund_id === 'fund-1' ? { id: 'inv-1', name: 'Acme Capital' } : null, error: null }
        if (table === 'funds') return { data: { name: 'Test Fund' }, error: null }
        if (table === 'lp_accounts') return { data: existingAccount, error: null }
        if (table === 'lp_account_links') {
          if (filters.fund_id !== 'fund-1') return { data: null, error: null }
          const acct = linkedAccounts[filters.lp_account_id as string]
          return { data: acct ? { id: 'link-1', lp_accounts: acct } : null, error: null }
        }
        return { data: null, error: null }
      },
      single: async () => ({ data: { id: 'acct-new', auth_user_id: null, status: 'invited' }, error: null }),
      // Awaiting the chain itself: the entity lookup, which finds none until one is created.
      then: (resolve: (v: unknown) => void) => resolve({ data: table === 'lp_entities' ? entitiesCreated.filter(e => e.investor_id === filters.investor_id).map(e => ({ id: 'ent-new' })) : [], error: null }),
      insert: (row: Record<string, unknown>) => {
        if (table === 'lp_deliveries') { deliveries.push(row); return Promise.resolve({ error: null }) }
        if (table === 'lp_account_links') { links.push(row); return Promise.resolve({ error: null }) }
        if (table === 'lp_accounts') return { select: () => ({ single: chain.single }) }
        if (table === 'lp_entities') { entitiesCreated.push(row); return { select: () => ({ single: async () => ({ data: { id: 'ent-new' }, error: null }) }) } }
        return Promise.resolve({ error: null })
      },
      update: (patch: Record<string, unknown>) => table === 'lp_account_links'
        ? { eq: (_c: string, fund: string) => ({ eq: async (_c2: string, acct: string) => { linkUpdates.push({ fund, acct, ...patch }); return { error: null } } }) }
        : { eq: async (_c: string, id: string) => { accountUpdates.push({ id, ...patch }); return { error: null } } },
    }
    return chain
  })
}

const req = (body: Record<string, unknown>) => ({ json: async () => body, url: 'http://x/api/lps/invites' }) as any

beforeEach(() => {
  vi.clearAllMocks()
  deliveries = []; accountUpdates = []; linkUpdates = []; links = []; entitiesCreated = []
  existingAccount = null
  linkedAccounts = {}
  getUser.mockResolvedValue({ data: { user: { id: 'admin-1', email: 'gp@example.com' } } })
  stub()
})

describe('POST /api/lps/invites', () => {
  it('sends from the fund\'s own email when a provider is configured, creating the auth user silently', async () => {
    getOutboundConfig.mockResolvedValue({ provider: 'resend', apiKey: 'k' })
    createUser.mockResolvedValue({ data: { user: { id: 'auth-9' } }, error: null })
    sendOutboundEmail.mockResolvedValue({ id: 'msg-1' })
    const res = await POST(req({ lp_investor_id: 'inv-1', email: 'LP@Example.com' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, emailed: true, method: 'outbound' })
    expect(inviteUserByEmail).not.toHaveBeenCalled()
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'lp@example.com', email_confirm: false }))
    expect(links).toEqual([expect.objectContaining({ lp_account_id: 'acct-new', fund_id: 'fund-1', lp_investor_id: 'inv-1' })])
    expect(accountUpdates).toEqual([expect.objectContaining({ id: 'acct-new', auth_user_id: 'auth-9' })])
    // The investor gets an entity named after it, so the checklist can see them.
    expect(entitiesCreated).toEqual([expect.objectContaining({ fund_id: 'fund-1', investor_id: 'inv-1', entity_name: 'Acme Capital', partner_class: 'lp', onboarding_excluded: false })])
    const html = sendOutboundEmail.mock.calls[0][1].html as string
    expect(html).toContain('/portal/welcome?email=lp%40example.com')
    expect(deliveries).toEqual([expect.objectContaining({ kind: 'invite', to_email: 'lp@example.com', status: 'sent', provider: 'resend', provider_message_id: 'msg-1' })])
  })

  it('still sends when the auth user already exists (a re-invite, or an advisor elsewhere)', async () => {
    getOutboundConfig.mockResolvedValue({ provider: 'resend', apiKey: 'k' })
    createUser.mockResolvedValue({ data: null, error: { message: 'A user with this email address has already been registered' } })
    sendOutboundEmail.mockResolvedValue({ id: 'msg-2' })
    const res = await POST(req({ lp_investor_id: 'inv-1', email: 'lp@example.com' }))
    expect(await res.json()).toMatchObject({ ok: true, emailed: true, method: 'outbound' })
    expect(sendOutboundEmail).toHaveBeenCalled()
    expect(accountUpdates).toHaveLength(0)
  })

  it('falls back to Supabase\'s invite when no provider is configured, and binds the auth user', async () => {
    getOutboundConfig.mockResolvedValue(null)
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth-9' } }, error: null })
    const res = await POST(req({ lp_investor_id: 'inv-1', email: 'lp@example.com' }))
    expect(await res.json()).toMatchObject({ ok: true, emailed: true, method: 'supabase' })
    expect(createUser).not.toHaveBeenCalled()
    expect(accountUpdates).toEqual([expect.objectContaining({ id: 'acct-new', auth_user_id: 'auth-9' })])
    expect(deliveries).toEqual([expect.objectContaining({ kind: 'invite', status: 'sent', provider: 'supabase' })])
  })

  it('does not claim success when nothing could be emailed', async () => {
    getOutboundConfig.mockResolvedValue(null)
    inviteUserByEmail.mockResolvedValue({ data: null, error: { message: 'email rate limit exceeded' } })
    const res = await POST(req({ lp_investor_id: 'inv-1', email: 'lp@example.com' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.emailed).toBe(false)
    expect(body.warning).toContain('email rate limit exceeded')
    // The link still exists, so the admin can resend from the accounts list.
    expect(links).toHaveLength(1)
    expect(deliveries).toEqual([expect.objectContaining({ kind: 'invite', status: 'failed' })])
  })

  it('links an already-active account without emailing it', async () => {
    existingAccount = { id: 'acct-old', auth_user_id: 'auth-1', status: 'active' }
    const res = await POST(req({ lp_investor_id: 'inv-1', email: 'lp@example.com' }))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, emailed: false, already_active: true })
    expect(inviteUserByEmail).not.toHaveBeenCalled()
    expect(sendOutboundEmail).not.toHaveBeenCalled()
    expect(links).toHaveLength(1)
  })

  it('refuses an investor outside the admin\'s fund', async () => {
    const res = await POST(req({ lp_investor_id: 'inv-other', email: 'lp@example.com' }))
    expect(res.status).toBe(404)
    expect(links).toHaveLength(0)
    expect(inviteUserByEmail).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/lps/invites', () => {
  it('disables an account in this fund only: its other funds are untouched', async () => {
    linkedAccounts = { 'acct-1': { id: 'acct-1', status: 'active', auth_user_id: 'auth-1' } }
    const res = await PATCH(req({ lp_account_id: 'acct-1', status: 'disabled' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'disabled' })
    expect(linkUpdates).toEqual([expect.objectContaining({ fund: 'fund-1', acct: 'acct-1', disabled_at: expect.any(String) })])
    expect(accountUpdates).toHaveLength(0)
  })

  it('re-enabling here clears this fund\'s switch, and keeps the account as it is elsewhere', async () => {
    linkedAccounts = { 'acct-1': { id: 'acct-1', status: 'active', auth_user_id: 'auth-1' } }
    const res = await PATCH(req({ lp_account_id: 'acct-1', status: 'active' }))
    expect(await res.json()).toMatchObject({ ok: true, status: 'active' })
    expect(linkUpdates).toEqual([expect.objectContaining({ disabled_at: null })])
    expect(accountUpdates).toHaveLength(0)
  })

  it('re-enabling an account disabled everywhere (before the switch was per fund) puts it back to invited if it never activated', async () => {
    linkedAccounts = { 'acct-1': { id: 'acct-1', status: 'disabled', auth_user_id: null } }
    const res = await PATCH(req({ lp_account_id: 'acct-1', status: 'active' }))
    expect(await res.json()).toMatchObject({ ok: true, status: 'invited' })
    expect(accountUpdates).toEqual([expect.objectContaining({ id: 'acct-1', status: 'invited' })])
  })

  it('cannot touch an account that is not linked to this fund', async () => {
    const res = await PATCH(req({ lp_account_id: 'acct-elsewhere', status: 'disabled' }))
    expect(res.status).toBe(404)
    expect(accountUpdates).toHaveLength(0)
  })
})
