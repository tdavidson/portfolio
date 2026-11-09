import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { readCostTransfer, readInvestmentLines } from '@/lib/accounting/adopt'
import type { ChartAccount } from '@/lib/accounting/investment-accounts'
import { computeSummary } from '@/lib/investments'
import { buildSoiPositions } from '@/lib/accounting/soi'
import { investmentsAfterTransfers } from './cost-transfer-math'
import { convertToCostTransfer } from './cost-transfer'
import type { InvestmentTransaction } from '@/lib/types/database'

const A = (id: string, code: string, type: string, subtype: string | null, companyId: string | null = null): ChartAccount =>
  ({ id, code, type, subtype, companyId })
const chart: ChartAccount[] = [
  A('cash', '1000', 'asset', 'cash'),
  A('a1100', '1100-aaaa', 'asset', 'investment', 'co-a'),
  A('a1200', '1200-aaaa', 'asset', 'unrealized', 'co-a'),
  A('a4000', '4000-aaaa', 'income', 'realized_gain', 'co-a'),
  A('b1100', '1100-bbbb', 'asset', 'investment', 'co-b'),
  A('c1100', '1100-cccc', 'asset', 'investment', 'co-c'),
  A('p4000', '4000', 'income', 'realized_gain'),
  A('p4200', '4200', 'income', 'unrealized'),
]
const L = (accountId: string, amount: number) => ({ accountId, amount })

describe('deriving a cost transfer from the journal', () => {
  it('a two-line entry, Cr one holding / Dr another, is a cost transfer — not proceeds plus an investment', () => {
    expect(readInvestmentLines([L('b1100', 25_000), L('a1100', -25_000)], chart)).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'cost_transfer', investment_cost: -25_000, transfer_company_id: 'co-b' },
      { company_id: 'co-b', transaction_type: 'cost_transfer', investment_cost: 25_000, transfer_company_id: 'co-a' },
    ] })
  })

  it('several lines per holding are netted', () => {
    expect(readCostTransfer([L('b1100', 10_000), L('b1100', 15_000), L('a1100', -25_000)], chart)?.map(t => t.investment_cost)).toEqual([-25_000, 25_000])
  })

  it('a real exit for cash still derives proceeds', () => {
    expect(readInvestmentLines([L('cash', 25_000), L('a1100', -25_000)], chart)).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 25_000, proceeds_received: 25_000 },
    ] })
  })

  it('an exchange with a gain line is not a transfer: the gain is realized on an exit', () => {
    // Cr A cost 20k, Cr A gain 5k, Dr B cost 25k — an exit from A into B at 25k.
    const read = readInvestmentLines([L('b1100', 25_000), L('a1100', -20_000), L('a4000', -5_000)], chart)
    expect(readCostTransfer([L('b1100', 25_000), L('a1100', -20_000), L('a4000', -5_000)], chart)).toBeNull()
    expect(read).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 20_000, proceeds_received: 25_000 },
      { company_id: 'co-b', transaction_type: 'investment', investment_cost: 25_000 },
    ] })
  })

  it('a pooled gain or loss line, a mark, a third holding or unequal amounts are not a transfer', () => {
    expect(readCostTransfer([L('b1100', 25_000), L('a1100', -20_000), L('p4000', -5_000)], chart)).toBeNull()
    expect(readCostTransfer([L('b1100', 25_000), L('a1100', -25_000), L('a1200', -1_000), L('p4200', 1_000)], chart)).toBeNull()
    expect(readCostTransfer([L('b1100', 10_000), L('c1100', 15_000), L('a1100', -25_000)], chart)).toBeNull()
    expect(readCostTransfer([L('b1100', 25_000), L('a1100', -20_000), L('cash', -5_000)], chart)).toBeNull()
  })
})

const txn = (o: Partial<InvestmentTransaction>): InvestmentTransaction => ({
  id: Math.random().toString(36).slice(2), fund_id: 'f', company_id: 'co-a', portfolio_group: 'Example Fund I',
  transaction_type: 'investment', transaction_date: '2022-01-01', round_name: null, investment_cost: null,
  shares_acquired: null, share_price: null, proceeds_received: null, cost_basis_exited: null,
  ...o,
} as InvestmentTransaction)

describe('reporting a cost transfer', () => {
  const source = [
    txn({ transaction_type: 'investment', transaction_date: '2022-04-01', investment_cost: 100_000 }),
    txn({ transaction_type: 'investment', transaction_date: '2022-07-01', investment_cost: 200_000 }),
    txn({ transaction_type: 'cost_transfer', transaction_date: '2025-01-31', investment_cost: -25_000, transfer_company_id: 'co-b' } as any),
  ]
  const target = [
    txn({ company_id: 'co-b', transaction_type: 'cost_transfer', transaction_date: '2025-01-31', investment_cost: 25_000, transfer_company_id: 'co-a' } as any),
  ]

  it('the source shows reduced invested capital and cost, and nothing realized', () => {
    const s = computeSummary(source, 'active', new Date('2026-01-01'))
    expect(s.totalInvested).toBe(275_000)
    expect(s.totalRealized).toBe(0)
    expect(s.unrealizedValue).toBe(275_000)
    expect(s.moic).toBe(1)
  })

  it('the source IRR is not lifted by the transfer: at cost it stays at zero', () => {
    const s = computeSummary(source, 'active', new Date('2026-01-01'))
    expect(Math.abs(s.grossIrr ?? 0)).toBeLessThan(1e-6)
  })

  it('the target carries the cost from the transfer date', () => {
    const s = computeSummary(target, 'active', new Date('2026-01-01'))
    expect(s.totalInvested).toBe(25_000)
    expect(s.unrealizedValue).toBe(25_000)
    expect(s.totalRealized).toBe(0)
  })

  it('the schedule of investments lists both, with cost moved and total cost unchanged', () => {
    const companies = [
      { id: 'co-a', name: 'Acme', status: 'active' as const, industry: null, stage: null, portfolio_group: ['Example Fund I'] },
      { id: 'co-b', name: 'Northwind', status: 'active' as const, industry: null, stage: null, portfolio_group: ['Example Fund I'] },
    ]
    const positions = buildSoiPositions([...source, ...target], companies, 'Example Fund I', new Date('2026-01-01'))
    const cost = Object.fromEntries(positions.map(p => [p.companyId, (p as any).cost]))
    expect(cost).toEqual({ 'co-a': 275_000, 'co-b': 25_000 })
  })

  it('a deal-by-deal base: a transfer in is capital from its date, a transfer out shrinks earlier capital', () => {
    expect(investmentsAfterTransfers(
      [{ date: '2022-04-01', amount: 100_000 }, { date: '2022-07-01', amount: 200_000 }],
      [{ date: '2025-01-31', amount: -30_000 }],
    )).toEqual([{ date: '2022-04-01', amount: 90_000 }, { date: '2022-07-01', amount: 180_000 }])
    expect(investmentsAfterTransfers([], [{ date: '2025-01-31', amount: 25_000 }])).toEqual([{ date: '2025-01-31', amount: 25_000 }])
  })
})

describe('converting a mislabeled pair', () => {
  const setup = () => memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Example Fund I', kind: 'fund', aliases: [] }],
    fiscal_periods: [],
    chart_of_accounts: [
      { id: 'a1100', fund_id: 'f', vehicle_id: 'v1', code: '1100-aaaa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
      { id: 'b1100', fund_id: 'f', vehicle_id: 'v1', code: '1100-bbbb', type: 'asset', subtype: 'investment', company_id: 'co-b' },
      { id: 'cash', fund_id: 'f', vehicle_id: 'v1', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
    ],
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }, { id: 'co-b', fund_id: 'f', name: 'Northwind' }],
    journal_entries: [
      { id: 'e1', fund_id: 'f', book: 'actual', status: 'posted', entry_date: '2025-01-31', vehicle_id: 'v1', source_ref: 'qb:x', memo: 'Transfer' },
      { id: 'e2', fund_id: 'f', book: 'actual', status: 'posted', entry_date: '2025-02-28', vehicle_id: 'v1', source_ref: 'qb:y', memo: 'Sale' },
    ],
    journal_postings: [
      { id: 'p1', journal_entry_id: 'e1', account_id: 'b1100', amount: 25_000 },
      { id: 'p2', journal_entry_id: 'e1', account_id: 'a1100', amount: -25_000 },
      { id: 'p3', journal_entry_id: 'e2', account_id: 'cash', amount: 10_000 },
      { id: 'p4', journal_entry_id: 'e2', account_id: 'a1100', amount: -10_000 },
    ],
    investment_transactions: [
      { id: 't-proc', fund_id: 'f', company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 25_000, proceeds_received: 25_000, adopted_entry_id: 'e1', portfolio_group: 'Example Fund I', transaction_date: '2025-01-31' },
      { id: 't-inv', fund_id: 'f', company_id: 'co-b', transaction_type: 'investment', investment_cost: 25_000, adopted_entry_id: 'e1', portfolio_group: 'Example Fund I', transaction_date: '2025-01-31' },
      { id: 't-sale', fund_id: 'f', company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 10_000, proceeds_received: 10_000, adopted_entry_id: 'e2', portfolio_group: 'Example Fund I', transaction_date: '2025-02-28' },
    ],
    fund_nav_statements: [],
    fund_capital_events: [],
  })
  const who = { fundId: 'f', userId: null, vehicleNames: null }

  it('replaces the proceeds and investment with one cost transfer and leaves the journal lines unchanged', async () => {
    const m = setup()
    const linesBefore = JSON.parse(JSON.stringify(m.tables.journal_postings))
    const entriesBefore = JSON.parse(JSON.stringify(m.tables.journal_entries))
    const r = await convertToCostTransfer(m.admin as any, who, 'e1')
    expect(r.ok).toBe(true)
    expect(m.tables.journal_postings).toEqual(linesBefore)
    expect(m.tables.journal_entries).toEqual(entriesBefore)
    const owned = m.tables.investment_transactions.filter((t: any) => t.adopted_entry_id === 'e1')
    expect(owned.map((t: any) => [t.company_id, t.transaction_type, t.investment_cost, t.transfer_company_id]).sort()).toEqual([
      ['co-a', 'cost_transfer', -25_000, 'co-b'],
      ['co-b', 'cost_transfer', 25_000, 'co-a'],
    ])
    expect(m.tables.investment_transactions.find((t: any) => t.id === 't-proc')).toBeUndefined()
    // The real sale on another entry is untouched.
    expect(m.tables.investment_transactions.find((t: any) => t.id === 't-sale')?.transaction_type).toBe('proceeds')
  })

  it('a dry run writes nothing', async () => {
    const m = setup()
    const before = JSON.parse(JSON.stringify(m.tables.investment_transactions))
    const r = await convertToCostTransfer(m.admin as any, who, 'e1', { dryRun: true })
    expect(r.ok && r.value.amount).toBe(25_000)
    expect(m.tables.investment_transactions).toEqual(before)
  })

  it('refuses a real exit, and an entry already converted', async () => {
    const m = setup()
    const exit = await convertToCostTransfer(m.admin as any, who, 'e2')
    expect(exit.ok).toBe(false)
    await convertToCostTransfer(m.admin as any, who, 'e1')
    const again = await convertToCostTransfer(m.admin as any, who, 'e1')
    expect(!again.ok && again.error).toMatch(/already a cost transfer/)
  })
})
