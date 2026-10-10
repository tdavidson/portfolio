import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The analyst route runs as a live TOOL LOOP when the fund's provider supports it, and falls back
 * to the old single-shot createChat when it doesn't (OpenAI/Gemini/Ollama). This pins the guarded
 * swap and that tool-call names (not payloads) are surfaced in the response.
 */

const createChat = vi.hoisted(() => vi.fn())
const createToolLoop = vi.hoisted(() => vi.fn())
const supportsToolLoop = vi.hoisted(() => ({ value: false }))
const buildAnalystTools = vi.hoisted(() => vi.fn(() => ({ tools: [], executeTool: async () => '' })))

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
vi.mock('@/lib/ai/analyst-tools', () => ({ buildAnalystTools }))
vi.mock('@/lib/accounting/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounting/assistant')>()),
  buildAccountingContext: async () => 'BOOKS',
}))
vi.mock('@/lib/ai/lp-fund-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/lp-fund-context')>()),
  buildLpContext: async () => 'LP',
}))
vi.mock('@/lib/diligence/analyst-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diligence/analyst-context')>()),
  buildDiligenceContext: async () => 'PIPELINE',
}))
vi.mock('@/lib/memo-agent/extract-text', () => ({ extractText: async () => '' }))
vi.mock('@/lib/ai', () => ({
  createFundAIProviderWithOverride: async () => ({
    provider: {
      createChat,
      createToolLoop,
      get supportsToolLoop() {
        return supportsToolLoop.value
      },
    },
    model: 'test-model',
    providerType: 'anthropic',
  }),
}))

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

function memberWith(grants: Record<string, string>) {
  tables.fund_members = { fund_id: 'f1', role: 'member' }
  tables.fund_settings = {
    feature_visibility: { accounting: 'everyone', lps: 'everyone', diligence: 'everyone', deals: 'everyone', gp_economics: 'everyone' },
  }
  tables.fund_member_access = Object.entries(grants).map(([domain, level]) => ({ domain, level }))
  tables.analyst_conversations = { id: 'conv1' }
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/analyst/route')
  const req = { json: async () => body } as any
  const res = await POST(req)
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'u1' }
  supportsToolLoop.value = false
  tables = {}
})

describe('analyst route — tool loop vs createChat', () => {
  it('uses createToolLoop when the provider supports it, surfacing tool-call names', async () => {
    memberWith({ accounting: 'read' })
    supportsToolLoop.value = true
    createToolLoop.mockResolvedValue({
      text: 'hi',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ name: 'list_accounts', input: {}, resultPreview: '...', isError: false }],
    })

    const { status, json } = await post({ messages: [{ role: 'user', content: 'x' }], vehicle: 'Fund IV' })

    expect(status).toBe(200)
    expect(createToolLoop).toHaveBeenCalled()
    expect(createChat).not.toHaveBeenCalled()
    expect(json.reply).toBe('hi')
    expect(json.toolCalls).toEqual([{ name: 'list_accounts' }])
    expect(json).toMatchObject({
      conversationId: 'conv1',
      proposals: [],
      vehicle: 'Fund IV',
      scope: 'accounting:Fund IV',
      stagedActions: [],
      blocks: [],
    })
  })

  it('falls back to createChat when the provider lacks tool support', async () => {
    memberWith({ accounting: 'read' })
    supportsToolLoop.value = false
    createChat.mockResolvedValue({ text: 'plain', usage: { inputTokens: 1, outputTokens: 1 } })

    const { status, json } = await post({ messages: [{ role: 'user', content: 'x' }], vehicle: 'Fund IV' })

    expect(status).toBe(200)
    expect(createChat).toHaveBeenCalled()
    expect(createToolLoop).not.toHaveBeenCalled()
    expect(json.reply).toBe('plain')
  })
})

describe('analyst route — streamed progress', () => {
  it('streams each step as it starts and finishes, then the same result body', async () => {
    memberWith({ accounting: 'read' })
    supportsToolLoop.value = true
    // The loop calls the executor it was given; that is where progress comes from.
    createToolLoop.mockImplementation(async (opts: any) => {
      await opts.executeTool({ name: 'forecast_suggest_rules', input: {} })
      return { text: 'drafted', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ name: 'forecast_suggest_rules' }] }
    })
    const { POST } = await import('@/app/api/analyst/route')
    const res = await POST({ json: async () => ({ messages: [{ role: 'user', content: 'x' }], vehicle: 'Fund IV', stream: true }) } as any)
    expect(res.headers.get('content-type')).toContain('ndjson')
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.type)).toEqual(['started', 'progress', 'progress', 'result'])
    expect(lines[1].event).toEqual({ kind: 'tool.started', tool: 'forecast_suggest_rules', label: 'Reading account history to suggest forecast rules' })
    expect(lines[2].event).toMatchObject({ kind: 'tool.completed', isError: false })
    expect(lines[3].data).toMatchObject({ reply: 'drafted', toolCalls: [{ name: 'forecast_suggest_rules' }] })
  })

  it('ends a failed run with an error line, not a hang', async () => {
    memberWith({ accounting: 'read' })
    supportsToolLoop.value = true
    createToolLoop.mockRejectedValue(new Error('provider down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await import('@/app/api/analyst/route')
    const res = await POST({ json: async () => ({ messages: [{ role: 'user', content: 'x' }], stream: true }) } as any)
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(lines[lines.length - 1]).toMatchObject({ type: 'error', status: 500 })
  })
})
