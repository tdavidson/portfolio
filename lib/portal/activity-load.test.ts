import { describe, expect, it } from 'vitest'
import { loadActivity } from './activity-load'

// A fake Supabase client: each table returns its rows, filtered by the `in`/`eq` filters the
// loader applies, so a query for the wrong rows shows up as a wrong result.
function fakeDb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const filters: ((r: any) => boolean)[] = []
      const q: any = {
        select: () => q,
        order: () => q,
        in: (col: string, vals: string[]) => { filters.push(r => vals.includes(r[col])); return q },
        eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return q },
        range: (from: number, to: number) => { (q as any).slice = [from, to]; return q },
        then: (resolve: (v: any) => any) => {
          const rows = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
          const [from, to] = (q as any).slice ?? [0, rows.length]
          return resolve({ data: rows.slice(from, to + 1), error: null })
        },
      }
      return q
    },
  } as any
}

const base = { fund_id: 'f1', vehicle_id: 'v1' }
const tables = {
  fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Example Fund I' }],
  chart_of_accounts: [
    { ...base, id: 'cap-e1', code: '3100', name: 'Partner capital', type: 'equity', subtype: null, lp_entity_id: 'e1', company_id: null },
    { ...base, id: 'cap-other', code: '3101', name: 'Partner capital', type: 'equity', subtype: null, lp_entity_id: 'other', company_id: null },
    { ...base, id: 'cash', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lp_entity_id: null, company_id: null },
  ],
  journal_entries: [
    { ...base, id: 'call', source_type: 'capital_call', status: 'posted', entry_date: '2024-01-15', memo: 'Call from Example Trust and other partners', book: 'actual' },
    { ...base, id: 'draft', source_type: 'capital_call', status: 'draft', entry_date: '2024-02-15', memo: null, book: 'actual' },
  ],
  journal_postings: [
    { ...base, id: 'p1', journal_entry_id: 'call', account_id: 'cash', amount: 300, currency: 'USD', lp_entity_id: null, book: 'actual' },
    { ...base, id: 'p2', journal_entry_id: 'call', account_id: 'cap-e1', amount: -100, currency: 'USD', lp_entity_id: 'e1', book: 'actual' },
    { ...base, id: 'p3', journal_entry_id: 'call', account_id: 'cap-other', amount: -200, currency: 'USD', lp_entity_id: 'other', book: 'actual' },
    { ...base, id: 'p4', journal_entry_id: 'draft', account_id: 'cap-e1', amount: -50, currency: 'USD', lp_entity_id: 'e1', book: 'actual' },
  ],
  lp_positions: [],
  capital_call_lines: [{ id: 'line-1', fund_id: 'f1', lp_entity_id: 'e1', capital_calls: { journal_entry_id: 'call', status: 'issued' } }],
  distribution_lines: [],
}

describe('loadActivity', () => {
  it("reads only the investor's own capital postings on posted entries, and links the notice", async () => {
    const lines = await loadActivity(fakeDb(tables), ['f1'], new Map([['e1', 'Example Trust']]))
    expect(lines).toEqual([expect.objectContaining({
      date: '2024-01-15', vehicle: 'Example Fund I', entityId: 'e1', kind: 'contribution', amount: 100,
      notice: { lineId: 'line-1', kind: 'capital_call' },
    })])
    expect(JSON.stringify(lines)).not.toContain('other partners')
  })

  it('returns nothing for an investor with no capital accounts or statements', async () => {
    expect(await loadActivity(fakeDb(tables), ['f1'], new Map([['nobody', 'Nobody']]))).toEqual([])
  })
})
