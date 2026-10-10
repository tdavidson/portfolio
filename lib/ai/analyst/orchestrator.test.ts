import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

const mocks = vi.hoisted(() => ({
  getConstructionModel: vi.fn(),
  createToolLoop: vi.fn(),
  createChat: vi.fn(),
  logAIUsage: vi.fn(),
  buildPortfolioContext: vi.fn(),
  buildCompanyContext: vi.fn(async () => null),
  conversationBelongsToPrincipal: vi.fn(),
  loadConversationMemory: vi.fn(),
  persistConversation: vi.fn(),
  extractText: vi.fn(),
}))

vi.mock('@/lib/accounting/construction-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/construction-service')>()),
  getConstructionModel: mocks.getConstructionModel,
}))
vi.mock('@/lib/ai', () => ({
  createFundAIProviderWithOverride: async () => ({
    provider: {
      supportsToolLoop: true,
      createToolLoop: mocks.createToolLoop,
      createChat: mocks.createChat,
    },
    model: 'test-model',
    providerType: 'anthropic',
  }),
}))
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: mocks.logAIUsage }))
vi.mock('@/lib/ai/topical-guard', () => ({ withTopicalGuardrail: (value: string) => value }))
vi.mock('@/lib/ai/context-builder', () => ({
  buildPortfolioContext: mocks.buildPortfolioContext,
  buildCompanyContext: mocks.buildCompanyContext,
  buildDealContext: async () => null,
}))
vi.mock('@/lib/memo-agent/extract-text', () => ({ extractText: mocks.extractText }))
vi.mock('./conversation-store', () => ({
  conversationBelongsToPrincipal: mocks.conversationBelongsToPrincipal,
  loadConversationMemory: mocks.loadConversationMemory,
  persistConversation: mocks.persistConversation,
}))

import { runAnalyst, toolLabel } from './orchestrator'

function query(data: unknown): any {
  const result = { data, error: null }
  const handler: ProxyHandler<any> = {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      if (property === 'maybeSingle' || property === 'single') return async () => result
      return () => proxy
    },
  }
  const proxy = new Proxy({}, handler)
  return proxy
}

const adminFrom = vi.fn(() => query([]))
const admin = { from: adminFrom } as any
const features = Object.fromEntries(
  Object.keys(DEFAULT_FEATURE_VISIBILITY).map(key => [key, 'everyone']),
) as FeatureVisibilityMap
const access: AccessContext = {
  fundId: 'fund-1',
  userId: 'user-1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  features,
  grants: { accounting: 'read' },
  defaults: {},
}
const principal = { userId: 'user-1', fundId: 'fund-1', role: 'member', access }

const canonical = {
  vehicle: 'Fund II',
  vehicleId: 'vehicle-2',
  vintageYear: 2024,
  ledgerAvailable: true,
  asOf: '2026-09-02T12:00:00.000Z',
  actuals: {},
  assumptions: {
    feeAnnualRate: 0.02,
    feeBasis: 'committed',
    feeTermYears: 7,
    annualPartnershipExpense: 25_000,
    remainingOrgCosts: 10_000,
  },
  forecast: {
    capital: {
      committedCapital: 10_000_000,
      calledCapital: 4_000_000,
      uncalledCapital: 6_000_000,
      investable: 8_000_000,
      deployedTotal: 3_000_000,
      remaining: 5_000_000,
      plannedExistingFollowOn: 500_000,
      plannedNewCapital: 1_000_000,
      plannedNewFollowOn: 1_000_000,
      gap: 2_500_000,
    },
  },
  positions: [],
  warnings: [],
}

describe('runAnalyst', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConstructionModel.mockResolvedValue(canonical)
    mocks.buildPortfolioContext.mockResolvedValue({
      systemPrompt: 'You are the Analyst.',
      portfolioBlock: '',
      teamNotesBlock: '',
    })
    mocks.conversationBelongsToPrincipal.mockResolvedValue(true)
    mocks.loadConversationMemory.mockResolvedValue('')
    mocks.persistConversation.mockResolvedValue('conversation-1')
    mocks.logAIUsage.mockResolvedValue(undefined)
    mocks.createToolLoop.mockImplementation(async (params: any) => {
      await params.executeTool({ name: 'portfolio_construction', input: { vehicle: 'Fund II' } })
      return {
        text: 'Fund II has $5 million remaining.',
        usage: { inputTokens: 10, outputTokens: 8 },
        toolCalls: [{ name: 'portfolio_construction', input: {}, resultPreview: '{}', isError: false }],
      }
    })
  })

  it('runs outside a route and builds construction blocks from the completed tool result', async () => {
    const controller = new AbortController()
    const result = await runAnalyst(principal, {
      messages: [{ role: 'user', content: 'How much capital remains in Fund II?' }],
      scope: { domain: 'funds' },
      signal: controller.signal,
    }, { admin, isRateLimited: async () => false })

    expect(result.reply).toBe('Fund II has $5 million remaining.')
    expect(result.conversationId).toBe('conversation-1')
    expect(result.toolCalls).toEqual([{ name: 'portfolio_construction' }])
    expect(result.blocks).toEqual([
      expect.objectContaining({
        version: 1,
        type: 'constructionSummary',
        data: expect.objectContaining({
          vehicle: 'Fund II',
          capital: expect.objectContaining({ remaining: 5_000_000 }),
        }),
      }),
    ])
    expect(mocks.getConstructionModel).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: 'fund-1' }),
      { vehicle: 'Fund II' },
    )
    expect(mocks.createToolLoop).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }))
    expect(mocks.logAIUsage).toHaveBeenCalledTimes(1)
  })

  it('stops an aborted run before model work or conversation persistence', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(runAnalyst(principal, {
      messages: [{ role: 'user', content: 'How much capital remains in Fund II?' }],
      scope: { domain: 'funds' },
      signal: controller.signal,
    }, { admin, isRateLimited: async () => false })).rejects.toMatchObject({ name: 'AbortError' })

    expect(mocks.createToolLoop).not.toHaveBeenCalled()
    expect(mocks.logAIUsage).not.toHaveBeenCalled()
    expect(mocks.persistConversation).not.toHaveBeenCalled()
  })

  it('does not request team notes without the relationships/notes grant', async () => {
    const portfolioPrincipal = {
      ...principal,
      access: { ...access, grants: { portfolio: 'read' as const } },
    }
    await runAnalyst(portfolioPrincipal, {
      messages: [{ role: 'user', content: 'How is the portfolio?' }],
    }, { admin, isRateLimited: async () => false })

    expect(mocks.buildPortfolioContext).toHaveBeenCalledWith(admin, 'fund-1', {
      includeTeamNotes: false,
      scope: expect.objectContaining({ vehicleNames: null, companyIds: null }),
    })
  })

  it('treats a company outside the caller\'s entities as not found, and scopes the portfolio context', async () => {
    // A member granted one entity (v1), which holds c1 only.
    const tables: Record<string, unknown> = {
      company_vehicles: [{ company_id: 'c1' }],
      fund_vehicles: [{ name: 'Fund I', aliases: [] }],
    }
    // companies: a list for name detection, one row for the company check.
    const companies = () => {
      const q = query([{ id: 'c1', name: 'Acme', aliases: [] }])
      return new Proxy(q, { get: (t, k) => k === 'maybeSingle' ? async () => ({ data: { fund_id: 'fund-1' }, error: null }) : (k === 'then' ? t.then : () => companies()) })
    }
    const scopedAdmin = { from: (t: string) => t === 'companies' ? companies() : query(tables[t] ?? []) } as any
    const member = {
      ...principal,
      access: { ...access, vehicles: { all: false, ids: ['v1'] }, grants: { portfolio: 'read' as const } },
    }
    await expect(runAnalyst(member, {
      messages: [{ role: 'user', content: 'How is it doing?' }],
      scope: { companyId: 'c2' },
    }, { admin: scopedAdmin, isRateLimited: async () => false })).rejects.toMatchObject({ status: 404 })
    // Refused before any of its data is read.
    expect(mocks.buildCompanyContext).not.toHaveBeenCalledWith(scopedAdmin, 'c2', expect.anything())

    mocks.buildPortfolioContext.mockResolvedValue({ systemPrompt: '', portfolioBlock: '', teamNotesBlock: '' })
    await runAnalyst(member, { messages: [{ role: 'user', content: 'How is the portfolio?' }] },
      { admin: scopedAdmin, isRateLimited: async () => false }).catch(() => {})
    expect(mocks.buildPortfolioContext).toHaveBeenLastCalledWith(scopedAdmin, 'fund-1', expect.objectContaining({
      scope: expect.objectContaining({ vehicleNames: ['Fund I'], companyIds: ['c1'] }),
    }))
  })

  it('does not preload portfolio context for a principal without portfolio access', async () => {
    await runAnalyst(principal, {
      messages: [{ role: 'user', content: 'How much capital remains in Fund II?' }],
      scope: { domain: 'funds' },
    }, { admin, isRateLimited: async () => false })

    expect(mocks.buildPortfolioContext).not.toHaveBeenCalled()
    expect(adminFrom).not.toHaveBeenCalledWith('companies')
  })

  it('puts an attached document in front of the model outside accounting scope', async () => {
    mocks.extractText.mockResolvedValue('Capital call notice: $250,000 due 2026-09-15.')
    const portfolioPrincipal = {
      ...principal,
      access: { ...access, grants: { portfolio: 'read' as const } },
    }
    await runAnalyst(portfolioPrincipal, {
      messages: [{ role: 'user', content: 'What does this say?' }],
      document: { name: 'notice.pdf', format: 'pdf', base64: Buffer.from('%PDF-1.4').toString('base64') },
    }, { admin, isRateLimited: async () => false })

    expect(mocks.extractText).toHaveBeenCalledWith(expect.any(Buffer), 'pdf')
    const system = mocks.createToolLoop.mock.calls[0][0].system as string
    expect(system).toContain('=== SOURCE DOCUMENT: notice.pdf ===')
    expect(system).toContain('Capital call notice: $250,000 due 2026-09-15.')
  })

  it('rejects an unreadable attachment outside accounting scope instead of ignoring it', async () => {
    const portfolioPrincipal = {
      ...principal,
      access: { ...access, grants: { portfolio: 'read' as const } },
    }
    await expect(runAnalyst(portfolioPrincipal, {
      messages: [{ role: 'user', content: 'What does this say?' }],
      document: { name: 'photo.png', format: 'png', base64: Buffer.from('x').toString('base64') },
    }, { admin, isRateLimited: async () => false })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_DOCUMENT',
    })
  })

  it('refuses an explicit company scope without portfolio access', async () => {
    await expect(runAnalyst(principal, {
      messages: [{ role: 'user', content: 'Tell me about the company' }],
      scope: { companyId: 'company-1' },
    }, { admin, isRateLimited: async () => false })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })
})

describe('coarse progress for streaming transports', () => {
  it('turns a tool name into a label a person reads, not a database detail', () => {
    expect(toolLabel('portfolio_construction')).toBe('Loading portfolio construction')
    expect(toolLabel('forecast_suggest_rules')).toBe('Reading account history to suggest forecast rules')
    expect(toolLabel('list_capital_calls')).toBe('List capital calls')
    expect(toolLabel('company-metrics')).toBe('Company metrics')
    expect(toolLabel('')).toBe('Working')
  })
})
