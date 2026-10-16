import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from './helpers/memory-admin'

// The propose → approve life of a capital call (lib/accounting/proposed-calls.ts): a
// proposal writes nothing to the books and notifies nobody; only an admin approves; blockers refuse;
// warnings need acknowledging; approval issues the call through the Capital page's own path with
// the LIVE split. Publishing each LP's notice is the route's next step (proposed-call-publish.ts).

const issue = vi.hoisted(() => vi.fn())
const publish = vi.hoisted(() => vi.fn())
const owners = vi.hoisted(() => ({
  value: [
    { lpEntityId: 'a', commitment: 6_000_000 },
    { lpEntityId: 'b', commitment: 4_000_000 },
  ] as { lpEntityId: string; commitment: number }[],
}))

vi.mock('@/lib/accounting/load', () => ({
  loadOwnership: async () => owners.value,
  loadEntityNames: async () => new Map([['a', 'Alpha LP'], ['b', 'Beta LP']]),
}))
vi.mock('@/lib/accounting/capital-calls', () => ({
  lpCalledTotals: async () => new Map(),
  issueCapitalCall: issue,
}))
vi.mock('@/lib/accounting/call-extras', () => ({
  applyAdvancesToCall: async () => ({ applied: new Map() }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async (_a: any, _f: string, g: string) => (g === 'Fund II' ? 'v2' : null) }))
vi.mock('@/lib/accounting/notices', () => ({
  loadNoticeRegister: async () => ({ kind: 'capital_call', id: 'call-1', lines: [] }),
  publishNotices: publish,
}))
vi.mock('@/lib/accounting/notice-pdf', () => ({ generateNoticePdf: async () => Buffer.from('') }))
vi.mock('@/lib/vehicle-letterhead', () => ({
  documentLetterhead: async () => ({ name: 'Fund II', logo: null, address: '1 Main St' }),
}))

import { publishCallNotices } from '@/lib/accounting/proposed-call-publish'
import {
  approveProposedCall, proposeCapitalCall, discardProposedCall, getProposedCall, reviseProposedCall,
} from '@/lib/accounting/proposed-calls'

const ctx = { fundId: 'f1', group: 'Fund II', userId: 'u1' }
const goodRequest = {
  total: 1_000_000,
  purposes: [{ category: 'investment' as const, amount: 1_000_000, description: 'Series A in Acme' }],
  noticeDate: '2099-01-05',
  dueDate: '2099-01-20',
}

function db(noticeDays: number | null = 10) {
  return memoryAdmin({
    vehicle_accounting_settings: [{ fund_id: 'f1', vehicle_id: 'v2', wire_instructions: 'Bank: First\nAcct: 1', call_notice_days: noticeDays, call_notice_basis: 'calendar' }],
    funds: [{ id: 'f1', name: 'Fund II', address: '1 Main St' }],
    fund_settings: [{ fund_id: 'f1', currency: 'USD' }],
    proposed_capital_calls: [],
    capital_calls: [{ id: 'call-1', fund_id: 'f1' }],
    accounting_audit_events: [],
  })
}

beforeEach(() => {
  issue.mockReset().mockResolvedValue({ callId: 'call-1', entryId: 'e1' })
  publish.mockReset().mockResolvedValue({ published: [{ lpEntityId: 'a' }, { lpEntityId: 'b' }], errors: [] })
  owners.value = [{ lpEntityId: 'a', commitment: 6_000_000 }, { lpEntityId: 'b', commitment: 4_000_000 }]
})

describe('proposing a capital call', () => {
  it('saves a proposal with each LP share and touches neither the books nor any LP', async () => {
    const { admin, tables } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.status).toBe('proposed')
    expect(out.value.lines.map(l => [l.name, l.amount])).toEqual([['Alpha LP', 600_000], ['Beta LP', 400_000]])
    expect(out.value.approvable).toBe(true)
    expect(tables.proposed_capital_calls).toHaveLength(1)
    expect(issue).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(tables.accounting_audit_events.map(e => e.action)).toEqual(['proposed_call.create'])
  })

  it('keeps a proposal with gaps, listing them instead of filling them', async () => {
    const { admin } = db(null)
    const out = await proposeCapitalCall(admin, ctx, { total: 1_000_000, purposes: [] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.noticeDate).toBeNull()
    expect(out.value.dueDate).toBeNull()
    expect(out.value.missing.map(m => m.field)).toEqual(expect.arrayContaining(['purposes', 'notice_date', 'due_date', 'notice_period_days']))
    expect(out.value.approvable).toBe(false)
  })

  it('re-checks an open proposal against today\'s records when read', async () => {
    const { admin, tables } = db(null)
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    expect(out.value.missing.map(m => m.field)).toContain('notice_period_days')
    tables.vehicle_accounting_settings[0].call_notice_days = 30
    const again = await getProposedCall(admin, ctx, out.value.id)
    if (!again.ok) throw new Error(again.error)
    expect(again.value.missing.map(m => m.field)).not.toContain('notice_period_days')
    expect(again.value.flags.map(f => f.code)).toContain('due_inside_notice_period')
  })

  it('revises only the fields given', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, { ...goodRequest, dueDate: '2099-01-07' })
    if (!out.ok) throw new Error(out.error)
    expect(out.value.flags.map(f => f.code)).toContain('due_inside_notice_period')
    const revised = await reviseProposedCall(admin, ctx, out.value.id, { dueDate: '2099-01-20' })
    if (!revised.ok) throw new Error(revised.error)
    expect(revised.value.dueDate).toBe('2099-01-20')
    expect(revised.value.total).toBe(1_000_000)
    expect(revised.value.flags).toEqual([])
  })

  it('does not find a proposal from another vehicle', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    const other = await getProposedCall(admin, { ...ctx, group: 'Other Fund' }, out.value.id)
    expect(other.ok).toBe(false)
  })
})

describe('approving a capital call notice', () => {
  it('refuses anyone but an admin', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    const r = await approveProposedCall(admin, ctx, out.value.id, { role: 'member' })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(issue).not.toHaveBeenCalled()
  })

  it('refuses while something required is missing, saying what', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, { ...goodRequest, dueDate: null })
    if (!out.ok) throw new Error(out.error)
    const r = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin', acknowledge: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(422)
    expect((r.extra as any).missing.map((m: any) => m.field)).toEqual(['due_date'])
    expect(issue).not.toHaveBeenCalled()
  })

  it('requires warnings to be acknowledged, then issues', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, { ...goodRequest, dueDate: '2099-01-07' })
    if (!out.ok) throw new Error(out.error)
    const first = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin' })
    expect(first).toMatchObject({ ok: false, status: 422 })
    expect(issue).not.toHaveBeenCalled()
    const second = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin', acknowledge: true })
    expect(second.ok).toBe(true)
  })

  it('issues with the LIVE split under a key tied to the proposal, publishing nothing itself', async () => {
    const { admin, tables } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    // A commitment changed after proposing: approval must not issue the stale split.
    owners.value = [{ lpEntityId: 'a', commitment: 5_000_000 }, { lpEntityId: 'b', commitment: 5_000_000 }]
    const r = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin' })
    expect(r.ok).toBe(true)
    expect(issue).toHaveBeenCalledTimes(1)
    const [, , group, userId, input] = issue.mock.calls[0]
    expect(group).toBe('Fund II')
    expect(userId).toBe('u1')
    expect(input).toMatchObject({
      requestKey: `proposed-call:${out.value.id}`,
      callDate: '2099-01-05', dueDate: '2099-01-20', scope: 'fund_wide',
      lines: [{ lpEntityId: 'a', amount: 500_000 }, { lpEntityId: 'b', amount: 500_000 }],
    })
    expect(publish).not.toHaveBeenCalled()
    expect(r.ok && r.value).toMatchObject({ capitalCallId: 'call-1', issued: true })
    expect(tables.capital_calls[0].purposes).toEqual([expect.objectContaining({ category: 'investment', amount: 1_000_000 })])
    const row = tables.proposed_capital_calls[0]
    expect(row).toMatchObject({ status: 'approved', capital_call_id: 'call-1', approved_by: 'u1' })
    expect(tables.accounting_audit_events.map(e => e.action)).toEqual(
      expect.arrayContaining(['capital_call.issue', 'proposed_call.approve']),
    )
  })

  it('does not issue twice when approved again; it returns the same call', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    await approveProposedCall(admin, ctx, out.value.id, { role: 'admin' })
    const again = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin' })
    expect(issue).toHaveBeenCalledTimes(1)
    expect(again.ok && again.value).toMatchObject({ capitalCallId: 'call-1', issued: false })
  })

  it('publishes each LP\'s own notice for the issued call', async () => {
    const { admin } = db()
    const out = await publishCallNotices(admin, ctx, 'call-1')
    expect(out).toEqual({ published: 2, reused: 0, errors: [] })
    expect(publish).toHaveBeenCalledWith(admin, { fundId: 'f1', group: 'Fund II', userId: 'u1' }, expect.objectContaining({ id: 'call-1' }))
  })

  it('cannot approve a discarded proposal', async () => {
    const { admin } = db()
    const out = await proposeCapitalCall(admin, ctx, goodRequest)
    if (!out.ok) throw new Error(out.error)
    expect((await discardProposedCall(admin, ctx, out.value.id)).ok).toBe(true)
    const r = await approveProposedCall(admin, ctx, out.value.id, { role: 'admin' })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(issue).not.toHaveBeenCalled()
  })
})
