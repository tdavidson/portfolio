import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The unified Analyst's access boundary.
 *
 * One Analyst serves every section, so what a user may ask about is decided by WHAT THE REQUEST
 * IS GIVEN, not by prompt text: a user who isn't entitled to a domain must never have that
 * domain's data appended to their system prompt, nor its capabilities (accounting's entry
 * drafting) — leaving their Analyst with nothing to answer from and no way to act. The scope
 * arrives in the request body (`vehicle`, `domain`), so it is fully caller-controlled and is
 * never evidence of entitlement; that is checked against the caller's role and the fund's
 * feature settings.
 *
 * These tests pin that per domain, and pin that each domain's data stays out of the others'.
 */

const createChat = vi.hoisted(() => vi.fn())
const buildAccountingContext = vi.hoisted(() => vi.fn(async () => 'PRIMARY VEHICLE BOOKS: cash 100'))
const buildLpContext = vi.hoisted(() => vi.fn(async () => 'LP ROLL-UP: Cranmore commit 5000000'))
const buildDiligenceContext = vi.hoisted(() => vi.fn(async () => 'PIPELINE: 3 deals — 2 active, 1 passed'))
const extractText = vi.hoisted(() => vi.fn(async () => 'CAPITAL CALL NOTICE — $3,750,000 due 2026-07-01'))

let user: { id: string } | null = { id: 'u1' }
let tables: Record<string, unknown> = {}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeAdmin }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: vi.fn() }))
vi.mock('@/lib/ai/topical-guard', () => ({ withTopicalGuardrail: (s: string) => s }))
vi.mock('@/lib/ai/context-builder', () => ({
  buildPortfolioContext: async () => ({ systemPrompt: 'You are the Analyst.', portfolioBlock: '', teamNotesBlock: '' }),
  buildCompanyContext: async () => null,
  buildDealContext: async () => null,
}))
vi.mock('@/lib/accounting/agent-tools', () => ({ resolveVehicle: async (_a: unknown, _f: string, g: string) => g }))
vi.mock('@/lib/accounting/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounting/assistant')>()),
  buildAccountingContext,
}))
vi.mock('@/lib/ai/lp-fund-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/lp-fund-context')>()),
  buildLpContext,
}))
vi.mock('@/lib/diligence/analyst-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diligence/analyst-context')>()),
  buildDiligenceContext,
}))
vi.mock('@/lib/memo-agent/extract-text', () => ({ extractText }))
vi.mock('@/lib/ai', () => ({
  createFundAIProviderWithOverride: async () => ({
    provider: { createChat },
    model: 'test-model',
    providerType: 'anthropic',
  }),
}))

/** Chainable Supabase stub: every builder method returns itself; awaiting it (or calling
 *  maybeSingle/single) resolves to that table's canned rows. */
function query(table: string): any {
  const result = { data: tables[table] ?? null, error: null }
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === 'then') return (res: any) => Promise.resolve(result).then(res)
      if (prop === 'maybeSingle' || prop === 'single') return async () => result
      return () => proxy
    },
  }
  const proxy: any = new Proxy({}, handler)
  return proxy
}
/**
 * The `access_context` RPC — the single call the resolver makes (migration 20260716000009). Built
 * from the same `tables` fixture, so a test sets grants the way it sets any other row.
 */
const fakeRpc = async (_name: string, _args: any) => {
  const membership = tables.fund_members as { fund_id: string; role: string } | null
  if (!membership) return { data: null, error: null }
  const asRecord = (rows: any) =>
    Object.fromEntries(((rows as { domain: string; level: string }[]) ?? []).map(r => [r.domain, r.level]))
  return {
    data: {
      fund_id: membership.fund_id,
      role: membership.role,
      features: (tables.fund_settings as any)?.feature_visibility ?? {},
      grants: asRecord(tables.fund_member_access),
      defaults: asRecord(tables.fund_domain_defaults),
    },
    error: null,
  }
}

const fakeAdmin: any = { from: (table: string) => query(table), rpc: fakeRpc }

const REPLY_WITH_DRAFT = `Here's the entry for that purchase.

\`\`\`proposal
{"type":"create","entryId":null,"entryDate":"2026-07-01","memo":"Buy Apogee","sourceType":"manual","postings":[{"accountCode":"1500","amount":3750000,"lpEntity":null},{"accountCode":"1000","amount":-3750000,"lpEntity":null}],"rationale":"Investment funded from cash"}
\`\`\``

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/analyst/route')
  const req = { json: async () => body } as any
  const res = await POST(req)
  return { status: res.status, json: await res.json(), system: createChat.mock.calls[0]?.[0]?.system ?? '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'u1' }
  createChat.mockResolvedValue({ text: REPLY_WITH_DRAFT, usage: {} })
  tables = {
    fund_members: { fund_id: 'f1', role: 'admin' },
    companies: [],
    // Each of these defaults to 'off' or 'admin', so a fund has to switch them on deliberately.
    fund_settings: { feature_visibility: { accounting: 'admin', lps: 'admin', diligence: 'admin', gp_economics: 'admin' } },
    fund_member_access: [],
    fund_domain_defaults: [],
    analyst_conversations: { id: 'conv1' },
  }
})

/** A member of a fund that has the areas open, holding exactly these grants. */
function memberWith(grants: Record<string, string>) {
  tables.fund_members = { fund_id: 'f1', role: 'member' }
  tables.fund_settings = {
    feature_visibility: { accounting: 'everyone', lps: 'everyone', diligence: 'everyone', deals: 'everyone', gp_economics: 'everyone' },
  }
  tables.fund_member_access = Object.entries(grants).map(([domain, level]) => ({ domain, level }))
}

const msgs = [{ role: 'user' as const, content: 'Draft the entry to buy Apogee for $3.75M' }]

describe('unified Analyst — accounting is access-scoped', () => {
  it('gives an admin the vehicle books and the drafting capability', async () => {
    const { status, json, system } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(status).toBe(200)
    expect(system).toContain('=== ACCOUNTING: Fund IV ===')
    expect(system).toContain('PRIMARY VEHICLE BOOKS: cash 100')
    expect(system).toContain('DRAFTING ENTRIES')
    expect(buildAccountingContext).toHaveBeenCalledWith(expect.anything(), 'f1', 'Fund IV', {
      includeRelatedEntities: true,
      access: expect.anything(),
    })

    // The draft is lifted out of the prose and returned for the user to review + apply.
    expect(json.proposals).toHaveLength(1)
    expect(json.proposals[0].postings).toHaveLength(2)
    expect(json.vehicle).toBe('Fund IV')
    expect(json.reply).not.toContain('```proposal')
    expect(json.reply).toContain("Here's the entry")
  })

  it('gives a member with no accounting grant NOTHING, even though they asked for a vehicle', async () => {
    memberWith({})

    const { status, system, json } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(status).toBe(200)
    expect(system).not.toContain('ACCOUNTING')
    expect(system).not.toContain('PRIMARY VEHICLE BOOKS')
    expect(system).not.toContain('DRAFTING ENTRIES')
    expect(buildAccountingContext).not.toHaveBeenCalled()
    // No accounting scope was granted, so a fence-shaped string in the reply is just prose —
    // it must not become an appliable draft.
    expect(json.proposals).toEqual([])
    expect(json.vehicle).toBeNull()
  })

  it('gives a read-granted member the books but NOT the ability to draft', async () => {
    // Drafting is a write. Explaining the books is not.
    memberWith({ accounting: 'read', lp_capital: 'read', gp_economics: 'read' })

    const { system, json } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(system).toContain('PRIMARY VEHICLE BOOKS')
    expect(system).not.toContain('DRAFTING ENTRIES')
    // The model can still emit a fence from its own inclinations; without the grant it is prose.
    expect(json.proposals).toEqual([])
    expect(json.reply).toContain('```proposal')
  })

  it('gives a member with the books partner capital too — it IS the ledger', () => {
    // This used to withhold it. That was theatre: the chart has one NAMED capital account per
    // partner, so the balances and entries carry them regardless. `accounting` implies
    // `lp_capital` now, and the guide says so rather than pretending otherwise.
    memberWith({ accounting: 'write' })

    return post({ messages: msgs, vehicle: 'Fund IV' }).then(({ system }) => {
      expect(buildAccountingContext).toHaveBeenCalledWith(expect.anything(), 'f1', 'Fund IV', {
        includeRelatedEntities: false,
        access: expect.anything(),
      })
      expect(system).toContain('explain capital accounts and capital calls')
      // The GP/associate books are still a real carve-out — carry is not part of this ledger.
      expect(system).toContain("You do NOT have the GP/associate entities' books")
    })
  })

  it('gives the GP/associate books only to a member who also holds gp_economics', async () => {
    memberWith({ accounting: 'write', gp_economics: 'read' })

    const { system } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(buildAccountingContext).toHaveBeenCalledWith(expect.anything(), 'f1', 'Fund IV', {
      includeRelatedEntities: true,
      access: expect.anything(),
    })
    expect(system).toContain('answer reconciliation questions')
    expect(system).not.toContain('You do NOT have')
  })

  it('lets the read-only demo read the books, since the demo shows accounting off', async () => {
    // A deliberate change: the Analyst's accounting used to be admin-only, so the demo's Analyst
    // couldn't discuss the books its own pages display (assertReadAccess lets a viewer read them).
    // Under grants, viewer reads everything switched on — and still cannot draft.
    tables.fund_members = { fund_id: 'f1', role: 'viewer' }

    const { system, json } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(system).toContain('PRIMARY VEHICLE BOOKS')
    expect(system).not.toContain('DRAFTING ENTRIES')
    expect(json.proposals).toEqual([])
  })

  it('gives an admin nothing when the fund has accounting switched off', async () => {
    tables.fund_settings = { feature_visibility: { accounting: 'off' } }

    const { system, json } = await post({ messages: msgs, vehicle: 'Fund IV' })

    expect(system).not.toContain('PRIMARY VEHICLE BOOKS')
    expect(buildAccountingContext).not.toHaveBeenCalled()
    expect(json.proposals).toEqual([])
  })

  it('leaves the portfolio Analyst untouched when no vehicle is in scope', async () => {
    const { status, system, json } = await post({ messages: msgs })

    expect(status).toBe(200)
    expect(system).toContain('You are the Analyst.')
    expect(system).not.toContain('PRIMARY VEHICLE BOOKS')
    expect(buildAccountingContext).not.toHaveBeenCalled()
    expect(json.proposals).toEqual([])
    expect(json.scope).toBeNull()
  })

  it('reads an attached source document into the prompt for an admin', async () => {
    const { status, system } = await post({
      messages: [{ role: 'user', content: 'Record this' }],
      vehicle: 'Fund IV',
      document: { name: 'call-notice.pdf', format: 'pdf', base64: Buffer.from('x').toString('base64') },
    })

    expect(status).toBe(200)
    expect(system).toContain('=== SOURCE DOCUMENT: call-notice.pdf ===')
    expect(system).toContain('CAPITAL CALL NOTICE — $3,750,000')
  })

  it('gives an ungranted member their document as plain source material, never as books to record against', async () => {
    memberWith({})

    const { status, system } = await post({
      messages: [{ role: 'user', content: 'Record this' }],
      vehicle: 'Fund IV',
      document: { name: 'call-notice.pdf', format: 'pdf', base64: Buffer.from('x').toString('base64') },
    })

    expect(status).toBe(200)
    expect(system).toContain('=== SOURCE DOCUMENT: call-notice.pdf ===')
    expect(system).not.toContain('=== ACCOUNTING:')
    expect(system).not.toContain('default to proposing ONE balanced entry')
    expect(system).not.toContain('DRAFTING ENTRIES')
  })

  it('rejects an attachment it cannot read rather than answering as if it had it', async () => {
    const { status, json } = await post({
      messages: msgs,
      vehicle: 'Fund IV',
      document: { name: 'photo.png', format: 'png', base64: Buffer.from('x').toString('base64') },
    })

    expect(status).toBe(400)
    expect(json.error).toMatch(/PDF, Word doc, Excel file, or text file/)
  })
})

describe('unified Analyst — LP and diligence domains', () => {
  it('gives the LP block to an entitled user, and scopes the thread to it', async () => {
    const { status, system, json } = await post({ messages: msgs, domain: 'lps' })

    expect(status).toBe(200)
    expect(system).toContain('=== LP CAPITAL ===')
    expect(system).toContain('LP ROLL-UP: Cranmore commit 5000000')
    // The LP domain is not the accounting domain: no books, and no ability to draft entries.
    expect(system).not.toContain('PRIMARY VEHICLE BOOKS')
    expect(system).not.toContain('DRAFTING ENTRIES')
    expect(json.scope).toBe('lps')
  })

  it('withholds the LP block from a member with no LP grant', async () => {
    memberWith({ portfolio: 'write' })

    const { system, json } = await post({ messages: msgs, domain: 'lps' })

    expect(system).not.toContain('LP ROLL-UP')
    expect(buildLpContext).not.toHaveBeenCalled()
    // Denied, so the thread falls back to the portfolio scope rather than opening an LP one.
    expect(json.scope).toBeNull()
  })

  it('withholds the LP block from a member when the fund keeps LPs admin-only, grant or not', async () => {
    memberWith({ lp_capital: 'write' })
    tables.fund_settings = { feature_visibility: { lps: 'admin' } }

    const { system } = await post({ messages: msgs, domain: 'lps' })

    expect(system).not.toContain('LP ROLL-UP')
    expect(buildLpContext).not.toHaveBeenCalled()
  })

  it('gives the LP block to a granted member once the fund opens LPs to members', async () => {
    memberWith({ lp_capital: 'read' })

    const { system } = await post({ messages: msgs, domain: 'lps' })

    expect(system).toContain('LP ROLL-UP')
  })

  it('gives the diligence block to an entitled user', async () => {
    const { system, json } = await post({ messages: msgs, domain: 'diligence' })

    expect(system).toContain('=== DILIGENCE PIPELINE ===')
    expect(system).toContain('PIPELINE: 3 deals')
    expect(system).not.toContain('LP ROLL-UP')
    expect(json.scope).toBe('diligence')
  })

  it('withholds diligence when the fund has it switched off, even from an admin', async () => {
    tables.fund_settings = { feature_visibility: { diligence: 'off' } }

    const { system, json } = await post({ messages: msgs, domain: 'diligence' })

    expect(system).not.toContain('PIPELINE:')
    expect(buildDiligenceContext).not.toHaveBeenCalled()
    expect(json.scope).toBeNull()
  })

  it('403s the inbound-deal scope for a member with no dealflow grant', async () => {
    // This path used to answer for ANY fund member, checking only that the deal belonged to the
    // fund — no role check, no feature check.
    memberWith({ portfolio: 'write' })

    const { status } = await post({ messages: msgs, dealId: 'd1' })

    expect(status).toBe(403)
    expect(createChat).not.toHaveBeenCalled()
  })
})
