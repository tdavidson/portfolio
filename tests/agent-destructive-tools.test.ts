import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Each destructive tool's handler (lib/agent/destructive-tools.ts) against the lib function its web
 * route calls, and what its staged preview shows. Approval runs these handlers; staging and the
 * flag are tests/agent-destructive-actions.test.ts. The journal state change and the period reopen
 * are covered through their routes (tests/journal-owned-entries.test.ts); here only the wiring.
 */

const expired: string[] = []
vi.mock('@/lib/cache/tags', () => ({ expireTag: (t: string) => { expired.push(t) } }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
const retag = vi.fn(async () => {})
vi.mock('@/lib/vehicles', () => ({ retagPortfolioGroup: (...a: any[]) => (retag as any)(...a) }))
const changeEntryState = vi.fn(async (..._a: any[]): Promise<{ status: number; body: Record<string, unknown> }> => ({ status: 200, body: { ok: true, status: 'draft' } }))
vi.mock('@/lib/accounting/journal-state', () => ({ changeEntryState: (...a: any[]) => changeEntryState(...a) }))
const reopenThrough = vi.fn(async (..._a: any[]): Promise<any> => ({ ok: true, reopened: 2, voided: 3, issuedK1Years: [], reopenedPeriods: ['2026-02-01→2026-02-28', '2026-01-01→2026-01-31'] }))
vi.mock('@/lib/accounting/close', () => ({ reopenThrough: (...a: any[]) => reopenThrough(...a) }))

import { getTool } from '@/lib/accounting/agent-tools'
import { DESTRUCTIVE_PREVIEWS } from '@/lib/agent/destructive-tools'

const access: AccessContext = {
  fundId: 'fund-1', userId: 'me', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: {}, defaults: {},
}
let store: ReturnType<typeof memoryAdmin>
const ctx = (portfolioGroup = '') => ({ admin: store.admin, fundId: 'fund-1', portfolioGroup, userId: 'me', access })
const run = (name: string, input: Record<string, unknown>, group = '') => getTool(name)!.handler(ctx(group), input)
const preview = (name: string, input: Record<string, unknown>) =>
  DESTRUCTIVE_PREVIEWS[name]({ admin: store.admin, fundId: 'fund-1', userId: 'me', access }, input)

beforeEach(() => {
  expired.length = 0
  retag.mockClear()
  changeEntryState.mockClear()
  reopenThrough.mockClear()
  store = memoryAdmin({
    fund_vehicles: [
      { id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
      { id: 'v2', fund_id: 'fund-1', name: 'Acme SPV', active: true, kind: 'spv', aliases: ['Acme'] },
    ],
    fund_members: [
      { id: 'm-me', fund_id: 'fund-1', user_id: 'me', role: 'admin' },
      { id: 'm-other', fund_id: 'fund-1', user_id: 'u2', role: 'member' },
      { id: 'm-admin', fund_id: 'fund-1', user_id: 'u3', role: 'admin' },
    ],
    fund_member_vehicles: [{ fund_id: 'fund-1', user_id: 'u2', vehicle_id: 'v2' }],
    lp_entities: [
      { id: 'e1', fund_id: 'fund-1', investor_id: 'i1', entity_name: 'Alpha LP' },
      { id: 'e2', fund_id: 'fund-1', investor_id: 'i2', entity_name: 'Beta LP' },
    ],
    lp_investors: [{ id: 'i1', fund_id: 'fund-1', name: 'Alpha' }, { id: 'i2', fund_id: 'fund-1', name: 'Beta' }],
    commitment_events: [
      { id: 'c1', fund_id: 'fund-1', vehicle_id: 'v1', lp_entity_id: 'e1', effective_date: '2026-01-01', amount: 1000, kind: 'initial', transfer_id: null },
      { id: 'c2', fund_id: 'fund-1', vehicle_id: 'v1', lp_entity_id: 'e1', effective_date: '2026-03-01', amount: -250, kind: 'transfer_out', transfer_id: 't1', counterparty_entity_id: 'e2' },
      { id: 'c3', fund_id: 'fund-1', vehicle_id: 'v1', lp_entity_id: 'e2', effective_date: '2026-03-01', amount: 250, kind: 'transfer_in', transfer_id: 't1', counterparty_entity_id: 'e1' },
    ],
    lp_positions: [
      { id: 'p1', fund_id: 'fund-1', vehicle_id: 'v2', lp_entity_id: 'e1', as_of_date: '2026-03-31' },
      { id: 'p2', fund_id: 'fund-1', vehicle_id: 'v2', lp_entity_id: 'e2', as_of_date: '2026-03-31' },
      { id: 'p3', fund_id: 'fund-1', vehicle_id: 'v2', lp_entity_id: 'e1', as_of_date: '2026-06-30' },
    ],
    diligence_deals: [{ id: 'd1', fund_id: 'fund-1', name: 'Gamma', vehicle_id: null, deal_status: 'passed' }],
    diligence_documents: [{ id: 'dd1', fund_id: 'fund-1', deal_id: 'd1' }, { id: 'dd2', fund_id: 'fund-1', deal_id: 'd1' }],
    diligence_notes: [{ id: 'dn1', fund_id: 'fund-1', deal_id: 'd1' }],
    companies: [{ id: 'co1', fund_id: 'fund-1', name: 'Delta', holding_type: 'company', portfolio_group: ['Fund I'] }],
    company_notes: [{ id: 'n1', fund_id: 'fund-1', company_id: 'co1' }],
    investment_transactions: [],
    chart_of_accounts: [],
    company_documents: [],
    journal_entries: [{ id: 'je-acme', fund_id: 'fund-1', vehicle_id: 'v2', book: 'actual' }],
    journal_postings: [],
    capital_call_lines: [],
    accounting_audit_events: [],
  })
})

describe('lp_delete_commitment', () => {
  it('deletes both legs of a transfer, with the reason audited', async () => {
    const out = await run('lp_delete_commitment', { vehicle: 'Fund I', event_id: 'c3', reason: 'Entered twice' })
    expect(out).toMatchObject({ deleted: 'c3', legs: 2, vehicle: 'Fund I' })
    expect(store.tables.commitment_events.map(e => e.id)).toEqual(['c1'])
    expect(store.tables.accounting_audit_events[0]).toMatchObject({ action: 'commitment.delete', subject_id: 'c3', reason: 'Entered twice' })
  })

  it('needs a reason, as the route does', async () => {
    await expect(run('lp_delete_commitment', { vehicle: 'Fund I', event_id: 'c1' })).rejects.toThrow('A reason is required to delete a recorded commitment.')
    expect(store.tables.commitment_events).toHaveLength(3)
  })

  it('previews the event and the other leg', async () => {
    const p = await preview('lp_delete_commitment', { vehicle: 'Fund I', event_id: 'c2', reason: 'x' })
    expect(p.summary).toMatch(/Delete the transfer_out commitment event of -250\.00 for Alpha LP on 2026-03-01 \(Fund I\), and the other leg of its transfer with Beta LP/)
    expect(p.impact.legsDeleted).toBe(2)
  })
})

describe('lp_delete_entity and lp_merge_investors', () => {
  it('deletes an entity with no ledger activity', async () => {
    await run('lp_delete_entity', { lp: 'Beta LP' })
    expect(store.tables.lp_entities.map(e => e.id)).toEqual(['e1'])
  })

  it('moves every entity of one investor to another and deletes it', async () => {
    const p = await preview('lp_merge_investors', { from: 'Beta', into: 'Alpha' })
    expect(p.pin).toEqual({ from: 'i2', into: 'i1' })
    expect(p.summary).toBe('Merge LP investor Beta into Alpha: 1 entity moves (Beta LP), then Beta is deleted.')
    await run('lp_merge_investors', { from: 'i2', into: 'i1' })
    expect(store.tables.lp_investors.map(i => i.id)).toEqual(['i1'])
    expect(store.tables.lp_entities.every(e => e.investor_id === 'i1')).toBe(true)
  })

  it('refuses merging an investor into itself', async () => {
    await expect(run('lp_merge_investors', { from: 'Alpha', into: 'i1' })).rejects.toThrow('Cannot merge investor into itself')
  })
})

describe('delete_lp_positions', () => {
  it('deletes one dated set on the entity, nothing else', async () => {
    const p = await preview('delete_lp_positions', { vehicle: 'Acme SPV', as_of_date: '2026-03-31' })
    expect(p.summary).toBe('Delete the LP positions dated 2026-03-31 on Acme SPV: 2 LP rows.')
    await run('delete_lp_positions', { as_of_date: '2026-03-31' }, 'Acme SPV')
    expect(store.tables.lp_positions.map(p => p.id)).toEqual(['p3'])
  })

  it('refuses a malformed date', async () => {
    await expect(run('delete_lp_positions', { as_of_date: 'March' }, 'Acme SPV')).rejects.toThrow('asOfDate required')
  })
})

describe('diligence_delete_deal', () => {
  it('counts what the cascade takes, pins the deal, and deletes it', async () => {
    const p = await preview('diligence_delete_deal', { deal: 'Gamma' })
    expect(p.pin).toEqual({ deal: 'd1' })
    expect(p.summary).toMatch(/Delete diligence deal Gamma and everything in it: 2 documents, 1 notes/)
    await run('diligence_delete_deal', { deal: 'd1' })
    expect(store.tables.diligence_deals).toHaveLength(0)
  })
})

describe('remove_member', () => {
  it('removes a member and their entity grants', async () => {
    await run('remove_member', { member: 'm-other' })
    expect(store.tables.fund_members.map(m => m.id)).toEqual(['m-me', 'm-admin'])
    expect(store.tables.fund_member_vehicles).toHaveLength(0)
    expect(expired).toContain('membership')
  })

  it('refuses an admin and the person acting, as the route does', async () => {
    await expect(run('remove_member', { member: 'm-admin' })).rejects.toThrow('Cannot remove an admin')
    await expect(run('remove_member', { member: 'me' })).rejects.toThrow('You cannot remove yourself')
    expect(store.tables.fund_members).toHaveLength(3)
  })
})

describe('merge_vehicles', () => {
  it('warns that the source\'s own books go with it', async () => {
    const p = await preview('merge_vehicles', { from: 'Acme', into: 'Fund I' })
    expect(p.pin).toEqual({ from: 'v2', into: 'v1' })
    expect(p.summary).toMatch(/WARNING: Acme SPV's own books are deleted with it: 1 journal entry/)
  })

  it('moves grants, retags by name, deletes the source and keeps its name as an alias', async () => {
    const out = await run('merge_vehicles', { from: 'v2', into: 'Fund I' })
    expect(retag).toHaveBeenCalledWith(store.admin, 'fund-1', 'Acme SPV', 'Fund I')
    expect(store.tables.fund_vehicles.map(v => v.id)).toEqual(['v1'])
    expect(store.tables.fund_vehicles[0].aliases).toEqual(['Acme SPV', 'Acme'])
    expect(store.tables.fund_member_vehicles.map(g => g.vehicle_id).sort()).toEqual(['v1', 'v2'])
    expect(out).toMatchObject({ merged: { from: { id: 'v2' }, into: { id: 'v1' } } })
  })
})

describe('delete_company', () => {
  it('previews what goes, then deletes a company with no investment history', async () => {
    const p = await preview('delete_company', { company: 'co1' })
    expect(p.pin).toEqual({ company: 'co1' })
    expect(p.summary).toMatch(/Delete company Delta for every entity, with 0 document\(s\), 1 note\(s\)/)
    await run('delete_company', { company: 'co1' })
    expect(store.tables.companies).toHaveLength(0)
  })

  it('refuses while it has investment transactions', async () => {
    store.tables.investment_transactions.push({ id: 't1', fund_id: 'fund-1', company_id: 'co1' })
    expect((await preview('delete_company', { company: 'co1' })).summary).toMatch(/1 investment transaction\(s\), so the delete will be refused/)
    await expect(run('delete_company', { company: 'co1' })).rejects.toThrow("Delete this company's 1 investment transaction first")
    expect(store.tables.companies).toHaveLength(1)
  })
})

describe('the journal and period tools', () => {
  it('pass the entry, action and reason to the route\'s state change, as the acting admin', async () => {
    await run('unpost_entry', { entry_id: 'je1', reason: 'Wrong account' }, 'Fund I')
    expect(changeEntryState.mock.calls[0][1]).toMatchObject({ fundId: 'fund-1', role: 'admin', userId: 'me' })
    expect(changeEntryState.mock.calls[0].slice(2)).toEqual(['Fund I', 'v1', { id: 'je1', action: 'unpost', reason: 'Wrong account' }])

    await run('reverse_entry', { entry_id: 'je1', reverse_date: '2026-04-01', reason: 'r', post: true }, 'Fund I')
    expect(changeEntryState.mock.calls[1][4]).toEqual({ id: 'je1', action: 'reverse', reason: 'r', reverseDate: '2026-04-01', post: true })

    await run('void_entry', { entry_id: 'je1', reason: 'dup' }, 'Fund I')
    expect(changeEntryState.mock.calls[2][4]).toMatchObject({ action: 'void' })
  })

  it('void_entry refuses a draft, in the handler and the preview, and points to discard_drafts', async () => {
    store.tables.journal_entries.push(
      { id: 'je-draft', fund_id: 'fund-1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-03-31', memo: 'Dup' },
      { id: 'je-posted', fund_id: 'fund-1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-03-31', memo: 'Fee', source_ref: null },
    )
    await expect(run('void_entry', { entry_id: 'je-draft', reason: 'dup' }, 'Fund I')).rejects.toThrow(/discard_drafts/)
    await expect(preview('void_entry', { vehicle: 'Fund I', entry_id: 'je-draft', reason: 'dup' })).rejects.toThrow(/discard_drafts/)
    expect(changeEntryState).not.toHaveBeenCalled()

    // A posted entry goes through; unpost and reverse are unaffected.
    expect((await preview('void_entry', { vehicle: 'Fund I', entry_id: 'je-posted', reason: 'dup' })).summary).toMatch(/^Void journal entry 2026-03-31 "Fee" \(posted/)
    await run('void_entry', { entry_id: 'je-posted', reason: 'dup' }, 'Fund I')
    expect(changeEntryState).toHaveBeenCalledTimes(1)
  })

  it('turn a refusal into an error the assistant reads', async () => {
    changeEntryState.mockResolvedValueOnce({ status: 400, body: { error: 'That entry is in a closed period — reopen it first.' } })
    await expect(run('void_entry', { entry_id: 'je1', reason: 'dup' }, 'Fund I')).rejects.toThrow('That entry is in a closed period')
  })

  it('reopen_period needs a reason and audits the reopen', async () => {
    await expect(run('reopen_period', { from_date: '2026-01-01' }, 'Fund I')).rejects.toThrow('A reason is required to reopen a closed period.')
    const out = await run('reopen_period', { from_date: '2026-01-01', reason: 'Late invoice' }, 'Fund I')
    expect(out).toMatchObject({ vehicle: 'Fund I', reopened: 2, voided: 3 })
    expect(reopenThrough).toHaveBeenCalledWith(store.admin, 'fund-1', 'Fund I', { fromDate: '2026-01-01' })
    expect(store.tables.accounting_audit_events[0]).toMatchObject({ action: 'period.reopen', reason: 'Late invoice' })
  })
})
