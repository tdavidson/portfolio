import { describe, it, expect } from 'vitest'

/**
 * THE THREE DOORS AGREE.
 *
 * Everything a person can do in this app, they can do three ways: the web (a route under
 * app/api, gated by proxy.ts against ROUTE_DOMAINS and ADMIN_ONLY_ROUTES), MCP (an assistant's
 * tools/call, gated by authorizeMcpTool) and the REST agent API (POST /api/agent, gated by
 * authorizeToolUse and the dispatcher's admin-only check). Each door has its own registry, so they
 * can drift apart without anyone noticing: a preset that can post journal entries on the web but
 * not over MCP, or the reverse, which is worse.
 *
 * This runs every role a fund hands out (the access presets, an admin, the demo viewer, and a
 * member with nothing) through pairs of a web route and the tool that does the same thing, and
 * requires the same answer from all three doors. It also requires MCP's tool list and the API's to
 * show each person the same tools.
 *
 * What it does not decide: whether a deployment offers destructive tools at all
 * (AGENT_DESTRUCTIVE_ACTIONS), and whether a chat's write is staged for approval. Those are about
 * how a change is made, not who may make it. Entity scoping is pinned in lib/access/engagements.test.ts.
 *
 * Adding a tool that mirrors a route? Add the pair below.
 */

import { ROUTE_DOMAINS, requiredLevel } from '@/lib/access/route-domains'
import { ADMIN_ONLY_ACTIONS, adminOnlyRule } from '@/lib/access/admin-only'
import { hasAccess, type AccessContext, type AccessLevel } from '@/lib/access/effective'
import { ACCESS_PRESETS } from '@/lib/access/presets'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { AGENT_TOOLS, accessDomainForCall, accessFeatureFor, getTool, toolListedFor } from '@/lib/accounting/agent-tools'
import { authorizeToolUse, type ResolvedKey } from '@/lib/accounting/api-keys'
import { adminOnlyRefusal } from '@/lib/agent/dispatch'
import { authorizeMcpTool, listableTools, MCP_TOOLS } from '@/lib/mcp-apps/server'
import { isProposer } from '@/lib/accounting/proposals'
import { isToolOffered } from '@/lib/agent/destructive'

// Every switch on, so the comparison is about grants and roles, not a fund's feature choices.
const ALL_ON = Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap

const person = (role: AccessContext['role'], grants: Partial<Record<Domain, AccessLevel>> = {}): AccessContext => ({
  fundId: 'f1', userId: 'u1', role, features: ALL_ON, grants, defaults: {}, vehicles: { all: true, ids: [] },
})

const PEOPLE: [string, AccessContext][] = [
  ['admin', person('admin')],
  ['demo viewer', person('viewer')],
  ['member with nothing', person('member')],
  ...ACCESS_PRESETS.map(p => [`${p.label} preset`, person('member', p.grants)] as [string, AccessContext]),
]

/** A script's API key: not an assistant credential, so admin-only writes are refused rather than staged. */
const scriptKey = (access: AccessContext): ResolvedKey => ({
  fundId: access.fundId, keyId: 'key_script', userId: access.userId, role: access.role, scopes: ['read', 'write'],
})

interface Pair {
  /** What a person is doing, for the failure message. */
  what: string
  route: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown>
  tool: string
  input?: Record<string, unknown>
  /**
   * An admin-only check the route's handler makes itself rather than through ADMIN_ONLY_ROUTES
   * (the tool's twin is in ADMIN_ONLY_TOOLS or the shared service).
   */
  handlerAdminOnly?: true
  /**
   * What the route's handler lets a proposer do once the gate has passed them at `propose`. The
   * journal takes a proposer's new entry and their withdrawal of their own proposal; nothing else.
   */
  proposer?: 'allowed' | 'refused'
}

const PAIRS: Pair[] = [
  { what: 'read the journal', route: 'api/accounting/journal', method: 'GET', tool: 'list_journal' },
  { what: "read a deal's diligence rounds", route: 'api/diligence/[id]/rounds', method: 'GET', tool: 'diligence_rounds' },
  { what: 'start the next diligence round', route: 'api/diligence/[id]/rounds', method: 'POST', tool: 'diligence_round_save' },
  { what: 'close or rename a diligence round', route: 'api/diligence/[id]/rounds/[roundId]', method: 'PATCH', tool: 'diligence_round_save' },
  { what: 'make a journal entry (a proposal for a proposer)', route: 'api/accounting/journal', method: 'POST', body: { status: 'draft' }, tool: 'post_entry', proposer: 'allowed' },
  { what: 'withdraw their own proposal', route: 'api/accounting/journal', method: 'PATCH', body: { action: 'void' }, tool: 'withdraw_proposal', proposer: 'allowed' },
  // A draft is discarded (discard_drafts); voiding a POSTED entry is admin-only, which the handler
  // checks from the row (journal-state.ts) and void_entry carries in ADMIN_ONLY_TOOLS.
  { what: 'void a posted entry', route: 'api/accounting/journal', method: 'PATCH', body: { action: 'void' }, tool: 'void_entry', proposer: 'refused', handlerAdminOnly: true },
  { what: 'discard drafts', route: 'api/accounting/journal/bulk-void', method: 'POST', tool: 'discard_drafts' },
  { what: 'post drafts', route: 'api/accounting/journal/bulk-post', method: 'POST', tool: 'post_drafts' },
  { what: 'unpost an entry', route: 'api/accounting/journal', method: 'PATCH', body: { action: 'unpost' }, tool: 'unpost_entry', proposer: 'refused' },
  { what: 'reverse an entry', route: 'api/accounting/journal', method: 'PATCH', body: { action: 'reverse' }, tool: 'reverse_entry', proposer: 'refused' },
  { what: 'close a period', route: 'api/accounting/periods', method: 'POST', body: { action: 'close' }, tool: 'close_period' },
  { what: 'reopen a period', route: 'api/accounting/periods', method: 'POST', body: { action: 'reopen' }, tool: 'reopen_period' },
  { what: 'change waterfall terms', route: 'api/accounting/waterfall-terms', method: 'PUT', tool: 'set_waterfall_terms' },
  { what: 'delete a company', route: 'api/companies/[id]', method: 'DELETE', tool: 'delete_company' },
  { what: 'change an LP\'s record', route: 'api/lps/entities/profile', method: 'PATCH', tool: 'lp_update_profile' },
  { what: 'give an advisor portal access', route: 'api/lps/authorized-users', method: 'POST', tool: 'lp_authorized_user_add', handlerAdminOnly: true },
  { what: 'issue a capital call', route: 'api/accounting/capital-calls', method: 'POST', body: { action: 'issue' }, tool: 'issue_capital_call' },
  { what: 'add a commitment', route: 'api/accounting/commitments', method: 'POST', tool: 'lp_record_commitment' },
  { what: 'add an LP investor', route: 'api/lps/investors', method: 'POST', tool: 'lp_create_investor', handlerAdminOnly: true },
  { what: 'delete LP positions', route: 'api/accounting/positions', method: 'DELETE', tool: 'delete_lp_positions' },
  { what: 'announce to LPs', route: 'api/lps/announce', method: 'POST', tool: 'lp_announce' },
  { what: 'remove a team member', route: 'api/settings/members/[id]', method: 'DELETE', tool: 'remove_member' },
  { what: 'see LP change requests', route: 'api/lps/change-requests', method: 'GET', tool: 'lp_change_requests' },
  { what: 'reprocess a saved company update', route: 'api/emails/[id]/reprocess', method: 'POST', tool: 'reprocess_company_update' },
  { what: 'decide an LP change request', route: 'api/lps/change-requests', method: 'POST', body: { decision: 'reject' }, tool: 'lp_change_request_decide' },
]

/** The web door: the proxy's gate (ROUTE_DOMAINS, then ADMIN_ONLY_ROUTES), then the handler's own checks. */
function web(access: AccessContext, p: Pair): boolean {
  const entry = ROUTE_DOMAINS[p.route]
  const level = requiredLevel(entry, p.method)
  if (level !== 'any' && !hasAccess(access, entry.domain, level, entry.feature)) return false
  if (access.role !== 'admin' && (adminOnlyRule(p.route, p.method, p.body ?? {}) || p.handlerAdminOnly)) return false
  // Past a `propose` gate, the journal's handler decides what a proposer may do.
  if (level === 'propose' && isProposer(access)) return p.proposer === 'allowed'
  // A read-only demo changes nothing, whatever a route's level.
  if (access.role === 'viewer' && level !== 'read') return false
  return true
}

/** The REST agent API: authorizeToolUse, then the dispatcher's admin-only refusal for a script key. */
function api(access: AccessContext, p: Pair): boolean {
  const tool = getTool(p.tool)!
  const input = p.input ?? p.body ?? {}
  const key = scriptKey(access)
  if (authorizeToolUse(tool.scope, key, access, accessDomainForCall(tool, input), accessFeatureFor(tool), tool.proposable === true)) return false
  if (tool.scope === 'write' && adminOnlyRefusal(tool, input, key)) return false
  if (stagedForAdmin(tool.stagesAs, access)) return false
  if (tool.scope === 'write' && access.role === 'viewer') return false
  return true
}

/**
 * A tool that always stages as a pending action (stagesAs) is done when it is approved, and
 * ADMIN_ONLY_ACTIONS says who may approve it. A member staging one has asked, not done it.
 */
function stagedForAdmin(stagesAs: string | undefined, access: AccessContext): boolean {
  return !!stagesAs && !!ADMIN_ONLY_ACTIONS[stagesAs] && access.role !== 'admin'
}

/** MCP: authorizeMcpTool, then the same admin-only refusal. */
function mcp(access: AccessContext, p: Pair): boolean {
  const tool = MCP_TOOLS.find(t => t.name === p.tool)!
  const input = p.input ?? p.body ?? {}
  const key = scriptKey(access)
  if (authorizeMcpTool(tool, key, access, input)) return false
  if (tool.scope === 'write' && adminOnlyRefusal(getTool(p.tool)!, input, key)) return false
  if (stagedForAdmin(getTool(p.tool)!.stagesAs, access)) return false
  if (tool.scope === 'write' && access.role === 'viewer') return false
  return true
}

describe('the three doors agree', () => {
  it('pairs only routes and tools that exist', () => {
    for (const p of PAIRS) {
      expect(ROUTE_DOMAINS[p.route], p.route).toBeDefined()
      expect(getTool(p.tool), p.tool).toBeDefined()
      expect(MCP_TOOLS.some(t => t.name === p.tool), `${p.tool} on MCP`).toBe(true)
    }
  })

  for (const [who, access] of PEOPLE) {
    it(`give the ${who} the same answer on the web, MCP and the API`, () => {
      const disagreements = PAIRS
        .map(p => ({ what: p.what, web: web(access, p), mcp: mcp(access, p), api: api(access, p) }))
        .filter(r => r.web !== r.mcp || r.web !== r.api)
      expect(disagreements, `${who}: ${JSON.stringify(disagreements, null, 2)}`).toEqual([])
    })
  }

  it('let a proposer propose and withdraw on every door, and nothing else that changes the books', () => {
    const auditor = PEOPLE.find(([w]) => w === 'Auditor preset')![1]
    const allowed = PAIRS.filter(p => p.route === 'api/accounting/journal' && p.method !== 'GET' && web(auditor, p)).map(p => p.tool)
    expect(allowed.sort()).toEqual(['post_entry', 'withdraw_proposal'])
  })

  for (const [who, access] of PEOPLE) {
    it(`show the ${who} the same tools on MCP and the API`, () => {
      const onMcp = new Set(listableTools(access).map(t => t.name))
      // The API lists AGENT_TOOLS through the same rule (app/api/agent/route.ts GET). MCP adds its
      // own approval, dashboard and gateway tools, which the API has no twin for.
      const shared = AGENT_TOOLS.filter(t => MCP_TOOLS.some(m => m.name === t.name))
      const mismatched = shared.filter(t => onMcp.has(t.name) !== (isToolOffered(t) && toolListedFor(access, t))).map(t => t.name)
      expect(mismatched, who).toEqual([])
    })
  }
})
