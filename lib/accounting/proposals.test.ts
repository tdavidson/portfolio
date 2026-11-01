import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `propose` level and proposed journal entries (lib/accounting/proposals.ts).
 *
 * A proposer reads everything read allows and puts journal entries forward as drafts for someone
 * with write to post or reject. These pin the three things that would quietly break it: the level
 * must never count as write, it must mean nothing outside accounting, and a proposer's call must
 * never be staged, because staging runs the call as the APPROVER and would post it outright.
 */

import { canWriteAnywhere, effectiveAccess, hasAccess, proposesOnly, type AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { authorizeToolUse, type ResolvedKey } from '@/lib/accounting/api-keys'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { getPreset } from '@/lib/access/presets'
import { isProposer } from './proposals'

const ctx = (grants: AccessContext['grants'] = {}, over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  // Accounting and LP capital are off by default; switch them on as a fund using them would.
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
  grants,
  defaults: {},
  ...over,
})

const key = (over: Partial<ResolvedKey> = {}): ResolvedKey => ({
  fundId: 'f1', keyId: 'oauth:client-1', userId: 'u1', role: 'member', scopes: ['read', 'write'], ...over,
})

describe('the propose level', () => {
  const proposer = ctx({ accounting: 'propose' })

  it('sits between read and write on accounting', () => {
    expect(effectiveAccess(proposer, 'accounting')).toBe('propose')
    expect(hasAccess(proposer, 'accounting', 'read')).toBe(true)
    expect(hasAccess(proposer, 'accounting', 'propose')).toBe(true)
    expect(hasAccess(proposer, 'accounting', 'write')).toBe(false)
    expect(proposesOnly(proposer, 'accounting')).toBe(true)
    expect(isProposer(proposer)).toBe(true)
  })

  it('is read, never more, on a domain without proposals', () => {
    const c = ctx({ portfolio: 'propose', gp_economics: 'propose' }, { features: { ...DEFAULT_FEATURE_VISIBILITY, gp_economics: 'everyone' } as FeatureVisibilityMap })
    expect(effectiveAccess(c, 'portfolio')).toBe('read')
    expect(effectiveAccess(c, 'gp_economics')).toBe('read')
  })

  it('implies reading partner capital, not proposing there', () => {
    expect(effectiveAccess(proposer, 'lp_capital')).toBe('read')
  })

  it('is not a proposer when they can write, or are an admin', () => {
    expect(isProposer(ctx({ accounting: 'write' }))).toBe(false)
    expect(isProposer(ctx({ accounting: 'propose' }, { role: 'admin' }))).toBe(false)
    expect(isProposer(ctx({ accounting: 'read' }))).toBe(false)
  })

  it('lets the read-only demo propose nothing', () => {
    expect(effectiveAccess(ctx({ accounting: 'propose' }, { role: 'viewer' }), 'accounting')).toBe('read')
  })

  it('is offered a write-scoped token, since a proposal travels as a write call', () => {
    expect(canWriteAnywhere(proposer)).toBe(true)
    expect(canWriteAnywhere(ctx({ accounting: 'read' }))).toBe(false)
  })

  it('is what the auditor and tax presets grant on the books', () => {
    expect(getPreset('auditor')!.grants.accounting).toBe('propose')
    expect(getPreset('tax')!.grants.accounting).toBe('propose')
  })
})

describe('proposals over MCP and the API', () => {
  const proposer = ctx({ accounting: 'propose' })
  const postEntry = getTool('post_entry')!
  const postDrafts = getTool('post_drafts')!

  it('marks post_entry, and only tools that make drafts, as proposable', () => {
    expect(postEntry.proposable).toBe(true)
    expect(postDrafts.proposable).toBeUndefined()
  })

  it('lets a proposer call post_entry and nothing else that writes the books', () => {
    expect(authorizeToolUse('write', key(), proposer, 'accounting', 'accounting', true)).toBeNull()
    expect(authorizeToolUse('write', key(), proposer, 'accounting', 'accounting', false)).toMatch(/write access/)
    expect(authorizeToolUse('write', key(), ctx({ accounting: 'read' }), 'accounting', 'accounting', true)).toMatch(/write access/)
  })

  it('still holds a read-only credential to reading', () => {
    expect(authorizeToolUse('write', key({ scopes: ['read'] }), proposer, 'accounting', 'accounting', true)).toBe('This credential is read-only.')
  })

  it('runs a proposer\'s post_entry at once from a chat, rather than staging it for an approver to run as themselves', () => {
    expect(shouldStage(postEntry, {}, key(), proposer)).toBe(false)
    // Everyone else's chat writes still stage, as before.
    expect(shouldStage(postEntry, {}, key(), ctx({ accounting: 'write' }))).toBe(true)
    expect(shouldStage(postEntry, {}, key())).toBe(true)
  })
})

describe('the journal route and migration', () => {
  const root = join(__dirname, '..', '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  it('forces a proposer\'s entry to a draft and marks it, and holds edits and withdrawals to their own drafts', () => {
    const route = read('app/api/accounting/journal/route.ts')
    expect(route).toContain("const finalStatus = !proposing && status === 'posted' ? 'posted' : 'draft'")
    expect(route).toContain('markProposed(')
    expect(route.match(/proposerChangeProblem\(/g)?.length).toBe(2)
    expect(route).toContain("if (body?.action !== 'void') return NextResponse.json({ error: PROPOSER_REFUSAL }")
  })

  it('ranks propose with read in SQL, so no Data API policy treats it as write', () => {
    const sql = read('supabase/migrations/20261031190000_propose_access_level.sql')
    expect(sql).toContain("when 'write' then 2 when 'propose' then 1 when 'read' then 1 else 0")
    expect(sql).toContain("check (level in ('none', 'read', 'propose', 'write'))")
  })
})
