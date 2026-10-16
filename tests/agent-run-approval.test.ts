import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * One approval per run (lib/agent/run-action.ts): a chat stages several writes as ONE pending
 * action, a person approves it once in the app, the steps run in order and stop at the first
 * failure, the expected checks are read from the books, and what the run created can be undone.
 * And the chat that staged a change cannot approve it.
 *
 * The routes, staging, the approval service, the checks and the undo are real; the database is in
 * memory, and the one ledger write (persistEntry) is a stand-in that books into it.
 */

let scopes = ['read', 'write']
let keyId = 'oauth:claude'
let access: AccessContext
let store: ReturnType<typeof memoryAdmin>
let serial = 0

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
vi.mock('@/lib/pending-actions/notify', () => ({ notifyAdminsOfStagedChange: async () => 0 }))
vi.mock('@/lib/accounting/chart-add', () => ({
  addChartAccount: async (_a: unknown, _f: string, _g: string, input: any) => {
    store.tables.chart_of_accounts.push({ id: `acct-${input.code}`, fund_id: 'fund-1', vehicle_id: 'v1', code: input.code, name: input.name, type: input.type })
    return { account: { code: input.code, name: input.name } }
  },
}))
vi.mock('@/lib/accounting/persist', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/persist')>()),
  // Books the entry into the in-memory ledger, so the checks read what the run did.
  persistEntry: async (_a: unknown, fundId: string, _g: string, _u: string | null, entry: any, status: string) => {
    const id = `entry-${++serial}`
    store.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v1', book: 'actual', status, entry_date: entry.entryDate, memo: entry.memo, source_type: 'manual', reversed_by: null, source_ref: null })
    for (const p of entry.postings) {
      store.tables.journal_postings.push({ journal_entry_id: id, fund_id: fundId, vehicle_id: 'v1', book: 'actual', account_id: p.accountId, amount: p.amount, currency: 'USD', lp_entity_id: null })
    }
    return { entryId: id }
  },
}))
vi.mock('@/lib/accounting/api-keys', async importOriginal => {
  const credential = (req: Request) =>
    req.headers.get('authorization') ? { fundId: 'fund-1', keyId, userId: 'user-me', role: access.role, scopes } : null
  return {
    ...(await importOriginal<typeof import('@/lib/accounting/api-keys')>()),
    resolveAgentAuth: async (_admin: unknown, req: Request) => credential(req),
    loadCredentialAccess: async () => access,
  }
})
// The app's Approvals page: a person signed in with a cookie, not a credential.
vi.mock('@/lib/pending-actions/browser-principal', () => ({
  resolveBrowserPrincipal: async () => ({ userId: 'user-me', fundId: 'fund-1', role: access.role, access, credentialKind: 'cookie' }),
}))

import { POST as mcpPost } from '@/app/api/mcp/route'
import { POST as webApprove } from '@/app/api/pending-actions/[id]/approve/route'
import { POST as webUndo } from '@/app/api/pending-actions/[id]/undo/route'
import { GET as webList } from '@/app/api/pending-actions/route'
import { selfApprovalRefused, stagedBySameCredential } from '@/lib/pending-actions/service'
import { parseChecks } from '@/lib/agent/run-checks'
import { schemaProblems } from '@/lib/agent/run-action'
import { AGENT_TOOLS } from '@/lib/accounting/agent-tools'

const member = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' = 'admin'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }))
  const result = (await res.json()).result
  const text = result?.content?.[0]?.text as string
  return { isError: !!result?.isError, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
async function approveInApp(id: string) {
  const res = await webApprove(new Request(`https://fund.test/api/pending-actions/${id}/approve`, { method: 'POST' }), params(id))
  return { status: res.status, body: await res.json() }
}
async function undoInApp(id: string) {
  const res = await webUndo(new Request(`https://fund.test/api/pending-actions/${id}/undo`, { method: 'POST' }), params(id))
  return { status: res.status, body: await res.json() }
}

const entry = (amount: number, debit = '1000', credit = '3000') => ({
  tool: 'post_entry',
  input: { entryDate: '2026-09-30', memo: 'fix', postings: [{ accountCode: debit, amount }, { accountCode: credit, amount: -amount }] },
})
const row = () => store.tables.pending_actions[0]

beforeEach(() => {
  scopes = ['read', 'write']
  keyId = 'oauth:claude'
  serial = 0
  access = member({ accounting: 'write' })
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'admin' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    chart_of_accounts: [
      { id: 'acct-1000', fund_id: 'fund-1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset' },
      { id: 'acct-3000', fund_id: 'fund-1', vehicle_id: 'v1', code: '3000', name: 'Partners capital', type: 'equity' },
    ],
    journal_entries: [],
    journal_postings: [],
    pending_actions: [],
    accounting_audit_events: [],
    api_idempotency_keys: [],
  })
})

describe('staging a run', () => {
  it('stages every step as ONE pending action, applying nothing, with the credential that staged it', async () => {
    const out = await callTool('stage_run', {
      title: 'Book Q3 capital', rationale: 'Two calls were never booked.',
      steps: [entry(100), entry(50)],
      expected: [{ kind: 'account_balance', account: '1000', equals: 150 }],
    })
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ staged: true, steps: 2, approveUrl: expect.stringMatching(/\/pending-actions$/) })
    // A chat asks its person here and approves on their yes.
    expect(out.json.next).toMatch(/ask them to approve it here/)
    expect(out.json.next).toContain(`approve_action with id "${out.json.pendingActionId}"`)
    expect(store.tables.pending_actions).toHaveLength(1)
    expect(row()).toMatchObject({ action_type: 'agent_run', status: 'pending', vehicle_id: 'v1', created_credential: 'oauth:claude', created_via: 'mcp' })
    // Each step's entity is pinned at staging, as a single staged call's is.
    expect(row().args.steps.map((s: any) => s.input.vehicle)).toEqual(['Fund I', 'Fund I'])
    expect(row().preview.details).toMatchObject({ title: 'Book Q3 capital', expected: ['Account 1000 balance is 150'] })
    expect(store.tables.journal_entries).toHaveLength(0)
  })

  it('refuses inputs that do not match a step’s schema, read tools, unknown tools and nested runs, all at once', async () => {
    const out = await callTool('stage_run', {
      title: 'Bad', rationale: 'x',
      steps: [
        { tool: 'post_entry', input: { memo: 'no date or postings' } },
        { tool: 'list_accounts', input: {} },
        { tool: 'no_such_tool', input: {} },
        { tool: 'stage_run', input: {} },
        { tool: 'approve_action', input: { id: 'x' } },
      ],
      expected: [{ kind: 'account_balance', account: '1000' }],
    })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/expected\[0\]\.equals must be a number/)
    expect(store.tables.pending_actions).toHaveLength(0)

    const steps = await callTool('stage_run', {
      title: 'Bad', rationale: 'x',
      steps: [
        { tool: 'post_entry', input: { memo: 'no date or postings' } },
        { tool: 'list_accounts', input: {} },
        { tool: 'no_such_tool', input: {} },
        { tool: 'stage_run', input: {} },
        { tool: 'approve_action', input: { id: 'x' } },
      ],
    })
    expect(steps.isError).toBe(true)
    expect(steps.text).toMatch(/steps\[0\] \(post_entry\): input must have required property 'entryDate'/)
    expect(steps.text).toMatch(/steps\[1\]: list_accounts only reads/)
    expect(steps.text).toMatch(/steps\[2\]: unknown tool "no_such_tool"/)
    expect(steps.text).toMatch(/steps\[3\]: stage_run cannot be a step/)
    expect(steps.text).toMatch(/steps\[4\]: approve_action cannot be a step/)
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('refuses a step its owner has no write grant for, as a direct call would be', async () => {
    access = member({ accounting: 'write' }, 'member')
    const out = await callTool('stage_run', {
      title: 'Mixed', rationale: 'x',
      steps: [entry(10), { tool: 'record_investment', input: { company: 'Acme', transaction_type: 'investment', transaction_date: '2026-09-30' } }],
    })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/steps\[1\] \(record_investment\): .*does not have write access/)
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('requires a title and a rationale', async () => {
    const out = await callTool('stage_run', { steps: [entry(10)] })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/title is required/)
    expect(out.text).toMatch(/rationale is required/)
  })
})

describe('approving a run', () => {
  it('can be approved by the chat that staged it, once its person says yes', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(false)
    expect(row().status).toBe('applied')
    expect(store.tables.journal_entries).toHaveLength(1)
  })

  it('runs every step in order from the app, then reads the expected checks', async () => {
    const staged = await callTool('stage_run', {
      title: 'Book Q3 capital', rationale: 'Two calls were never booked.',
      steps: [entry(100), { tool: 'add_account', input: { code: '1200', name: 'Investments', type: 'asset' } }, entry(40, '1200', '1000')],
      expected: [
        { kind: 'account_balance', account: '1000', equals: 60, label: 'Cash' },
        { kind: 'type_total', accountType: 'asset', equals: 100 },
        { kind: 'trial_balance' },
        { kind: 'account_balance', account: '1200', asOf: '2026-09-29', equals: 40 },
      ],
    })
    const out = await approveInApp(staged.json.pendingActionId)
    expect(out.status).toBe(200)
    expect(row().status).toBe('applied')
    const { run } = out.body.result
    expect(run.steps.map((s: any) => [s.step, s.tool, s.status])).toEqual([[1, 'post_entry', 'applied'], [2, 'add_account', 'applied'], [3, 'post_entry', 'applied']])
    expect(store.tables.journal_entries.map(e => e.id)).toEqual(['entry-1', 'entry-2'])
    expect(run.checks.map((c: any) => [c.actual, c.passed])).toEqual([[60, true], [100, true], ['balanced', true], [0, false]])
    expect(run.checksFailed).toBe(1)
    expect(run.stoppedAt).toBeNull()
    expect(run.undoable).toBe(true)
    expect(run.steps[1].notUndoable).toMatch(/add_account cannot be undone/)
    expect(store.tables.accounting_audit_events.map(e => e.action)).toEqual(['pending_action.stage', 'pending_action.approve'])
  })

  it('stops at the first failing step, records where, and runs nothing after it', async () => {
    const staged = await callTool('stage_run', {
      title: 'T', rationale: 'R',
      steps: [entry(100), entry(5, '9999'), entry(7)],
      expected: [{ kind: 'trial_balance' }],
    })
    const out = await approveInApp(staged.json.pendingActionId)
    expect(out.status).toBe(422)
    expect(out.body.error).toMatch(/Step 2 of 3 \(post_entry\) failed: Unknown account code 9999/)
    expect(out.body.error).toMatch(/The 1 step before it stay applied/)
    expect(row().status).toBe('failed')
    expect(row().applied_result.run).toMatchObject({ stoppedAt: 2, checks: [] })
    expect(row().applied_result.run.steps.map((s: any) => s.status)).toEqual(['applied', 'failed', 'skipped'])
    expect(store.tables.journal_entries).toHaveLength(1)
  })

  it('may be approved by a different credential, such as an admin’s own chat', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    keyId = 'oauth:another-chat'
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(false)
    expect(row().status).toBe('applied')
  })

  it('needs write in every step’s domain to approve', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    access = member({ accounting: 'read' }, 'member')
    const out = await approveInApp(staged.json.pendingActionId)
    expect(out.status).toBe(403)
    expect(store.tables.journal_entries).toHaveLength(0)
  })
})

describe('undoing a run', () => {
  it('voids the journal entries it created, and says what it cannot undo', async () => {
    const staged = await callTool('stage_run', {
      title: 'T', rationale: 'R',
      steps: [entry(100), { tool: 'add_account', input: { code: '1200', name: 'Investments', type: 'asset' } }, entry(40)],
    })
    await approveInApp(staged.json.pendingActionId)
    const out = await undoInApp(staged.json.pendingActionId)
    expect(out.status).toBe(200)
    expect(store.tables.journal_entries.map(e => [e.id, e.status])).toEqual([['entry-1', 'void'], ['entry-2', 'void']])
    const undo = out.body.action.appliedResult.undo
    expect(undo.status).toBe('done')
    // Last step first.
    expect(undo.outcomes.map((o: any) => [o.step, o.target.id, o.status])).toEqual([[3, 'entry-2', 'undone'], [1, 'entry-1', 'undone']])
    expect(store.tables.accounting_audit_events.map(e => e.action)).toEqual([
      'pending_action.stage', 'pending_action.approve', 'entry.void', 'entry.void', 'pending_action.undo',
    ])

    // Undoing again replays.
    const again = await undoInApp(staged.json.pendingActionId)
    expect(again.body.replayed).toBe(true)
  })

  it('undoes what a stopped run applied', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100), entry(5, '9999')] })
    await approveInApp(staged.json.pendingActionId)
    const out = await undoInApp(staged.json.pendingActionId)
    expect(out.status).toBe(200)
    expect(store.tables.journal_entries[0].status).toBe('void')
  })

  it('leaves an entry in a closed period alone and reports it, so the undo is partial', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    await approveInApp(staged.json.pendingActionId)
    store.tables.fiscal_periods = [{ fund_id: 'fund-1', vehicle_id: 'v1', status: 'closed', period_start: '2026-07-01', period_end: '2026-09-30' }]
    const out = await undoInApp(staged.json.pendingActionId)
    expect(out.body.action.appliedResult.undo).toMatchObject({ status: 'partial', outcomes: [expect.objectContaining({ status: 'refused', message: expect.stringMatching(/closed period/) })] })
    expect(store.tables.journal_entries[0].status).toBe('posted')
  })

  it('leaves voiding posted entries to an admin', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    await approveInApp(staged.json.pendingActionId)
    access = member({ accounting: 'write' }, 'member')
    const out = await undoInApp(staged.json.pendingActionId)
    expect(out.body.action.appliedResult.undo.outcomes[0]).toMatchObject({ status: 'refused', message: 'Only an admin can void a posted entry.' })
    expect(store.tables.journal_entries[0].status).toBe('posted')
  })

  it('lists decided runs for the Approvals page', async () => {
    const staged = await callTool('stage_run', { title: 'T', rationale: 'R', steps: [entry(100)] })
    await approveInApp(staged.json.pendingActionId)
    const res = await webList(new Request('https://fund.test/api/pending-actions?view=runs'))
    const body = await res.json()
    expect(body.runs).toEqual([expect.objectContaining({ id: staged.json.pendingActionId, status: 'applied', appliedResult: expect.objectContaining({ run: expect.any(Object) }) })])
  })
})

describe('self-approval of single staged changes', () => {
  it('lets the chat that staged the change approve it once its person says yes', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(staged.json.next).toMatch(/ask them to approve it here/)
    const approved = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(approved.json).toMatchObject({ applied: true })
    expect(row().status).toBe('applied')
  })

  it('still refuses a script key approving what it staged', () => {
    const key = { userId: 'u', credentialId: 'key_script' }
    const row = { created_by: 'u', created_via: 'api', created_credential: 'key_script' }
    expect(selfApprovalRefused(key, row)).toBe(true)
    expect(selfApprovalRefused({ userId: 'u', credentialId: 'oauth:c' }, { ...row, created_credential: 'oauth:c' })).toBe(false)
    expect(selfApprovalRefused({ userId: 'u' }, row)).toBe(false)
  })

  it('compares credential and person, falling back to the channel for older rows', () => {
    const chat = { userId: 'u', credentialId: 'oauth:c' }
    expect(stagedBySameCredential(chat, { created_by: 'u', created_via: 'mcp', created_credential: 'oauth:c' })).toBe(true)
    expect(stagedBySameCredential(chat, { created_by: 'u', created_via: 'mcp', created_credential: 'oauth:other' })).toBe(false)
    expect(stagedBySameCredential(chat, { created_by: 'someone-else', created_via: 'mcp', created_credential: 'oauth:c' })).toBe(false)
    expect(stagedBySameCredential(chat, { created_by: 'u', created_via: 'mcp', created_credential: null })).toBe(true)
    expect(stagedBySameCredential(chat, { created_by: 'u', created_via: 'analyst', created_credential: null })).toBe(false)
    // A person in the app carries no credential id.
    expect(stagedBySameCredential({ userId: 'u' }, { created_by: 'u', created_via: 'mcp', created_credential: 'oauth:c' })).toBe(false)
  })
})

describe('check format and step schemas', () => {
  it('parses the three kinds and refuses anything else', () => {
    const { checks, problems } = parseChecks([
      { kind: 'account_balance', account: '1000', equals: 5, asOf: '2026-09-30' },
      { kind: 'type_total', accountType: 'asset', equals: 0, tolerance: 1 },
      { kind: 'trial_balance', vehicle: 'Fund I' },
      { kind: 'sql', query: 'select 1' },
      { kind: 'type_total', accountType: 'cash', equals: 1 },
      { kind: 'account_balance', account: '1000', equals: 1, asOf: 'yesterday' },
    ])
    expect(checks).toHaveLength(4)
    expect(problems).toEqual([
      'expected[3].kind must be account_balance, type_total or trial_balance.',
      'expected[4].accountType must be one of asset, liability, equity, income, expense.',
      'expected[5].asOf must be an ISO date (YYYY-MM-DD).',
    ])
  })

  it('compiles every write tool’s schema, so any of them can be a step', () => {
    for (const tool of AGENT_TOOLS.filter(t => t.scope === 'write')) {
      expect(() => schemaProblems(tool.name, tool.inputSchema as Record<string, unknown>, {}), tool.name).not.toThrow()
    }
  })
})
