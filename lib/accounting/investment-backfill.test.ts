import { describe, it, expect, vi, beforeEach } from 'vitest'
import { backfillDerivedEntries } from './investment-backfill'
import { draftEntryForTransaction } from './from-portfolio'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1') }))
vi.mock('./persist', () => ({ accountIdByCode: vi.fn(async () => new Map([['1000', 'cash']])) }))
vi.mock('./continuous-allocation', () => ({
  postExistingEntryWithAllocation: vi.fn(async (_a, _f, _g, _u, id) =>
    id === 'old-refused' ? { error: 'No partner participates.' } : { allocationEntryIds: [] }),
}))
vi.mock('./from-portfolio', async (orig) => ({
  ...(await orig<typeof import('./from-portfolio')>()),
  draftEntryForTransaction: vi.fn(async (_a, _f, _u, txn) =>
    txn.transaction_type === 'unrealized_gain_change'
      ? (txn.transaction_date < '2026-01-01'
          ? { drafted: false, reason: 'Period closed through 2025-12-31.' }
          : { drafted: true, posted: true, entryId: `e-${txn.id}` })
      : { drafted: true, posted: false, entryId: `e-${txn.id}` }),
}))

type Row = Record<string, any>
/** Answers selects by table, honouring eq / in / like / neq / not-null; records nothing else. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = []
    let orderKey: string | null = null
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { preds.push(r => r[k] === v); return chain },
      neq: (k: string, v: any) => { preds.push(r => r[k] !== v); return chain },
      in: (k: string, v: any[]) => { preds.push(r => v.includes(r[k])); return chain },
      like: (k: string, v: string) => { preds.push(r => String(r[k] ?? '').startsWith(v.replace(/%$/, ''))); return chain },
      not: (k: string, _op: string, _v: null) => { preds.push(r => r[k] != null); return chain },
      order: (k: string) => { orderKey ??= k; return chain },
      range: () => chain,
      then: (res: any) => {
        let rows = (tables[table] ?? []).filter(r => preds.every(p => p(r)))
        if (orderKey) rows = [...rows].sort((a, b) => String(a[orderKey!]).localeCompare(String(b[orderKey!])))
        return res({ data: rows, error: null })
      },
    }
    return chain
  }
  return { from } as any
}

const txn = (id: string, company_id: string, transaction_type: string, transaction_date: string) =>
  ({ id, fund_id: 'f1', portfolio_group: 'Fund I', company_id, transaction_type, transaction_date, investment_cost: 1000, unrealized_value_change: 250 })

function world(extra: Partial<Record<string, Row[]>> = {}) {
  return fakeAdmin({
    investment_transactions: [
      txn('t3', 'acme', 'unrealized_gain_change', '2026-06-30'),
      txn('t1', 'acme', 'investment', '2025-03-01'),
      txn('t2', 'acme', 'unrealized_gain_change', '2025-09-30'),
      txn('t4', 'beta', 'investment', '2026-02-01'),
    ],
    companies: [{ id: 'acme', fund_id: 'f1', name: 'Acme' }, { id: 'beta', fund_id: 'f1', name: 'Beta' }],
    journal_entries: [],
    chart_of_accounts: [],
    journal_postings: [],
    ...extra,
  })
}

describe('backfillDerivedEntries', () => {
  beforeEach(() => { vi.mocked(draftEntryForTransaction).mockClear() })

  it('derives every transaction in date order, posting marks and drafting purchases', async () => {
    const r = await backfillDerivedEntries(world(), 'f1', 'Fund I', 'u1')
    expect(vi.mocked(draftEntryForTransaction).mock.calls.map(c => c[3].id)).toEqual(['t1', 't2', 't4', 't3'])
    expect(r).toMatchObject({ posted: 1, awaitingBankMatch: 2, alreadyDerived: 0 })
  })

  it('reports a mark a closed period refuses, by name — never skipped silently', async () => {
    const r = await backfillDerivedEntries(world(), 'f1', 'Fund I', 'u1')
    expect(r.refused).toEqual(['Acme, 2025-09-30: Period closed through 2025-12-31.'])
  })

  it('is idempotent on source_ref: a transaction that already derived an entry is left alone', async () => {
    const r = await backfillDerivedEntries(world({
      journal_entries: [{ id: 'x', fund_id: 'f1', vehicle_id: 'veh-1', book: 'actual', status: 'posted', source_ref: 'txn:t3' }],
    }), 'f1', 'Fund I', 'u1')
    expect(vi.mocked(draftEntryForTransaction).mock.calls.map(c => c[3].id)).not.toContain('t3')
    expect(r.alreadyDerived).toBe(1)
  })

  it('re-derives a transaction whose only entries were voided', async () => {
    await backfillDerivedEntries(world({
      journal_entries: [{ id: 'x', fund_id: 'f1', vehicle_id: 'veh-1', book: 'actual', status: 'void', source_ref: 'txn:t3' }],
    }), 'f1', 'Fund I', 'u1')
    expect(vi.mocked(draftEntryForTransaction).mock.calls.map(c => c[3].id)).toContain('t3')
  })

  it('leaves alone a company the ledger already carries by another route, and says which', async () => {
    // A snapshot, a history replay or a QuickBooks import already put Acme on the books.
    // Deriving its transactions too would book the position twice.
    const r = await backfillDerivedEntries(world({
      chart_of_accounts: [{ id: 'acc-acme', fund_id: 'f1', vehicle_id: 'veh-1', company_id: 'acme' }],
      journal_postings: [{ account_id: 'acc-acme', fund_id: 'f1', book: 'actual', journal_entry_id: 'snap' }],
      journal_entries: [{ id: 'snap', fund_id: 'f1', vehicle_id: 'veh-1', book: 'actual', status: 'posted', source_ref: null }],
    }), 'f1', 'Fund I', 'u1')
    expect(vi.mocked(draftEntryForTransaction).mock.calls.map(c => c[3].id)).toEqual(['t4'])
    expect(r.carriedElsewhere).toEqual(['Acme'])
  })

  it('previews without writing anything', async () => {
    const r = await backfillDerivedEntries(world(), 'f1', 'Fund I', 'u1', { dryRun: true })
    expect(draftEntryForTransaction).not.toHaveBeenCalled()
    expect(r).toMatchObject({ toDerive: 4, alreadyDerived: 0, carriedElsewhere: [] })
  })
})

describe('backfillDerivedEntries — rows that never imply an entry', () => {
  it('does not count rounds, splits, or zero-value marks and purchases as waiting for the ledger', async () => {
    const r = await backfillDerivedEntries(fakeAdmin({
      investment_transactions: [
        txn('r', 'acme', 'round_info', '2026-01-01'),
        txn('s', 'acme', 'split', '2026-01-02'),
        { ...txn('m0', 'acme', 'unrealized_gain_change', '2026-01-03'), unrealized_value_change: 0 },
        { ...txn('i0', 'acme', 'investment', '2026-01-04'), investment_cost: 0 },
        { ...txn('m1', 'acme', 'unrealized_gain_change', '2026-01-05'), unrealized_value_change: 10 },
      ],
      companies: [{ id: 'acme', fund_id: 'f1', name: 'Acme' }],
      journal_entries: [], chart_of_accounts: [], journal_postings: [],
    }), 'f1', 'Fund I', 'u1', { dryRun: true })
    expect(r.toDerive).toBe(1)
  })
})

describe('backfillDerivedEntries — what counts as already on the ledger', () => {
  beforeEach(() => { vi.mocked(draftEntryForTransaction).mockClear() })

  it('ignores an unposted draft from another source — a draft is not on the books', async () => {
    const r = await backfillDerivedEntries(world({
      chart_of_accounts: [{ id: 'acc-acme', fund_id: 'f1', vehicle_id: 'veh-1', company_id: 'acme', code: '1100-acme' }],
      journal_postings: [{ account_id: 'acc-acme', fund_id: 'f1', book: 'actual', journal_entry_id: 'bank-draft' }],
      journal_entries: [{ id: 'bank-draft', fund_id: 'f1', vehicle_id: 'veh-1', book: 'actual', status: 'draft', source_ref: null }],
    }), 'f1', 'Fund I', 'u1', { dryRun: true })
    expect(r.carriedElsewhere).toEqual([])
  })

  it('refuses the whole vehicle when the pooled investment account carries postings — they cannot be attributed to a company', async () => {
    const r = await backfillDerivedEntries(world({
      chart_of_accounts: [{ id: 'pooled', fund_id: 'f1', vehicle_id: 'veh-1', company_id: null, code: '1100', subtype: 'investment' }],
      journal_postings: [{ account_id: 'pooled', fund_id: 'f1', book: 'actual', journal_entry_id: 'qb' }],
      journal_entries: [{ id: 'qb', fund_id: 'f1', vehicle_id: 'veh-1', book: 'actual', status: 'posted', source_ref: null }],
    }), 'f1', 'Fund I', 'u1')
    expect(draftEntryForTransaction).not.toHaveBeenCalled()
    expect(r.toDerive).toBe(0)
    expect(r.blocked).toMatch(/1100/)
  })
})
