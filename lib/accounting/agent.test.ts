import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, bearerToken, authorizeToolUse, type ResolvedKey } from './api-keys'
import { AGENT_TOOLS, getTool, accessDomainFor, accessDomainForCall, accessFeatureFor } from './agent-tools'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const key = (role: string, scopes: string[]): ResolvedKey => ({ fundId: 'f', keyId: 'k', userId: 'u', role, scopes })

/** An access context with everything switched on, and the given grants. */
const ctx = (role: 'admin' | 'member' | 'viewer', grants: Partial<Record<Domain, AccessLevel>>): AccessContext => ({
  fundId: 'f',
  userId: 'u',
  vehicles: { all: true, ids: [] },
  role,
  features: Object.fromEntries(
    Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone']),
  ) as FeatureVisibilityMap,
  grants,
  defaults: {},
})

/**
 * A credential can never exceed its owner.
 *
 * This replaced "reads for any member, writes for admins" — which was the ENTIRE authorization for
 * MCP and the REST agent, applied identically to every domain. A read key from any member read the
 * whole fund: LP capital, diligence memos, carry.
 */
describe('authorizeToolUse — the credential scope AND the owner’s grant', () => {
  it('allows a read when the owner is granted the domain', () => {
    expect(authorizeToolUse('read', key('member', ['read']), ctx('member', { accounting: 'read' }), 'accounting')).toBeNull()
  })

  it('refuses a read the owner has no grant for, however the key was scoped', () => {
    const denied = authorizeToolUse('read', key('member', ['read', 'write']), ctx('member', {}), 'gp_economics')
    expect(denied).toMatch(/GP economics/)
  })

  it('lets a member with a write grant write — a member is no longer read-only by role', () => {
    expect(authorizeToolUse('write', key('member', ['read', 'write']), ctx('member', { accounting: 'write' }), 'accounting')).toBeNull()
  })

  it('refuses a write where the owner is granted read only', () => {
    expect(authorizeToolUse('write', key('member', ['read', 'write']), ctx('member', { accounting: 'read' }), 'accounting'))
      .toMatch(/write access to Fund accounting/)
  })

  it('refuses a write through a read-only credential even for an admin', () => {
    // The scope is the ceiling the OWNER chose at mint time; grants are the ceiling the ADMIN
    // chose. The lower wins.
    expect(authorizeToolUse('write', key('admin', ['read']), ctx('admin', {}), 'accounting')).toMatch(/read-only/i)
  })

  it('gives an admin every domain without a single grant row', () => {
    expect(authorizeToolUse('write', key('admin', ['read', 'write']), ctx('admin', {}), 'gp_economics')).toBeNull()
    expect(authorizeToolUse('read', key('admin', ['read']), ctx('admin', {}), 'lp_capital')).toBeNull()
  })

  it('refuses a write from the read-only demo, whatever its grants say', () => {
    expect(authorizeToolUse('write', key('viewer', ['read', 'write']), ctx('viewer', { accounting: 'write' }), 'accounting'))
      .toMatch(/write access/)
  })
})

describe('tool access domains', () => {
  it('routes the ledger tools that are really LP capital away from plain accounting', () => {
    // The point of the split: someone who can reconcile the bank must not thereby read every
    // partner's capital account.
    expect(accessDomainFor(getTool('capital_accounts')!)).toBe('lp_capital')
    expect(accessDomainFor(getTool('list_entities')!)).toBe('lp_capital')
    expect(accessDomainFor(getTool('reconcile')!)).toBe('lp_capital')
    expect(accessDomainFor(getTool('book_capital_call')!)).toBe('lp_capital')
    expect(accessDomainFor(getTool('list_lps')!)).toBe('lp_capital')
  })

  it('routes carry to gp_economics', () => {
    expect(accessDomainFor(getTool('run_waterfall')!)).toBe('gp_economics')
  })

  it('leaves plain bookkeeping in accounting', () => {
    expect(accessDomainFor(getTool('list_journal')!)).toBe('accounting')
    expect(accessDomainFor(getTool('post_entry')!)).toBe('accounting')
    expect(accessDomainFor(getTool('financial_statements')!)).toBe('accounting')
  })

  it('derives the other manifests from their dispatch grouping', () => {
    expect(accessDomainFor(getTool('list_companies')!)).toBe('portfolio')
    expect(accessDomainFor(getTool('diligence_list_deals')!)).toBe('diligence')
    expect(accessDomainFor(getTool('deals_list_inbound')!)).toBe('dealflow')
    expect(accessDomainFor(getTool('lp_live_report')!)).toBe('lp_capital')
  })

  it('elevates an allocation to gp_economics only when it is computing carry', () => {
    // Gating the tool at gp_economics would lock ops out of the close; gating it at accounting
    // would hand them the carry. The action decides.
    const allocation = getTool('allocation')!
    expect(accessDomainForCall(allocation, { action: 'management_fee' })).toBe('accounting')
    expect(accessDomainForCall(allocation, { action: 'close_period' })).toBe('accounting')
    expect(accessDomainForCall(allocation, { action: 'carry' })).toBe('gp_economics')
    expect(accessDomainForCall(allocation, {})).toBe('accounting')
  })

  it('gives every tool a real domain', () => {
    for (const t of AGENT_TOOLS) expect(typeof accessDomainFor(t)).toBe('string')
  })

  it('sends fund_performance to accounting — it reads the LP register, not the portfolio', () => {
    // `portfolio` has NO fund-level switch, so leaving it there served committed/called/NAV over
    // MCP even to a fund with accounting switched off entirely.
    expect(accessDomainFor(getTool('fund_performance')!)).toBe('accounting')
  })

  it('sends portfolio construction to accounting while keeping it fund-scoped', () => {
    const tool = getTool('portfolio_construction')!
    expect(accessDomainFor(tool)).toBe('accounting')
    expect(authorizeToolUse('read', key('member', ['read']), ctx('member', {}), accessDomainFor(tool)))
      .toMatch(/Fund accounting/)
    expect(authorizeToolUse('read', key('member', ['read']), ctx('member', { accounting: 'read' }), accessDomainFor(tool)))
      .toBeNull()
  })
})

describe('tool feature keys — hidden/off must reach MCP too', () => {
  // `portfolio`, `relationships` and `lp_relations` span several independently-switchable
  // features, so their domain has no primaryFeature and effectiveAccess with no feature reads the
  // ceiling as wide open. A tool under those domains must name its own key or the fund's switch
  // simply doesn't apply over MCP — not even for an admin.
  it('names the investments switch on the tools that read and write investments', () => {
    expect(accessFeatureFor(getTool('list_investments')!)).toBe('investments')
    expect(accessFeatureFor(getTool('record_investment')!)).toBe('investments')
  })

  it('actually withholds a hidden feature from an admin over MCP', () => {
    const hidden = {
      ...ctx('admin', {}),
      features: { ...DEFAULT_FEATURE_VISIBILITY, investments: 'hidden' } as FeatureVisibilityMap,
    }
    const tool = getTool('list_investments')!
    expect(authorizeToolUse('read', key('admin', ['read']), hidden, accessDomainFor(tool), accessFeatureFor(tool)))
      .toMatch(/does not have access/)
    // Without the feature key it would sail through — which is exactly the bug.
    expect(authorizeToolUse('read', key('admin', ['read']), hidden, accessDomainFor(tool))).toBeNull()
  })

  it('leaves tools whose domain has a single switch alone', () => {
    expect(accessFeatureFor(getTool('list_journal')!)).toBeUndefined()
    expect(accessFeatureFor(getTool('diligence_list_deals')!)).toBeUndefined()
  })
})

describe('api-keys', () => {
  it('generates a prefixed token whose hash is stable and matches', () => {
    const k = generateApiKey()
    expect(k.token.startsWith('lk_')).toBe(true)
    expect(k.prefix).toBe(k.token.slice(0, 11))
    expect(k.hash).toBe(hashApiKey(k.token))
    expect(k.hash).toHaveLength(64) // sha256 hex
  })

  it('produces distinct tokens each call', () => {
    expect(generateApiKey().token).not.toBe(generateApiKey().token)
  })

  it('extracts a Bearer token case-insensitively', () => {
    const req = new Request('https://x.test', { headers: { Authorization: 'Bearer lk_abc123' } })
    expect(bearerToken(req)).toBe('lk_abc123')
    expect(bearerToken(new Request('https://x.test'))).toBeNull()
  })
})

describe('agent tool registry', () => {
  it('every tool has a unique name, description, scope, and object input schema', () => {
    const names = new Set<string>()
    for (const t of AGENT_TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/)
      expect(names.has(t.name)).toBe(false)
      names.add(t.name)
      expect(t.description.length).toBeGreaterThan(10)
      expect(['read', 'write']).toContain(t.scope)
      expect(t.inputSchema.type).toBe('object')
      expect(typeof t.handler).toBe('function')
    }
  })

  it('exposes the core ledger operations', () => {
    for (const name of ['list_accounts', 'capital_accounts', 'post_entry', 'allocation', 'reconcile', 'financial_statements', 'run_waterfall']) {
      expect(getTool(name)).toBeDefined()
    }
    expect(getTool('nope')).toBeUndefined()
  })

  it('run_waterfall is a pure tool that needs no DB', async () => {
    const tool = getTool('run_waterfall')!
    const res = await tool.handler(
      { admin: null as any, fundId: 'f', portfolioGroup: 'v', userId: null, access: ctx('admin', {}) },
      { distributable: 12_000_000, terms: { carryRate: 0.2 }, state: { contributedCapital: 10_000_000, returnedCapital: 0, preferredPaid: 0, preferredTarget: 800_000, gpCarryPaid: 0 } }
    )
    expect(res.toGP).toBe(400_000)
    expect(res.toLP + res.toGP).toBe(12_000_000)
  })
})
