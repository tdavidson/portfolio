import { describe, it, expect } from 'vitest'
import { fetchAllRows, loadLedgerRowsBatch, assembleLoadedLedger } from './load'
import { loadPositionsBatch } from './lp-positions'

// Chainable fake: every method returns the same thenable resolving to the table's canned rows.
// Filters are no-ops — the batch loaders group by vehicle_id in memory, which is what's tested.
function fakeAdmin(tables: Record<string, any[]>): any {
  const makeQ = (table: string) => {
    const rows = tables[table] ?? []
    const q: any = {
      select: () => q, eq: () => q, in: () => q, lte: () => q, order: () => q, range: () => q,
      then: (resolve: (v: any) => any) => resolve({ data: rows, error: null }),
    }
    return q
  }
  return { from: (table: string) => makeQ(table) }
}

describe('loadLedgerRowsBatch', () => {
  it('groups chart/entries/postings by vehicle_id, with an empty bucket per requested vehicle', async () => {
    const admin = fakeAdmin({
      chart_of_accounts: [
        { id: 'a1', code: '3000', name: 'Cap', type: 'equity', lp_entity_id: 'e1', vehicle_id: 'v1' },
        { id: 'a2', code: '1000', name: 'Cash', type: 'asset', vehicle_id: 'v2' },
      ],
      journal_entries: [{ id: 'j1', source_type: 'contribution', status: 'posted', entry_date: '2024-01-01', vehicle_id: 'v1' }],
      journal_postings: [
        { journal_entry_id: 'j1', account_id: 'a1', amount: 100, vehicle_id: 'v1' },
        { journal_entry_id: 'jx', account_id: 'a2', amount: 5, vehicle_id: 'v2' },
      ],
    })
    const map = await loadLedgerRowsBatch(admin, 'fund-1', ['v1', 'v2', 'v3'])
    expect(map.get('v1')!.acctRows).toHaveLength(1)
    expect(map.get('v1')!.postingRows).toHaveLength(1)
    expect(map.get('v2')!.acctRows[0].id).toBe('a2')
    expect(map.get('v3')).toEqual({ acctRows: [], entryRows: [], postingRows: [] }) // requested but has nothing
  })

  it('returns an empty map for no vehicles (no query)', async () => {
    const map = await loadLedgerRowsBatch(fakeAdmin({}), 'fund-1', [])
    expect(map.size).toBe(0)
  })
})

describe('assembleLoadedLedger', () => {
  it('builds accounts, keeps only postings whose entry is present, and flags LP-capital-account postings', () => {
    const led = assembleLoadedLedger('fund-1', {
      acctRows: [
        { id: 'a1', code: '3000', name: 'Cap', type: 'equity', lp_entity_id: 'e1', company_id: null },
        { id: 'a2', code: '1000', name: 'Cash', type: 'asset', lp_entity_id: null, company_id: null },
      ],
      entryRows: [{ id: 'j1', source_type: 'contribution', entry_date: '2024-01-01', memo: null }],
      postingRows: [
        { journal_entry_id: 'j1', account_id: 'a1', amount: 100, currency: 'USD', lp_entity_id: 'e1' }, // capital
        { journal_entry_id: 'j1', account_id: 'a2', amount: -100, currency: 'USD', lp_entity_id: null }, // cash, not capital
        { journal_entry_id: 'jx', account_id: 'a1', amount: 999, currency: 'USD', lp_entity_id: 'e1' }, // orphan entry → dropped
      ],
    })
    expect(led.accounts).toHaveLength(2)
    expect(led.postings).toHaveLength(2) // orphan dropped
    expect(led.capitalPostings).toHaveLength(1)
    expect(led.capitalPostings[0]).toMatchObject({ lpEntityId: 'e1', amount: 100, sourceType: 'contribution' })
  })
})

describe('loadPositionsBatch', () => {
  it('groups positions by vehicle_id and coerces numeric columns', async () => {
    const admin = fakeAdmin({
      lp_positions: [
        { lp_entity_id: 'e1', as_of_date: '2024-06-30', commitment: '100', called_capital: '40', distributions: '0', nav: '45', irr: '0.1', vehicle_id: 'v1' },
        { lp_entity_id: 'e2', as_of_date: '2024-06-30', commitment: '50', called_capital: '50', distributions: null, nav: '55', irr: null, vehicle_id: 'v2' },
      ],
    })
    const map = await loadPositionsBatch(admin, 'fund-1', ['v1', 'v2'])
    expect(map.get('v1')).toHaveLength(1)
    expect(map.get('v1')![0]).toMatchObject({ lpEntityId: 'e1', commitment: 100, calledCapital: 40, nav: 45, irr: 0.1 })
    expect(map.get('v2')![0]).toMatchObject({ lpEntityId: 'e2', distributions: null, irr: null })
  })

  it('reads past PostgREST\'s 1000-row cap instead of truncating', async () => {
    // A fake that honours .range() and caps each response at 1000 rows, as PostgREST does.
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`, lp_entity_id: `e${i % 50}`, as_of_date: '2024-06-30',
      commitment: '100', called_capital: '100', distributions: '0', nav: null, irr: null, vehicle_id: i % 2 ? 'v1' : 'v2',
    }))
    let range: [number, number] = [0, rows.length - 1]
    const q: any = {
      select: () => q, eq: () => q, in: () => q, lte: () => q, order: () => q,
      range: (from: number, to: number) => { range = [from, to]; return q },
      then: (resolve: (v: any) => any) => resolve({ data: rows.slice(range[0], Math.min(range[1] + 1, range[0] + 1000)), error: null }),
    }
    const map = await loadPositionsBatch({ from: () => q } as any, 'fund-1', ['v1', 'v2'])
    expect(map.get('v1')).toHaveLength(1250)
    expect(map.get('v2')).toHaveLength(1250)
  })
})

describe('QuickBooks LP cash attribution', () => {
  it('classifies receipts, payments and calls against Due from LPs but keeps other non-cash capital adjustments separate', () => {
    const ledger = assembleLoadedLedger('fund', {
      acctRows: [
        { id: 'cash', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
        { id: 'capital', code: '3100-a', name: 'LP A', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'a' },
        { id: 'receivable', code: '1300', name: 'Receivable', type: 'asset', subtype: 'receivable' },
        { id: 'fee', code: '5000', name: 'Fees', type: 'expense', subtype: 'management_fee' },
      ],
      entryRows: ['receipt', 'payment', 'call', 'adjustment'].map(id => ({ id, source_type: 'quickbooks', entry_date: '2026-01-01' })),
      postingRows: [
        { journal_entry_id: 'receipt', account_id: 'cash', amount: 100 },
        { journal_entry_id: 'receipt', account_id: 'capital', amount: -100, lp_entity_id: 'a' },
        { journal_entry_id: 'payment', account_id: 'cash', amount: -20 },
        { journal_entry_id: 'payment', account_id: 'capital', amount: 20, lp_entity_id: 'a' },
        { journal_entry_id: 'call', account_id: 'receivable', amount: 500 },
        { journal_entry_id: 'call', account_id: 'capital', amount: -500, lp_entity_id: 'a' },
        { journal_entry_id: 'adjustment', account_id: 'fee', amount: 30 },
        { journal_entry_id: 'adjustment', account_id: 'capital', amount: -30, lp_entity_id: 'a' },
      ],
    })
    expect(ledger.capitalPostings.map(p => p.sourceType)).toEqual(['contribution', 'distribution', 'capital_call', 'quickbooks'])
    expect(ledger.sourcedPostings.every(p => p.sourceType === 'quickbooks')).toBe(true)
  })
})


it('refuses to report a truncated ledger when a later page fails', async () => {
  const make = async (from: number) => from === 0
    ? { data: [{ id: 'first' }], error: null }
    : { data: null, error: new Error('Read failed') }
  await expect(fetchAllRows(make, 1)).rejects.toThrow('Read failed')
})
