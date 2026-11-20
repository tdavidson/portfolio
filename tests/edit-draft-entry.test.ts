import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

// edit_draft_entry and PUT /api/accounting/journal run the same function (lib/accounting/
// journal-edit.ts). These drive both doors against one in-memory fund and require the same
// answers, plus the tool's own parts: accounts by code, partners per line, memo kept when omitted.

const s = vi.hoisted(() => ({ m: null as any, proposer: false, closed: false }))
const OWN_ACCOUNTS = new Set(['cash', 'fees', 'cap-a'])
const OWN_PARTNERS = new Set(['lp-1', 'lp-2'])

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: s.proposer ? 'member' : 'admin' }) }))
vi.mock('@/lib/access/request-context', () => ({ loadGateAccess: async () => (s.proposer ? person({ accounting: 'propose' }) : person({}, 'admin')) }))
vi.mock('@/lib/accounting/investment-access', async (orig) => ({ ...(await orig<any>()), loadMayTouchInvestments: async () => true }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/currency', () => ({ fundCurrency: async () => 'USD' }))
vi.mock('@/lib/accounting/periods', async (orig) => ({ ...(await orig<any>()), closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => s.closed }))
vi.mock('@/lib/accounting/persist', async (orig) => ({
  ...(await orig<any>()),
  accountIdByCode: async () => new Map([['1000', 'cash'], ['6000', 'fees'], ['3100', 'cap-a']]),
  // The real check reads the entity's chart and partners; this keeps its contract: a message for a
  // foreign account or partner, null otherwise.
  validatePostings: async (_a: any, _f: string, _v: string, group: string, postings: { accountId: string; lpEntityId?: string | null }[]) => {
    const foreign = postings.filter(p => !OWN_ACCOUNTS.has(p.accountId)).map(p => p.accountId)
    if (foreign.length) return `Posting to an account that doesn't belong to ${group}: ${foreign.join(', ')}`
    const strangers = postings.filter(p => p.lpEntityId && !OWN_PARTNERS.has(p.lpEntityId)).map(p => p.lpEntityId)
    if (strangers.length) return `Partner not in ${group}: ${strangers.join(', ')}`
    return null
  },
}))

import { PUT } from '@/app/api/accounting/journal/route'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'

const ALL_ON = Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap
function person(grants: Record<string, string>, role: AccessContext['role'] = 'member'): AccessContext {
  return { fundId: 'f', userId: 'u', role, features: ALL_ON, grants: grants as any, defaults: {}, vehicles: { all: true, ids: [] } }
}

beforeEach(() => {
  s.proposer = false
  s.closed = false
  s.m = memoryAdmin({
    journal_entries: [
      { id: 'd1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-03-31', memo: 'Quarterly fee', reference: 'INV-1', source_type: 'manual', source_ref: null, proposed_by: null },
      { id: 'p1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-31', memo: 'Posted', reference: null, source_type: 'manual', source_ref: null, proposed_by: null },
    ],
    journal_postings: [
      { id: 'jp1', journal_entry_id: 'd1', book: 'actual', fund_id: 'f', account_id: 'fees', amount: 100, currency: 'USD', lp_entity_id: null },
      { id: 'jp2', journal_entry_id: 'd1', book: 'actual', fund_id: 'f', account_id: 'cash', amount: -100, currency: 'USD', lp_entity_id: null },
    ],
    investment_transactions: [], bank_transactions: [], fund_capital_events: [], fund_nav_statements: [], vendors: [],
  })
})

const tool = () => getTool('edit_draft_entry')!
const runTool = (input: Record<string, unknown>) => tool().handler(
  { admin: s.m.admin, fundId: 'f', portfolioGroup: 'Fund I', userId: 'u', access: s.proposer ? person({ accounting: 'propose' }) : person({}, 'admin') } as any,
  input,
)
const put = (body: Record<string, unknown>) => PUT(new NextRequest('http://localhost/api/accounting/journal', { method: 'PUT', body: JSON.stringify({ group: 'Fund I', ...body }) }))
const linesOf = (id: string) => s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === id).map((p: any) => ({ account: p.account_id, amount: Number(p.amount), partner: p.lp_entity_id ?? null }))
const entry = (id: string) => s.m.tables.journal_entries.find((e: any) => e.id === id)

describe('edit_draft_entry', () => {
  it('replaces the lines, setting each line\'s partner, and keeps the memo and reference it was not given', async () => {
    const out: any = await runTool({
      entry_id: 'd1',
      postings: [
        { accountCode: '3100', amount: 60, lpEntityId: 'lp-1' },
        { accountCode: '3100', amount: 40, lpEntityId: 'lp-2' },
        { accountCode: '1000', amount: -100 },
      ],
    })
    expect(linesOf('d1')).toEqual([
      { account: 'cap-a', amount: 60, partner: 'lp-1' },
      { account: 'cap-a', amount: 40, partner: 'lp-2' },
      { account: 'cash', amount: -100, partner: null },
    ])
    expect(entry('d1')).toMatchObject({ status: 'draft', memo: 'Quarterly fee', reference: 'INV-1', source_type: 'manual' })
    expect(out).toMatchObject({ entryId: 'd1', status: 'draft' })
    expect(out.postings).toHaveLength(3)
    expect(out.next).toMatch(/post_drafts/)
  })

  it('takes account ids as list_journal returns them, and a new date and memo; null clears the reference', async () => {
    await runTool({ entry_id: 'd1', entryDate: '2026-04-15', memo: 'Fee, corrected', reference: null, postings: [{ accountId: 'fees', amount: 75 }, { accountId: 'cash', amount: -75 }] })
    expect(entry('d1')).toMatchObject({ entry_date: '2026-04-15', memo: 'Fee, corrected', reference: null })
    expect(linesOf('d1')).toEqual([{ account: 'fees', amount: 75, partner: null }, { account: 'cash', amount: -75, partner: null }])
  })

  it('refuses an unknown account code, a line with no account, and an empty entry before touching anything', async () => {
    await expect(runTool({ entry_id: 'd1', postings: [{ accountCode: '9999', amount: 1 }, { accountCode: '1000', amount: -1 }] })).rejects.toThrow(/Unknown account code 9999/)
    await expect(runTool({ entry_id: 'd1', postings: [{ amount: 1 }] })).rejects.toThrow(/accountCode or accountId/)
    await expect(runTool({ entry_id: 'd1', postings: [] })).rejects.toThrow(/every line/)
    expect(linesOf('d1')).toHaveLength(2)
  })

  it('is draft-only: a chat runs it at once, since posting it is post_drafts, which stages', () => {
    expect(shouldStage(tool(), { entry_id: 'd1', postings: [] }, { keyId: 'oauth:chat' }, person({ accounting: 'write' }))).toBe(false)
    expect(tool().proposable).toBe(true)
  })
})

describe('the tool and the entry form refuse the same edits', () => {
  const cases: [what: string, toolInput: Record<string, unknown>, routeBody: Record<string, unknown>, message: RegExp, status: number][] = [
    ['a posted entry', { entry_id: 'p1', postings: [{ accountId: 'fees', amount: 1 }, { accountId: 'cash', amount: -1 }] }, { id: 'p1', postings: [{ accountId: 'fees', amount: 1 }, { accountId: 'cash', amount: -1 }] }, /Only draft entries can be edited/, 400],
    ['lines that do not balance', { entry_id: 'd1', postings: [{ accountId: 'fees', amount: 10 }, { accountId: 'cash', amount: -9 }] }, { id: 'd1', postings: [{ accountId: 'fees', amount: 10 }, { accountId: 'cash', amount: -9 }] }, /balance|sum/i, 400],
    ['another entity\'s account', { entry_id: 'd1', postings: [{ accountId: 'elsewhere', amount: 1 }, { accountId: 'cash', amount: -1 }] }, { id: 'd1', postings: [{ accountId: 'elsewhere', amount: 1 }, { accountId: 'cash', amount: -1 }] }, /doesn't belong to Fund I/, 400],
    ['another entity\'s partner', { entry_id: 'd1', postings: [{ accountId: 'cap-a', amount: 1, lpEntityId: 'lp-x' }, { accountId: 'cash', amount: -1 }] }, { id: 'd1', postings: [{ accountId: 'cap-a', amount: 1, lpEntityId: 'lp-x' }, { accountId: 'cash', amount: -1 }] }, /Partner not in Fund I/, 400],
    ['an entry that is not there', { entry_id: 'nope', postings: [{ accountId: 'fees', amount: 1 }, { accountId: 'cash', amount: -1 }] }, { id: 'nope', postings: [{ accountId: 'fees', amount: 1 }, { accountId: 'cash', amount: -1 }] }, /Entry not found/, 404],
  ]
  for (const [what, toolInput, routeBody, message, status] of cases) {
    it(what, async () => {
      const res = await put(routeBody)
      expect(res.status).toBe(status)
      expect((await res.json()).error).toMatch(message)
      await expect(runTool(toolInput)).rejects.toThrow(message)
      expect(linesOf('d1')).toHaveLength(2)
    })
  }

  it('a closed period', async () => {
    s.closed = true
    const body = { postings: [{ accountId: 'fees', amount: 1 }, { accountId: 'cash', amount: -1 }] }
    expect((await (await put({ id: 'd1', ...body })).json()).error).toMatch(/closed period/)
    await expect(runTool({ entry_id: 'd1', ...body })).rejects.toThrow(/closed period/)
  })

  it('a proposer\'s edit of a draft they did not propose, while their own proposal goes through on both', async () => {
    s.proposer = true
    const body = { postings: [{ accountId: 'fees', amount: 5 }, { accountId: 'cash', amount: -5 }] }
    const res = await put({ id: 'd1', ...body })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/only your own proposals/)
    await expect(runTool({ entry_id: 'd1', ...body })).rejects.toThrow(/only your own proposals/)

    entry('d1').proposed_by = 'u'
    expect((await put({ id: 'd1', memo: 'Mine', ...body })).status).toBe(200)
    // journal_postings.book defaults to 'actual' in the database; the in-memory store has no defaults.
    s.m.tables.journal_postings.forEach((p: any) => { p.book ??= 'actual' })
    await runTool({ entry_id: 'd1', postings: [{ accountId: 'fees', amount: 7 }, { accountId: 'cash', amount: -7 }] })
    expect(entry('d1').memo).toBe('Mine')
    expect(linesOf('d1')).toEqual([{ account: 'fees', amount: 7, partner: null }, { account: 'cash', amount: -7, partner: null }])
  })

  it('leaves the entry form as it was: a memo it does not send is cleared, as the form always sends one', async () => {
    const res = await put({ id: 'd1', postings: [{ accountId: 'fees', amount: 100 }, { accountId: 'cash', amount: -100 }] })
    expect(res.status).toBe(200)
    expect(entry('d1')).toMatchObject({ memo: null, reference: null })
  })
})
