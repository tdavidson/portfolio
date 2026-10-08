import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vehicleStatus } from './status'
import { loadPostedLedger, loadOwnership } from './load'
import { vehicleKindByName } from './vehicle-domain'
import { loadAllocationBasis } from './terms'
import { loadStrandedCapital } from './pooled-capital-check'
import { intercompanyBalances } from './intercompany'
import { chartForVehicleKind } from './chart'
import { backfillDerivedEntries } from './investment-backfill'

vi.mock('./load', () => ({ loadPostedLedger: vi.fn(), loadOwnership: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn().mockResolvedValue('vehicle-1') }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn() }))
vi.mock('./lp-positions', () => ({ loadPositions: vi.fn().mockResolvedValue([]) }))
vi.mock('./terms', () => ({ loadHistoryMode: vi.fn(), loadAllocationBasis: vi.fn() }))
vi.mock('./close', () => ({ nextCloseStart: vi.fn().mockResolvedValue('2026-01-01') }))
vi.mock('./pooled-capital-check', () => ({ loadStrandedCapital: vi.fn() }))
vi.mock('./intercompany', () => ({ intercompanyBalances: vi.fn() }))
vi.mock('./investment-backfill', () => ({ backfillDerivedEntries: vi.fn(async () => ({ toAdopt: 0, toDerive: 0, toPost: 0 })) }))

function adminWith(tables: Record<string, unknown[]> = {}) {
  return { from: vi.fn((table: string) => {
    const q: any = { then: (resolve: any) => resolve({ data: tables[table] ?? [], error: null }) }
    for (const method of ['select', 'eq', 'neq', 'order', 'limit']) q[method] = () => q
    return q
  }) } as any
}
const accounts = () => chartForVehicleKind('manco').map(a => ({ ...a, id: a.code, fundId: 'firm' }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(vehicleKindByName).mockResolvedValue('manco')
  vi.mocked(loadPostedLedger).mockResolvedValue({ accounts: accounts(), postings: [], capitalPostings: [] } as any)
  vi.mocked(intercompanyBalances).mockResolvedValue([])
  vi.mocked(loadOwnership).mockResolvedValue([])
  vi.mocked(loadAllocationBasis).mockResolvedValue('capital_balance')
  vi.mocked(loadStrandedCapital).mockResolvedValue({ pooledPostings: 0, pooledAmount: 0, taggedPostings: 0, perLpAccounts: 0, stranded: false, message: null })
})

describe('management company accounting status', () => {
  it('shows management-company book health without requiring LPs or entries', async () => {
    const admin = adminWith()
    const s = await vehicleStatus(admin, 'firm', 'Management LLC')
    expect(s.setup.hasPostedEntries).toBe(false)
    expect(s.issues.map(i => i.title)).toEqual(['No posted entries yet'])
    expect(loadOwnership).not.toHaveBeenCalled()
    expect(loadStrandedCapital).not.toHaveBeenCalled()
    expect(admin.from).not.toHaveBeenCalledWith('investment_transactions')
  })

  it('keeps setup available when an existing chart lacks operating accounts', async () => {
    vi.mocked(loadPostedLedger).mockResolvedValue({ accounts: accounts().slice(0, 2), postings: [], capitalPostings: [] } as any)
    const s = await vehicleStatus(adminWith(), 'firm', 'Management LLC')
    expect(s.issues.map(i => i.title)).not.toContain('No accounting records yet')
  })

  it('reports draft entries, bank work, close progress, and net income going to members’ capital', async () => {
    const income = accounts().find(a => a.type === 'income')!
    const cash = accounts().find(a => a.subtype === 'cash')!
    vi.mocked(loadPostedLedger).mockResolvedValue({ accounts: accounts(), capitalPostings: [], postings: [
      { accountId: cash.id, amount: 100, currency: 'USD', entryDate: '2026-01-01' },
      { accountId: income.id, amount: -100, currency: 'USD', entryDate: '2026-01-01' },
    ] } as any)
    const s = await vehicleStatus(adminWith({
      journal_entries: [{ status: 'posted' }, { status: 'draft' }],
      bank_transactions: [{ status: 'unmatched' }, { status: 'drafted' }, { status: 'reconciled' }],
      fiscal_periods: [{ period_end: '2025-12-31', label: '2025' }],
    }), 'firm', 'Management LLC')
    expect(s.ledger).toMatchObject({ postedCount: 1, draftCount: 1, trialBalanced: true })
    expect(s.bank).toEqual({ total: 3, needsAttention: 2 })
    expect(s.close).toMatchObject({ lastClosedEnd: '2025-12-31', nextStart: '2026-01-01', unallocatedEarnings: 100 })
    expect(s.issues).toContainEqual(expect.objectContaining({ title: '100.00 of net income not yet closed to equity', detail: expect.stringContaining("members' capital") }))
    expect(s.issues.some(i => /partner|LP|NAV/.test(i.title + i.detail))).toBe(false)
  })

  it('flags receivables and payables even when they net to zero', async () => {
    vi.mocked(intercompanyBalances).mockResolvedValue([{ counterpartyVehicleId: 'fund', counterpartyName: 'Fund I', dueFrom: 500, dueTo: 500, net: 0 }])
    const s = await vehicleStatus(adminWith(), 'firm', 'Management LLC')
    expect(s.issues).toContainEqual(expect.objectContaining({ title: '1 outstanding intercompany balance', href: '/funds/status#intercompany' }))
  })

  it('says how many investment items are not on the ledger', async () => {
    vi.mocked(vehicleKindByName).mockResolvedValue('fund')
    vi.mocked(backfillDerivedEntries).mockResolvedValueOnce({ toAdopt: 1, toDerive: 2, toPost: 0 } as any)
    const s = await vehicleStatus(adminWith(), 'firm', 'Fund I')
    expect(s.issues).toContainEqual(expect.objectContaining({ title: '3 investment items not on the ledger', level: 'blocker', href: '/funds/status#book-investments' }))
  })

  it('still renders when the ledger backlog check fails', async () => {
    vi.mocked(vehicleKindByName).mockResolvedValue('fund')
    vi.mocked(backfillDerivedEntries).mockRejectedValueOnce(new Error('db down'))
    const s = await vehicleStatus(adminWith(), 'firm', 'Fund I')
    expect(s.issues).toContainEqual(expect.objectContaining({ level: 'info', title: 'Could not check which investment items are not on the ledger: db down' }))
    expect(s.issues.map(i => i.title)).toContain('No partners yet')
  })

  it('keeps the existing LP setup requirements for funds', async () => {
    vi.mocked(vehicleKindByName).mockResolvedValue('fund')
    const s = await vehicleStatus(adminWith(), 'firm', 'Fund I')
    expect(s.issues.map(i => i.title)).not.toContain('Onboarding path not chosen')
    expect(s.issues.map(i => i.title)).toContain('No partners yet')
    expect(intercompanyBalances).not.toHaveBeenCalled()
  })
})
