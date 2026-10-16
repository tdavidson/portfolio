// The agent tools update_investment / delete_investment run the same edit as the company page's
// edit/delete: ledger retracted first, then re-derived (or gone), and the same refusals.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ retract: vi.fn(), redraft: vi.fn() }))
vi.mock('@/lib/accounting/from-portfolio', () => ({ retractEntriesForTransaction: s.retract, draftEntryForTransaction: s.redraft }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'

const everyEntity = { fundId: 'f', vehicles: { all: true, ids: [] } } as any
let m: any
const ctx = () => ({ admin: m.admin, fundId: 'f', portfolioGroup: '', userId: 'u', access: everyEntity })

beforeEach(() => {
  s.retract.mockReset().mockResolvedValue({ retracted: 1 })
  s.redraft.mockReset().mockResolvedValue({ drafted: true, posted: true })
  m = memoryAdmin({
    companies: [{ id: 'c1', fund_id: 'f', name: 'Example Holdings, Ltd' }],
    investment_transactions: [
      { id: 't1', fund_id: 'f', company_id: 'c1', transaction_type: 'unrealized_gain_change', portfolio_group: 'Fund III',
        transaction_date: '2026-09-30', unrealized_value_change: -147.59, current_share_price: 7.31 },
      { id: 't-nav', fund_id: 'f', company_id: 'c1', transaction_type: 'unrealized_gain_change', portfolio_group: 'Fund III' },
    ],
    fund_nav_statements: [{ id: 'n1', fund_id: 'f', investment_transaction_id: 't-nav' }],
    fund_capital_events: [],
  })
})

describe('update_investment', () => {
  it('turns a mark into an FX revaluation and re-derives its entry', async () => {
    const out: any = await PORTFOLIO_HANDLERS.update_investment(ctx(), {
      company: 'c1', transaction_id: 't1', valuation_change_source: 'fx',
      fx_rate: 1.326, prior_fx_rate: 1.3264, original_position_value: 399996.89, original_currency: 'GBP',
    })
    const row = m.tables.investment_transactions.find((t: any) => t.id === 't1')
    expect(row.valuation_change_source).toBe('fx')
    expect(row.fx_rate).toBe(1.326)
    expect(row.unrealized_value_change).toBe(-147.59)
    expect(s.retract).toHaveBeenCalledOnce()
    expect(s.redraft).toHaveBeenCalledOnce()
    expect(out.ledger).toMatchObject({ drafted: true })
  })

  it('copies the value change into fx_value_change when it is passed with fx', async () => {
    await PORTFOLIO_HANDLERS.update_investment(ctx(), {
      company: 'c1', transaction_id: 't1', valuation_change_source: 'fx', unrealized_value_change: -100,
    })
    expect(m.tables.investment_transactions.find((t: any) => t.id === 't1').fx_value_change).toBe(-100)
  })

  it('refuses a field it cannot edit, and a transaction the fund register owns', async () => {
    await expect(PORTFOLIO_HANDLERS.update_investment(ctx(), { company: 'c1', transaction_id: 't1', fund_id: 'g' }))
      .rejects.toThrow(/Not an editable field: fund_id/)
    await expect(PORTFOLIO_HANDLERS.update_investment(ctx(), { company: 'c1', transaction_id: 't-nav', notes: 'x' }))
      .rejects.toThrow(/manager NAV statement/)
    expect(s.retract).not.toHaveBeenCalled()
  })

  it('does not reach another company\'s transaction', async () => {
    m.tables.companies.push({ id: 'c2', fund_id: 'f', name: 'Other' })
    await expect(PORTFOLIO_HANDLERS.update_investment(ctx(), { company: 'c2', transaction_id: 't1', notes: 'x' }))
      .rejects.toThrow(/Transaction not found/)
  })
})

describe('delete_investment', () => {
  it('retracts the entry, then deletes the row', async () => {
    const out: any = await PORTFOLIO_HANDLERS.delete_investment(ctx(), { company: 'c1', transaction_id: 't1' })
    expect(out.deleted).toBe('t1')
    expect(m.tables.investment_transactions.map((t: any) => t.id)).toEqual(['t-nav'])
    expect(s.retract).toHaveBeenCalledOnce()
  })

  it('keeps the row when the ledger refuses (a closed period)', async () => {
    s.retract.mockResolvedValue({ retracted: 0, reason: 'Its entry is in a closed period.' })
    await expect(PORTFOLIO_HANDLERS.delete_investment(ctx(), { company: 'c1', transaction_id: 't1' }))
      .rejects.toThrow(/closed period/)
    expect(m.tables.investment_transactions).toHaveLength(2)
  })
})
