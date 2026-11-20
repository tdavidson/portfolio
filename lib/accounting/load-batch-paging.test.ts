import { describe, it, expect } from 'vitest'
import { loadLedgerRowsBatch, assembleLoadedLedger } from './load'

// Postgres gives no order to rows a query doesn't sort, and with LIMIT/OFFSET it may pick a different
// plan for each page. This fake does what the database did to the LP report: an unsorted select
// comes back in a different order for every page, so paging repeats some rows and never returns
// others. A select sorted by a unique column pages correctly.
function unstableAdmin(tables: Record<string, any[]>): any {
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []
    let sortKey: string | null = null
    let start = 0
    let end = Infinity
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => { filters.push(r => r[k] === v); return q },
      in: (k: string, vs: any[]) => { filters.push(r => vs.includes(r[k])); return q },
      lte: (k: string, v: any) => { filters.push(r => r[k] <= v); return q },
      not: (k: string, _op: string, _v: null) => { filters.push(r => r[k] != null); return q },
      order: (k: string) => { sortKey = k; return q },
      range: (a: number, b: number) => { start = a; end = b; return q },
      then: (resolve: (v: any) => any) => {
        const rows = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        let ordered: any[]
        if (sortKey) {
          const key = sortKey
          ordered = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
        } else {
          // A different, deterministic order per page: reverse the rows on every other page.
          ordered = (start / 1000) % 2 === 1 ? [...rows].reverse() : rows
        }
        return resolve({ data: ordered.slice(start, end + 1), error: null })
      },
    }
    return q
  }
  return { from }
}

const FUND = 'fund-1'
const V = 'v1'
const LPS = 1200

function fixture() {
  const chart: any[] = [
    { id: 'acct-receivable', code: '1300', name: 'Due from LPs', type: 'asset', subtype: 'receivable', vehicle_id: V, fund_id: FUND },
  ]
  const postings: any[] = []
  const pad = (n: number) => String(n).padStart(5, '0')
  for (let i = 0; i < LPS; i++) {
    chart.push({ id: `acct-lp-${pad(i)}`, code: `3100-${pad(i)}`, name: `Partners' capital ${i}`, type: 'equity', subtype: 'lp_capital', lp_entity_id: `lp-${pad(i)}`, vehicle_id: V, fund_id: FUND })
    postings.push({ id: `p-lp-${pad(i)}`, journal_entry_id: 'call-1', account_id: `acct-lp-${pad(i)}`, amount: -1000, currency: 'USD', lp_entity_id: `lp-${pad(i)}`, vehicle_id: V, fund_id: FUND, book: 'actual' })
  }
  // The fund side of the call: Due from LPs, untagged, sorted after the partners' lines by id.
  postings.push({ id: 'p-z-receivable', journal_entry_id: 'call-1', account_id: 'acct-receivable', amount: LPS * 1000, currency: 'USD', lp_entity_id: null, vehicle_id: V, fund_id: FUND, book: 'actual' })
  const entries = [{ id: 'call-1', source_type: 'carta', status: 'posted', entry_date: '2022-07-25', memo: 'Capital call', vehicle_id: V, fund_id: FUND, book: 'actual' }]
  return { chart_of_accounts: chart, journal_entries: entries, journal_postings: postings }
}

describe('the LP report\'s batched capital read pages in a stable order', () => {
  it('reads every line of an imported call once, so the call is classified as called capital', async () => {
    const rows = (await loadLedgerRowsBatch(unstableAdmin(fixture()), FUND, [V], undefined, { capitalOnly: true })).get(V)!
    const ids = rows.postingRows.map((p: any) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('p-z-receivable')
    expect(ids).toHaveLength(LPS + 1)

    const ledger = assembleLoadedLedger(FUND, rows)
    expect(ledger.capitalPostings).toHaveLength(LPS)
    expect(new Set(ledger.capitalPostings.map(p => p.sourceType))).toEqual(new Set(['capital_call']))
  })

  it('reads every row in the whole-ledger batch too', async () => {
    const rows = (await loadLedgerRowsBatch(unstableAdmin(fixture()), FUND, [V])).get(V)!
    expect(rows.postingRows).toHaveLength(LPS + 1)
    expect(rows.acctRows).toHaveLength(LPS + 1)
  })
})
