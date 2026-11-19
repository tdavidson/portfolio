// An invented fund for exercising the period close end to end on the in-memory admin client.
// Every name and figure here is made up.
import { memoryAdmin, type Row } from './memory-admin'

export const FUND = 'fund-1'
export const GROUP = 'Example Fund I'
export const VEHICLE = 'veh-1'

const LPS = [
  { id: 'lp-a', name: 'Acme Partners', commitment: 5_000_000 },
  { id: 'lp-b', name: 'Northwind Trust', commitment: 3_000_000 },
  { id: 'lp-c', name: 'Jane Doe', commitment: 2_000_000 },
  { id: 'lp-d', name: 'Example Holdings', commitment: 1_000_000 },
]

const CHART: [string, string, string, string | null][] = [
  ['1000', 'Cash', 'asset', 'cash'],
  ['1200', 'Investments at fair value', 'asset', 'investment'],
  ['1300', 'Capital call receivable', 'asset', null],
  ['3200', 'Undistributed earnings', 'equity', null],
  ['4000', 'Interest income', 'income', 'interest_income'],
  ['4200', 'Unrealized gain / (loss)', 'income', 'unrealized'],
  ['4100', 'Realized gain / (loss)', 'income', 'realized_gain'],
  ['5000', 'Management fees', 'expense', 'management_fee'],
  ['5100', 'Fund expenses', 'expense', 'partnership_expense'],
  ['5200', 'Organizational costs', 'expense', 'organizational_expense'],
]

/** Deterministic pseudo-random amounts, so the fixture is the same every run. */
function rng(seed: number) {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
}

export interface FixtureOptions {
  months: number
  /** Extra entries per month, to make the ledger big. */
  noisePerMonth?: number
  /** Leave every Nth entry already allocated on posting. */
  allocatedEvery?: number
  maxRows?: number
  start?: string
  /** Straight 20% carry to a GP entity, with quarterly capital calls so there is capital to carry on. */
  carry?: boolean
}

export function buildFixture(opts: FixtureOptions) {
  const rand = rng(7)
  const start = opts.start ?? '2020-01-01'
  const seed: Record<string, Row[]> = {
    fund_vehicles: [{ id: VEHICLE, fund_id: FUND, name: GROUP, kind: 'fund', aliases: [] }],
    funds: [{ id: FUND, currency: 'USD' }],
    fund_settings: [{ fund_id: FUND, currency: 'USD' }],
    chart_of_accounts: CHART.map(([code, name, type, subtype]) => ({
      id: `acct-${code}`, fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, code, name, type, subtype, lp_entity_id: null, company_id: null, is_active: true,
    })),
    lp_entities: [...LPS.map(lp => ({ id: lp.id, fund_id: FUND, entity_name: lp.name })), { id: 'lp-gp', fund_id: FUND, entity_name: 'Example GP LLC' }],
    lp_investments: LPS.map(lp => ({ id: `inv-${lp.id}`, fund_id: FUND, portfolio_group: GROUP, entity_id: lp.id, commitment: lp.commitment, paid_in_capital: 0, distributions: 0, snapshot_id: null, updated_at: '2020-01-01T00:00:00Z' })),
    commitment_events: LPS.map((lp, i) => ({ id: `ce-${i}`, fund_id: FUND, vehicle_id: VEHICLE, lp_entity_id: lp.id, effective_date: start, amount: lp.commitment, kind: 'initial' })),
    journal_entries: [],
    journal_postings: [],
    journal_entry_allocations: [],
  }
  if (opts.carry) {
    seed.vehicle_waterfall_terms = [{ fund_id: FUND, vehicle_id: VEHICLE, kind: 'straight', carry_rate: 0.2, pref_rate: 0, gp_entity_id: 'lp-gp' }]
    seed.chart_of_accounts.push({ id: 'acct-3000', fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, code: '3000', name: 'GP capital', type: 'equity', subtype: 'gp_capital', lp_entity_id: null, company_id: null, is_active: true })
    for (const lp of LPS) {
      seed.chart_of_accounts.push({ id: `acct-cap-${lp.id}`, fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, code: `3100-${lp.id}`, name: `Partners' capital — ${lp.name}`, type: 'equity', subtype: 'lp_capital', lp_entity_id: lp.id, company_id: null, is_active: true })
    }
  }
  // A commitment change part-way through, so the basis moves between months.
  seed.commitment_events.push({ id: 'ce-x', fund_id: FUND, vehicle_id: VEHICLE, lp_entity_id: 'lp-d', effective_date: addMonths(start, Math.floor(opts.months / 2)), amount: 500_000, kind: 'increase' })

  let n = 0
  const entry = (date: string, memo: string, sourceType: string, lines: [string, number][]) => {
    const id = `je-${++n}`
    seed.journal_entries.push({ id, fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, book: 'actual', status: 'posted', entry_date: date, memo, source_type: sourceType, source_ref: null, posted_at: `${date}T12:00:00Z` })
    for (const [code, amount] of lines) {
      seed.journal_postings.push({ id: `jp-${id}-${code}-${seed.journal_postings.length}`, journal_entry_id: id, fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: `acct-${code}`, amount, currency: 'USD', lp_entity_id: null })
    }
    if (opts.allocatedEvery && n % opts.allocatedEvery === 0) {
      seed.journal_entry_allocations.push({ id: `jea-${id}`, fund_id: FUND, vehicle_id: VEHICLE, source_entry_id: id })
    }
    return id
  }
  const cents = (x: number) => Math.round(x * 100) / 100

  for (let m = 0; m < opts.months; m++) {
    const mStart = addMonths(start, m)
    const day = (d: number) => `${mStart.slice(0, 8)}${String(d).padStart(2, '0')}`
    const fee = cents(11_000_000 * 0.02 / 12)
    entry(day(1), 'Management fee', 'manual', [['5000', fee], ['1000', -fee]])
    const exp = cents(1_000 + rand() * 9_000)
    entry(day(10), 'Fund admin and audit', 'manual', [['5100', exp], ['1000', -exp]])
    const int = cents(rand() * 2_500)
    entry(day(28), 'Bank interest', 'manual', [['1000', int], ['4000', -int]])
    if (m === 0) entry(day(5), 'Formation costs', 'manual', [['5200', 25_000], ['1000', -25_000]])
    if (m % 3 === 2) {
      const mark = cents((rand() - 0.35) * 400_000)
      entry(day(28), 'Quarterly mark', 'manual', [['1200', mark], ['4200', -mark]])
    }
    if (m % 7 === 4) {
      const gain = cents(rand() * 150_000)
      entry(day(20), 'Partial exit', 'manual', [['1000', gain], ['4100', -gain]])
    }
    if (opts.carry && m % 3 === 0) {
      const lines: [string, number][] = []
      let total = 0
      for (const lp of LPS) { const amt = cents(lp.commitment * 0.05); total += amt; lines.push([`cap-${lp.id}`, -amt]) }
      const id = entry(day(3), 'Capital call', 'capital_call', [['1000', cents(total)]])
      for (const [code, amt] of lines) {
        seed.journal_postings.push({ id: `jp-${id}-${code}`, journal_entry_id: id, fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: `acct-${code}`, amount: amt, currency: 'USD', lp_entity_id: code.slice(4) })
      }
      // Invest most of it, and mark it up, so there is a gain to carry.
      entry(day(4), 'Investment', 'manual', [['1200', cents(total * 0.8)], ['1000', -cents(total * 0.8)]])
      entry(day(27), 'Write-up', 'manual', [['1200', cents(total * 0.3)], ['4200', -cents(total * 0.3)]])
    }
    for (let k = 0; k < (opts.noisePerMonth ?? 0); k++) {
      const amt = cents(50 + rand() * 500)
      entry(day(1 + (k % 27)), `Expense ${k}`, 'manual', [['5100', amt], ['1000', -amt]])
    }
  }
  return memoryAdmin(seed, {
    maxRows: opts.maxRows ?? 1000,
    // The database defaults `book` to 'actual' on both ledger tables; the in-memory client has no defaults.
    before: (table, op, payload) => {
      if (op !== 'insert' || (table !== 'journal_entries' && table !== 'journal_postings')) return
      for (const row of Array.isArray(payload) ? payload : [payload]) row.book ??= 'actual'
    },
  })
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

export function lastDayOfMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

/** Wrap an admin client so every `.from()` and every row a read returns is counted, by table. */
export function instrument(admin: any) {
  const calls: { table: string; rows: number }[] = []
  const wrapped = {
    ...admin,
    from(table: string) {
      const q = admin.from(table)
      const rec = { table, rows: 0 }
      calls.push(rec)
      const then = q.then
      q.then = (res: any, rej: any) => then((r: any) => { rec.rows = Array.isArray(r?.data) ? r.data.length : r?.data ? 1 : 0; return res(r) }, rej)
      for (const k of ['maybeSingle', 'single']) {
        const orig = q[k]
        q[k] = async () => { const r = await orig(); rec.rows = r?.data ? 1 : 0; return r }
      }
      return q
    },
  }
  const rowsOf = (table: string) => calls.filter(c => c.table === table).reduce((s, c) => s + c.rows, 0)
  return { admin: wrapped, calls, rowsOf }
}

/** Everything a close writes, by table, with wall-clock timestamps blanked. */
export function closeOutput(tables: Record<string, any[]>) {
  const keep = ['journal_entries', 'journal_postings', 'journal_entry_allocations', 'close_allocation_rounding', 'fiscal_periods',
    'close_reviews', 'close_review_checks', 'close_bundles', 'chart_of_accounts', 'accounting_audit_events']
  const blank = (v: any): any => {
    if (Array.isArray(v)) return v.map(blank)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /(_at|createdAt)$/.test(k) ? '<t>' : blank(x)]))
    return v
  }
  return Object.fromEntries(keep.map(t => [t, blank(tables[t] ?? [])]))
}
