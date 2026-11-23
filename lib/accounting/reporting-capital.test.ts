import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadReportingCapital } from './reporting-capital'
import { vehicleEconomics } from './fund-economics'
import { liveRowsForVehicle } from './live-report'
import type { FundPreload } from './fund-preload'

const group = 'Fund I'
const noQueries = { from() { throw new Error('Preloaded reporting must not query') } } as unknown as SupabaseClient
function fixture(source: 'events' | 'ledger' = 'events'): FundPreload {
  return {
    idMap: new Map([[group, 'v']]), entityNames: new Map([['lp', 'LP'], ['gp', 'GP']]),
    entityClasses: new Map([['lp', 'lp'], ['gp', 'gp']]),
    ownershipByGroup: new Map([[group, [
      { lpEntityId: 'lp', commitment: 10, paidIn: 0, distributions: 0 },
      { lpEntityId: 'gp', commitment: 5, paidIn: 0, distributions: 0 },
    ]]]),
    closedThroughByVehicleId: new Map(), vintageByName: new Map([[group, 2025]]),
    openingLinksByVehicleId: new Map([['v', []]]),
    positionsByVehicleId: new Map([['v', source === 'ledger' ? [] : [
      { lpEntityId: 'lp', asOfDate: '2025-03-31', commitment: 100, calledCapital: 40, distributions: 5, nav: 50, irr: 0.12 },
      { lpEntityId: 'gp', asOfDate: '2025-03-31', commitment: 20, calledCapital: 10, distributions: 2, nav: 12 },
    ]]]),
    commitmentEventsByVehicleId: new Map([['v', [
      { lpEntityId: 'lp', effectiveDate: '2025-01-01', amount: 80, kind: 'initial' },
      { lpEntityId: 'gp', effectiveDate: '2025-01-01', amount: 15, kind: 'initial' },
    ]]]),
    ledgerByVehicleId: new Map([['v', {
      acctRows: [{ id: 'cap', code: '3100-lp', name: 'LP capital', type: 'equity', lp_entity_id: 'lp' }, { id: 'due', code: '1300', name: 'Due from LPs', type: 'asset' }],
      entryRows: [{ id: 'j', entry_date: '2025-02-01', source_type: 'capital_call' }],
      postingRows: [{ journal_entry_id: 'j', account_id: 'cap', amount: -40, currency: 'USD', lp_entity_id: 'lp' }, { journal_entry_id: 'j', account_id: 'due', amount: 40, currency: 'USD', lp_entity_id: 'lp' }],
    }]]),
  }
}

// Exercise the database-loading path as well as the batch path, using the same records.
function databaseFor(pre: FundPreload): SupabaseClient {
  const ledger = pre.ledgerByVehicleId.get('v')!
  const tables: Record<string, any[]> = {
    fund_vehicles: [{ id: 'v', name: group }],
    fiscal_periods: [],
    lp_investments: pre.ownershipByGroup.get(group)!.map(o => ({ entity_id: o.lpEntityId, commitment: o.commitment, paid_in_capital: o.paidIn, distributions: o.distributions })),
    lp_positions: pre.positionsByVehicleId.get('v')!.map(p => ({ lp_entity_id: p.lpEntityId, as_of_date: p.asOfDate, commitment: p.commitment, called_capital: p.calledCapital, distributions: p.distributions, nav: p.nav, irr: p.irr })),
    commitment_events: pre.commitmentEventsByVehicleId.get('v')!.map(e => ({ lp_entity_id: e.lpEntityId, effective_date: e.effectiveDate, amount: e.amount, kind: e.kind })),
    chart_of_accounts: ledger.acctRows,
    journal_entries: ledger.entryRows.map(e => ({ ...e, status: 'posted' })),
    journal_postings: ledger.postingRows,
  }
  return { from(table: string) {
    let rows = (tables[table] ?? []).map(r => ({ fund_id: 'firm', vehicle_id: 'v', portfolio_group: group, book: 'actual', ...r }))
    const q: any = {
      select: () => q, order: () => q, limit: () => q,
      eq: (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return q },
      in: (key: string, values: unknown[]) => { rows = rows.filter(r => values.includes(r[key])); return q },
      lte: (key: string, value: string) => { rows = rows.filter(r => r[key] <= value); return q },
      range: (start: number, end: number) => { rows = rows.slice(start, end + 1); return q },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    }
    return q
  } } as unknown as SupabaseClient
}

describe('shared reporting capital', () => {
  it.each(['events', 'ledger'] as const)('reconciles fund and LP/GP figures using %s compatibility data', async source => {
    const pre = fixture(source)
    const econ = await vehicleEconomics(noQueries, 'firm', group, '2025-03-31', pre)
    const { rows } = await liveRowsForVehicle(noQueries, 'firm', group, '2025-03-31', pre)
    const sum = (field: 'commitment' | 'paid_in_capital' | 'distributions' | 'nav') => rows.reduce((s, r) => s + (r[field] ?? 0), 0)
    expect(econ.fund.committed).toBe(source === 'events' ? 120 : 95)
    expect(sum('commitment')).toBe(econ.fund.committed)
    expect(sum('paid_in_capital')).toBe(econ.fund.paidIn)
    expect(sum('distributions')).toBe(econ.fund.distributions)
    expect(sum('nav')).toBe(econ.fund.nav)
    expect(econ.lp.committed + econ.gp.committed).toBe(econ.fund.committed)
    expect(rows.find(r => r.entity_id === 'lp')?.commitment).toBe(econ.lp.committed)
    if (source === 'ledger') expect(rows.find(r => r.entity_id === 'lp')?.receivable).toBe(40)
  })

  it.each(['events', 'ledger'] as const)('matches direct and preloaded reads for %s records', async source => {
    const pre = fixture(source)
    const direct = await loadReportingCapital(databaseFor(pre), 'firm', group, '2025-03-31')
    const batch = await loadReportingCapital(noQueries, 'firm', group, '2025-03-31', pre)
    expect(direct).toEqual(batch)
  })

  it('retains explicit zero positions and partners with a commitment but no activity', async () => {
    const pre = fixture()
    pre.positionsByVehicleId.get('v')![0].commitment = 0
    pre.commitmentEventsByVehicleId.get('v')!.push({ lpEntityId: 'new', effectiveDate: '2025-02-01', amount: 30, kind: 'initial' })
    const { rows } = await liveRowsForVehicle(noQueries, 'firm', group, '2025-03-31', pre)
    expect(rows.find(r => r.entity_id === 'lp')?.commitment).toBe(0)
    expect(rows.find(r => r.entity_id === 'new')).toMatchObject({ commitment: 30, paid_in_capital: 0, nav: 0 })
  })

  it('uses event commitments when observations are absent, then legacy balances when events are absent', async () => {
    const pre = fixture()
    pre.positionsByVehicleId.set('v', [])
    expect((await loadReportingCapital(noQueries, 'firm', group, undefined, pre)).commitmentByLp.get('lp')).toBe(80)
    pre.commitmentEventsByVehicleId.set('v', [])
    expect((await loadReportingCapital(noQueries, 'firm', group, undefined, pre)).commitmentByLp.get('lp')).toBe(10)
  })

  it('excludes future observations, commitments, and reported IRR when reusing a preload', async () => {
    const pre = fixture()
    // Imports only: a partner with capital in the books reports the books, which is not under test.
    Object.assign(pre.ledgerByVehicleId.get('v')!, { entryRows: [], postingRows: [] })
    pre.positionsByVehicleId.get('v')!.push({ lpEntityId: 'lp', asOfDate: '2025-06-30', commitment: 999, calledCapital: 300, distributions: 60, nav: 400, irr: 0.8 })
    pre.commitmentEventsByVehicleId.get('v')!.push({ lpEntityId: 'gp', effectiveDate: '2025-06-30', amount: 100, kind: 'increase' })
    const { rows } = await liveRowsForVehicle(noQueries, 'firm', group, '2025-03-31', pre)
    expect(rows.find(r => r.entity_id === 'lp')).toMatchObject({ commitment: 100, paid_in_capital: 40, nav: 50, irr: 0.12 })
    const econ = await vehicleEconomics(noQueries, 'firm', group, '2025-03-31', pre)
    expect(econ.fund.committed).toBe(120)
    expect(econ.fund.nav).toBe(62)
  })

  it('carries paid-in and distributions with a transferred interest', async () => {
    const pre = fixture('ledger')
    const ledger = pre.ledgerByVehicleId.get('v')!
    ledger.acctRows.push({ id: 'cap-gp', code: '3100-gp', name: 'GP capital', type: 'equity', lp_entity_id: 'gp' })
    ledger.entryRows.push(
      { id: 'd', entry_date: '2025-02-15', source_type: 'distribution' },
      { id: 't', entry_date: '2025-03-01', source_type: 'transfer' },
    )
    ledger.postingRows.push(
      { journal_entry_id: 'd', account_id: 'cap', amount: 10, currency: 'USD', lp_entity_id: 'lp' },
      { journal_entry_id: 'd', account_id: 'due', amount: -10, currency: 'USD', lp_entity_id: 'lp' },
      { journal_entry_id: 't', account_id: 'cap', amount: 30, currency: 'USD', lp_entity_id: 'lp' },
      { journal_entry_id: 't', account_id: 'cap-gp', amount: -30, currency: 'USD', lp_entity_id: 'gp' },
    )
    const { rows } = await liveRowsForVehicle(noQueries, 'firm', group, '2025-03-31', pre)
    expect(rows.find(r => r.entity_id === 'gp')).toMatchObject({ called_capital: 40, paid_in_capital: 40, distributions: 10, nav: 30, tvpi: 1 })
    expect(rows.find(r => r.entity_id === 'lp')).toMatchObject({ called_capital: 0, paid_in_capital: 0, distributions: 0, nav: 0 })
  })

  it('excludes future journal entries from a reused preload', async () => {
    const pre = fixture('ledger')
    const ledger = pre.ledgerByVehicleId.get('v')!
    ledger.entryRows.push({ id: 'future', entry_date: '2025-06-30', source_type: 'capital_call' })
    ledger.postingRows.push({ journal_entry_id: 'future', account_id: 'cap', amount: -500, currency: 'USD', lp_entity_id: 'lp' })
    const result = await loadReportingCapital(noQueries, 'firm', group, '2025-03-31', pre)
    expect(result.postings).toHaveLength(1)
    expect(result.postings[0].amount).toBe(-40)
  })
})
