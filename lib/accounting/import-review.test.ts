import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewImport } from './import-review'
import { loadPostedLedger } from './load'
import { loadPositions } from './lp-positions'

vi.mock('./load', () => ({ loadPostedLedger: vi.fn() }))
vi.mock('./lp-positions', () => ({ loadPositions: vi.fn() }))
const accounts = [
  { id: 'investment', fundId: 'firm', code: '1100-co', name: 'Acme', type: 'asset', subtype: 'investment', companyId: 'co' },
  { id: 'cash', fundId: 'firm', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'pooled', fundId: 'firm', code: '1100', name: 'Investments', type: 'asset', subtype: 'investment' },
  { id: 'capital', fundId: 'firm', code: '3100-lp', name: 'LP capital', type: 'equity', subtype: 'lp_capital', lpEntityId: 'lp' },
]
const position = { lpEntityId: 'lp', asOfDate: '2025-03-31', commitment: 200, calledCapital: 100, distributions: 0, nav: 120 }
function database() {
  const tables: Record<string, any[]> = {
    investment_transactions: [{ id: 't', company_id: 'co', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-03-01', investment_cost: 100 }],
    companies: [{ id: 'co', name: 'Acme', status: 'active', portfolio_group: ['Fund I'] }],
    lp_entities: [{ id: 'lp', entity_name: 'Investor A' }],
  }
  return { from: vi.fn((table: string) => {
    const q: any = { select: () => q, eq: (_key: string, value: string) => { expect(value).toBe('firm'); return q }, then: (resolve: any) => resolve({ data: tables[table] ?? [], error: null }) }
    // No insert/update/delete/upsert methods: an accidental preview write fails the test.
    return q
  }) } as any
}
beforeEach(() => {
  vi.mocked(loadPostedLedger).mockResolvedValue({ accounts, postings: [], capitalPostings: [] } as any)
  vi.mocked(loadPositions).mockResolvedValue([position])
})
describe('import comparison', () => {
  it('shows investment and LP differences before a journal is written', async () => {
    const result = await reviewImport(database(), 'firm', 'Fund I', { includeLp: true, entries: [{ fundId: 'firm', entryDate: '2025-03-31', sourceType: 'quickbooks', postings: [
      { accountId: 'investment', amount: 80, currency: 'USD' }, { accountId: 'capital', amount: -80, currency: 'USD', lpEntityId: 'lp' },
    ] }] })
    expect(result.differences).toContainEqual(expect.objectContaining({ domain: 'investment', metric: 'Investment cost', recorded: 180, imported: 80, difference: -100 }))
    expect(result.differences).toContainEqual(expect.objectContaining({ domain: 'lp', name: 'Investor A', recorded: 120, imported: 80, difference: -40 }))
    expect(result.token).toHaveLength(64)
  })
  it('identifies a possible duplicate investment cash movement without changing it', async () => {
    const result = await reviewImport(database(), 'firm', 'Fund I', { bankRows: [{ date: '2025-03-01', amount: -100, description: 'Acme wire' }] })
    expect(result.differences).toContainEqual(expect.objectContaining({ domain: 'investment', difference: 0, recorded: 100, imported: 100 }))
  })
  it('invalidates acknowledgement when either the import or existing records change', async () => {
    const input = { includeLp: true, entries: [{ fundId: 'firm', entryDate: '2025-03-31', postings: [{ accountId: 'capital', amount: -80, currency: 'USD' }] }] }
    const first = await reviewImport(database(), 'firm', 'Fund I', input)
    vi.mocked(loadPositions).mockResolvedValue([{ ...position, nav: 150 }])
    const corrected = await reviewImport(database(), 'firm', 'Fund I', input)
    expect(corrected.token).not.toBe(first.token)
  })
  it('does not read or expose LP positions without LP capital permission', async () => {
    vi.mocked(loadPositions).mockClear()
    const db = database()
    const result = await reviewImport(db, 'firm', 'Fund I', { bankRows: [{ date: '2025-03-01', amount: 100, description: 'Capital contribution' }] })
    expect(loadPositions).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalledWith('lp_entities')
    expect(result.checked.lpComparisonAvailable).toBe(false)
    expect(JSON.stringify(result)).not.toContain('Investor A')
  })
})

it('flags contribution and distribution differences even when ending capital agrees', async () => {
  const result = await reviewImport(database(), 'firm', 'Fund I', { includeLp: true, entries: [
    { fundId: 'firm', entryDate: '2025-03-01', sourceType: 'contribution', postings: [{ accountId: 'capital', amount: -150, currency: 'USD' }] },
    { fundId: 'firm', entryDate: '2025-03-31', sourceType: 'distribution', postings: [{ accountId: 'capital', amount: 30, currency: 'USD' }] },
  ] })
  expect(result.differences).toContainEqual(expect.objectContaining({ metric: 'Contributions', recorded: 100, imported: 150 }))
  expect(result.differences).toContainEqual(expect.objectContaining({ metric: 'Distributions', recorded: 0, imported: 30 }))
  expect(result.differences.some(d => d.metric === 'Capital balance')).toBe(false)
})

describe('adoption-aware comparison', () => {
  const noTracker = () => {
    const db = database()
    const from = db.from
    db.from = vi.fn((t: string) => t === 'investment_transactions' ? { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) } : from(t))
    return db
  }
  it('does not report cost the import will itself adopt into the tracker', async () => {
    const result = await reviewImport(noTracker(), 'firm', 'Fund I', { entries: [{ fundId: 'firm', entryDate: '2025-03-01', sourceType: 'quickbooks', postings: [
      { accountId: 'investment', amount: 1000, currency: 'USD' }, { accountId: 'cash', amount: -1000, currency: 'USD' },
    ] }] })
    expect(result.differences.filter(d => d.domain === 'investment')).toEqual([])
    expect(result.checked.investments).toBe(1)
  })
  it('lists an entry to the pooled investment account as a refusal', async () => {
    const result = await reviewImport(noTracker(), 'firm', 'Fund I', { entries: [{ fundId: 'firm', entryDate: '2025-03-01', sourceType: 'quickbooks', postings: [
      { accountId: 'pooled', amount: 1000, currency: 'USD' }, { accountId: 'cash', amount: -1000, currency: 'USD' },
    ] }] })
    expect(result.differences).toContainEqual(expect.objectContaining({ domain: 'investment', metric: 'Investment entry', message: expect.stringMatching(/pooled/) }))
  })
})
