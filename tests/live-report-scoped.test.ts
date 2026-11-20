// One investor's report card builds only the vehicles that investor holds
// (generateLiveReport entityIds). The promise: their rows are exactly the rows the whole-fund
// build gives them, through an associate/GP vehicle too, while reading fewer vehicles' books.
// Every name and figure here is invented.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildFixture, instrument, FUND, GROUP, VEHICLE } from './helpers/close-fixture'
import { generateLiveReport, vehiclesForEntities } from '@/lib/accounting/live-report'
import { footerWithoutDate, formatAsOf, reportedThrough } from '@/lib/report-card-footer'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2021-06-30T00:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

const SECOND = 'Example Fund II'
const ASSOC = 'Example GP Vehicle'
const OTHER = 'Example Opportunity Fund'

/** Three books: the base fund, a copy of it as a second fund, and an associate vehicle that is GP
 *  of the base fund (through entity lp-gp), with two members (lp-c, also direct, and lp-x, only
 *  through the associate). A fourth vehicle holds only lp-a. */
function multiVehicleFund() {
  const m = buildFixture({ months: 12, noisePerMonth: 3, allocatedEvery: 2, carry: true })
  const t = m.tables
  t.fund_vehicles[0].active = true
  t.lp_entities.push({ id: 'lp-x', fund_id: FUND, entity_name: 'Jane Roe' })

  const clone = (vehicleId: string, name: string, keep: (lp: string | null) => boolean) => {
    const acct = (id: string) => `${id}@${vehicleId}`
    for (const a of t.chart_of_accounts.filter((a: any) => a.vehicle_id === VEHICLE && keep(a.lp_entity_id))) {
      t.chart_of_accounts.push({ ...a, id: acct(a.id), vehicle_id: vehicleId, portfolio_group: name })
    }
    for (const e of t.journal_entries.filter((e: any) => e.vehicle_id === VEHICLE)) {
      t.journal_entries.push({ ...e, id: `${e.id}@${vehicleId}`, vehicle_id: vehicleId, portfolio_group: name })
    }
    for (const p of t.journal_postings.filter((p: any) => p.vehicle_id === VEHICLE && keep(p.lp_entity_id))) {
      t.journal_postings.push({ ...p, id: `${p.id}@${vehicleId}`, journal_entry_id: `${p.journal_entry_id}@${vehicleId}`, vehicle_id: vehicleId, account_id: acct(p.account_id) })
    }
    for (const c of t.commitment_events.filter((c: any) => c.vehicle_id === VEHICLE && keep(c.lp_entity_id))) {
      t.commitment_events.push({ ...c, id: `${c.id}@${vehicleId}`, vehicle_id: vehicleId })
    }
    for (const i of t.lp_investments.filter((i: any) => i.portfolio_group === GROUP && keep(i.entity_id))) {
      t.lp_investments.push({ ...i, id: `${i.id}@${vehicleId}`, portfolio_group: name })
    }
  }
  // The second fund leaves out lp-c and lp-d.
  clone('veh-2', SECOND, lp => lp !== 'lp-c' && lp !== 'lp-d')

  // lp-gp holds a position in the base fund: the associate's.
  t.chart_of_accounts.push({ id: 'acct-cap-lp-gp', fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, code: '3100-lp-gp', name: 'Partners capital, GP entity', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-gp', company_id: null, is_active: true })
  t.commitment_events.push({ id: 'ce-gp', fund_id: FUND, vehicle_id: VEHICLE, lp_entity_id: 'lp-gp', effective_date: '2020-01-01', amount: 400_000, kind: 'initial' })
  t.journal_entries.push({ id: 'je-gp-call', fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, book: 'actual', status: 'posted', entry_date: '2020-02-03', memo: 'Capital call', source_type: 'capital_call', source_ref: null, posted_at: '2020-02-03T12:00:00Z' })
  t.journal_postings.push(
    { id: 'jp-gp-1', journal_entry_id: 'je-gp-call', fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-1000', amount: 100_000, currency: 'USD', lp_entity_id: null },
    { id: 'jp-gp-2', journal_entry_id: 'je-gp-call', fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-cap-lp-gp', amount: -100_000, currency: 'USD', lp_entity_id: 'lp-gp' },
  )

  // The associate vehicle: its members' commitments and their capital.
  t.fund_vehicles.push(
    { id: 'veh-2', fund_id: FUND, name: SECOND, kind: 'fund', aliases: [], active: true },
    { id: 'veh-3', fund_id: FUND, name: ASSOC, kind: 'associate', aliases: [], active: true },
    { id: 'veh-4', fund_id: FUND, name: OTHER, kind: 'fund', aliases: [], active: true },
  )
  t.vehicle_gp_links = [{ id: 'gpl-1', fund_id: FUND, gp_vehicle_id: 'veh-3', served_vehicle_id: VEHICLE, lp_entity_id: 'lp-gp' }]
  t.chart_of_accounts.push({ id: 'acct-1000@veh-3', fund_id: FUND, vehicle_id: 'veh-3', portfolio_group: ASSOC, code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lp_entity_id: null, company_id: null, is_active: true })
  for (const [lp, amount] of [['lp-c', 100_000], ['lp-x', 300_000]] as const) {
    t.commitment_events.push({ id: `ce-${lp}@veh-3`, fund_id: FUND, vehicle_id: 'veh-3', lp_entity_id: lp, effective_date: '2020-01-01', amount, kind: 'initial' })
    t.chart_of_accounts.push({ id: `acct-cap-${lp}@veh-3`, fund_id: FUND, vehicle_id: 'veh-3', portfolio_group: ASSOC, code: `3100-${lp}`, name: `Partners capital, ${lp}`, type: 'equity', subtype: 'lp_capital', lp_entity_id: lp, company_id: null, is_active: true })
    t.journal_entries.push({ id: `je-call-${lp}@veh-3`, fund_id: FUND, vehicle_id: 'veh-3', portfolio_group: ASSOC, book: 'actual', status: 'posted', entry_date: '2020-02-01', memo: 'Capital call', source_type: 'capital_call', source_ref: null, posted_at: '2020-02-01T12:00:00Z' })
    t.journal_postings.push(
      { id: `jp-call-${lp}-1`, journal_entry_id: `je-call-${lp}@veh-3`, fund_id: FUND, vehicle_id: 'veh-3', book: 'actual', account_id: 'acct-1000@veh-3', amount: amount / 4, currency: 'USD', lp_entity_id: null },
      { id: `jp-call-${lp}-2`, journal_entry_id: `je-call-${lp}@veh-3`, fund_id: FUND, vehicle_id: 'veh-3', book: 'actual', account_id: `acct-cap-${lp}@veh-3`, amount: -amount / 4, currency: 'USD', lp_entity_id: lp },
    )
  }

  // A vehicle only lp-a is in, tracked by reported positions rather than a ledger.
  t.lp_positions = [{ id: 'pos-1', fund_id: FUND, vehicle_id: 'veh-4', lp_entity_id: 'lp-a', as_of_date: '2021-03-31', commitment: 250_000, called_capital: 200_000, distributions: 10_000, nav: 240_000, irr: 0.07 }]
  return m
}

const rowsOf = (rows: any[], ids: string[]) =>
  rows.filter(r => ids.includes(r.entity_id)).sort((a, b) => `${a.portfolio_group}|${a.entity_id}|${a.lookThroughVia ?? ''}`.localeCompare(`${b.portfolio_group}|${b.entity_id}|${b.lookThroughVia ?? ''}`))

describe('a report built for some entities', () => {
  const CASES: [string, string[], string[]][] = [
    ['an LP in both funds and a tracked vehicle', ['lp-a'], [GROUP, OTHER, SECOND]],
    ['a member of the associate who is also a direct LP', ['lp-c'], [ASSOC, GROUP]],
    ['a member only through the associate', ['lp-x'], [ASSOC, GROUP]],
    ['the entity that holds the associate position', ['lp-gp'], [ASSOC, GROUP]],
    ['an investor with two entities', ['lp-b', 'lp-d'], [GROUP, SECOND]],
  ]
  for (const [name, ids, vehicles] of CASES) {
    it(`gives ${name} exactly the whole-fund rows`, async () => {
      const m = multiVehicleFund()
      // The reference reads every vehicle's whole ledger; the card reads only partner-tagged rows.
      const full = await generateLiveReport(m.admin as any, FUND, undefined, { fullLedger: true })
      const io = instrument(m.admin)
      const scoped = await generateLiveReport(io.admin as any, FUND, undefined, { entityIds: ids })
      // The associate's holder has no row of its own: its members' rows replace it, in both builds.
      if (!ids.includes('lp-gp')) expect(rowsOf(full.rows, ids).length).toBeGreaterThan(0)
      expect(rowsOf(scoped.rows, ids)).toEqual(rowsOf(full.rows, ids))
      expect(scoped.vehicles.map(v => v.group).sort()).toEqual([...vehicles].sort())
    })
  }

  it('builds the look-through member rows, and drops the associate holder row, as the whole fund does', async () => {
    const m = multiVehicleFund()
    const scoped = await generateLiveReport(m.admin as any, FUND, undefined, { entityIds: ['lp-x', 'lp-gp'] })
    expect(scoped.rows.some(r => r.entity_id === 'lp-x' && r.lookThroughVia === ASSOC)).toBe(true)
    expect(scoped.rows.some(r => r.entity_id === 'lp-gp' && !r.lookThroughVia)).toBe(false)
  })

  it('at an earlier date too', async () => {
    const m = multiVehicleFund()
    const full = await generateLiveReport(m.admin as any, FUND, '2020-09-30', { fullLedger: true })
    const scoped = await generateLiveReport(m.admin as any, FUND, '2020-09-30', { entityIds: ['lp-c', 'lp-x'] })
    expect(rowsOf(scoped.rows, ['lp-c', 'lp-x'])).toEqual(rowsOf(full.rows, ['lp-c', 'lp-x']))
  })

  it('gives every LP the same rows from partner-tagged ledger rows as from the whole ledger', async () => {
    const m = multiVehicleFund()
    // A QuickBooks-imported capital call: its cash leg has no partner tag, and decides how the
    // capital is classified, so it has to be read along with the tagged legs.
    m.tables.journal_entries.push({ id: 'je-qb', fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, book: 'actual', status: 'posted', entry_date: '2020-07-15', memo: 'Deposit', source_type: 'quickbooks', source_ref: null, posted_at: '2020-07-15T12:00:00Z' })
    m.tables.journal_postings.push(
      { id: 'jp-qb-1', journal_entry_id: 'je-qb', fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-1000', amount: 20_000, currency: 'USD', lp_entity_id: null },
      { id: 'jp-qb-2', journal_entry_id: 'je-qb', fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-cap-lp-b', amount: -20_000, currency: 'USD', lp_entity_id: 'lp-b' },
    )
    // A draft that must stay out, and an entry dated after the report date.
    m.tables.journal_entries.push({ id: 'je-draft', fund_id: FUND, vehicle_id: VEHICLE, portfolio_group: GROUP, book: 'actual', status: 'draft', entry_date: '2020-08-01', memo: 'Draft call', source_type: 'capital_call', source_ref: null, posted_at: null })
    m.tables.journal_postings.push({ id: 'jp-draft', journal_entry_id: 'je-draft', fund_id: FUND, vehicle_id: VEHICLE, book: 'actual', account_id: 'acct-cap-lp-a', amount: -1_000, currency: 'USD', lp_entity_id: 'lp-a' })
    const sorted = (rows: any[]) => [...rows].sort((a, b) => `${a.portfolio_group}|${a.entity_id}|${a.lookThroughVia ?? ''}`.localeCompare(`${b.portfolio_group}|${b.entity_id}|${b.lookThroughVia ?? ''}`))
    for (const asOf of [undefined, '2020-07-31']) {
      const full = await generateLiveReport(m.admin as any, FUND, asOf, { fullLedger: true })
      const capital = await generateLiveReport(m.admin as any, FUND, asOf)
      expect(full.rows.length).toBeGreaterThan(5)
      expect(sorted(capital.rows)).toEqual(sorted(full.rows))
    }
  })

  it('reads fewer ledger rows than the whole fund', async () => {
    const m = multiVehicleFund()
    const a = instrument(m.admin); await generateLiveReport(a.admin as any, FUND, undefined, { fullLedger: true })
    const b = instrument(m.admin); await generateLiveReport(b.admin as any, FUND, undefined, { entityIds: ['lp-x'] })
    expect(b.rowsOf('journal_postings')).toBeLessThan(a.rowsOf('journal_postings') * 0.25)
  })

  it('finds a vehicle from a tagged posting alone', async () => {
    const m = multiVehicleFund()
    m.tables.journal_postings.push({ id: 'jp-tag', journal_entry_id: 'je-1@veh-2', fund_id: FUND, vehicle_id: 'veh-2', book: 'actual', account_id: 'acct-1000@veh-2', amount: 0, currency: 'USD', lp_entity_id: 'lp-c' })
    expect(await vehiclesForEntities(m.admin as any, FUND, ['lp-c'])).toContain(SECOND)
  })

  it('widens to the whole fund when a lookup fails', async () => {
    const m = multiVehicleFund()
    m.failNext('lp_positions', 'select', 'connection reset')
    expect(await vehiclesForEntities(m.admin as any, FUND, ['lp-a'])).toBeNull()
    const full = await generateLiveReport(m.admin as any, FUND)
    m.failNext('lp_positions', 'select', 'connection reset')
    const scoped = await generateLiveReport(m.admin as any, FUND, undefined, { entityIds: ['lp-a'] })
    expect(scoped.vehicles.length).toBe(full.vehicles.length)
  })
})

describe('the report card date', () => {
  it('drops a date saved at the start of a custom footer, and keeps the rest', () => {
    expect(footerWithoutDate('As of March 9, 2026. Figures are net of fees.')).toBe('Figures are net of fees.')
    expect(footerWithoutDate('as of 2026-03-31.  All data is unaudited.')).toBe('All data is unaudited.')
    expect(footerWithoutDate('As of March 9, 2026.')).toBeNull()
    expect(footerWithoutDate('As of the date shown, figures are estimates.')).toBe('As of the date shown, figures are estimates.')
    expect(footerWithoutDate('Figures are net of fees.')).toBe('Figures are net of fees.')
    expect(footerWithoutDate(null)).toBeNull()
  })

  it('is the latest date the rows are reported through', () => {
    expect(reportedThrough([{ evidence: { asOf: '2026-03-31' } }, { evidence: { asOf: '2026-06-30' } }, {}])).toBe('2026-06-30')
    expect(reportedThrough([{}])).toBeNull()
    expect(formatAsOf('2026-06-30')).toBe('June 30, 2026')
    expect(formatAsOf(null)).toBeNull()
  })
})

describe('an associate whose position is only an administrator import', () => {
  /** The tracked vehicle reports its administrator's figures, and the associate holds a position
   *  in it through lp-gp. The members' carry points differ from their ownership, so their shares
   *  are not straight slices of the position. */
  function importedAssociateFund() {
    const m = multiVehicleFund()
    const t = m.tables
    t.fund_vehicles.find((v: any) => v.id === 'veh-4').record_source = 'admin'
    t.lp_positions.push({ id: 'pos-gp', fund_id: FUND, vehicle_id: 'veh-4', lp_entity_id: 'lp-gp', as_of_date: '2021-03-31', commitment: 10_000, called_capital: 10_000, distributions: 50_000, nav: 150_000, carried_interest: 160_000 })
    // The fund's net LP figures for the quarter: the IRR is the only one the administrator states.
    t.vehicle_reported_figures = (['irr', 'tvpi', 'dpi'] as const).map((metric, i) => ({
      id: `vrf-${metric}`, fund_id: FUND, vehicle_id: 'veh-4', as_of: '2021-03-31', basis: 'net', metric, value: [0.12, 2.5, 1.0][i], source: 'Example Administrator',
    }))
    t.vehicle_gp_links.push({ id: 'gpl-2', fund_id: FUND, gp_vehicle_id: 'veh-3', served_vehicle_id: 'veh-4', lp_entity_id: 'lp-gp' })
    t.partner_allocation_terms = [
      { id: 'pat-c', fund_id: FUND, vehicle_id: 'veh-3', lp_entity_id: 'lp-c', category: 'carried_interest', participates: true, weight_override: 3, rate_override: null },
      { id: 'pat-x', fund_id: FUND, vehicle_id: 'veh-3', lp_entity_id: 'lp-x', category: 'carried_interest', participates: true, weight_override: 1, rate_override: null },
    ]
    return m
  }

  it("gives each member the administrator's stated IRR when there are no flows to work out their own", async () => {
    const m = importedAssociateFund()
    const report = await generateLiveReport(m.admin as any, FUND, undefined, { fullLedger: true })
    const members = report.rows.filter(r => r.portfolio_group === OTHER && r.lookThroughVia === ASSOC)
    expect(members.map(r => r.entity_id).sort()).toEqual(['lp-c', 'lp-x'])
    // Carry points make the shares differ from the position's own multiple...
    expect(members[0].tvpi).not.toBe(members[1].tvpi)
    // ...but the stated IRR is the only one there is, so each member shows it.
    for (const r of members) expect(r.irr).toBe(0.12)
    // The associate's holder has no row of its own in the vehicle.
    expect(report.rows.some(r => r.portfolio_group === OTHER && r.entity_id === 'lp-gp')).toBe(false)
  })
})
