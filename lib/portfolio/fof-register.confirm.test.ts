import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const h = vi.hoisted(() => ({ derive: vi.fn(), rebook: vi.fn() }))
vi.mock('@/lib/accounting/from-portfolio', () => ({ draftEntryForTransaction: h.derive }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleNameById: async () => 'Fund I' }))
vi.mock('./fof-nav', () => ({ rebookNavsFrom: h.rebook }))
import { confirmFundCapitalEvent } from './fof-register'

const bookings = [
  { status: 'booked', delta: -100, message: 'Saved, and its mark posted to the ledger.' },
  { status: 'no_change', delta: 0, message: 'No change in value.' },
]

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  h.derive.mockReset().mockResolvedValue({ drafted: true, posted: true, entryId: 'e1' })
  h.rebook.mockReset().mockResolvedValue(bookings)
  m = memoryAdmin({
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
    fund_capital_events: [{
      id: 'ev1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2026-02-01', amount: 100,
      purpose_investments: 100, purpose_fees: 0, purpose_expenses: 0, status: 'draft', investment_transaction_id: null,
    }],
    investment_transactions: [], vehicle_accounting_settings: [],
  })
})

describe('confirming a capital event', () => {
  it('re-books every statement for that holding and entity dated on or after the event', async () => {
    const r = await confirmFundCapitalEvent(m.admin, 'f', 'u', 'ev1')
    expect(r).toMatchObject({ ok: true, navRebooked: bookings })
    expect(h.rebook).toHaveBeenCalledWith(m.admin, 'f', 'u', { companyId: 'h1', vehicleId: 'v1', since: '2026-02-01', inclusive: true })
  })

  it('omits navRebooked when no statement needed re-booking', async () => {
    h.rebook.mockResolvedValue([])
    const r = await confirmFundCapitalEvent(m.admin, 'f', 'u', 'ev1')
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('navRebooked')
  })

  it('re-books nothing when the event itself did not reach the ledger', async () => {
    h.derive.mockResolvedValue({ drafted: false, reason: 'Entry date falls in a closed period.' })
    const r = await confirmFundCapitalEvent(m.admin, 'f', 'u', 'ev1')
    expect(r).toMatchObject({ ok: true, ledgerSkipped: 'Entry date falls in a closed period.' })
    expect(h.rebook).not.toHaveBeenCalled()
  })

  it('re-books nothing for a memo-only event before the ledger starts', async () => {
    m.tables.vehicle_accounting_settings.push({ fund_id: 'f', vehicle_id: 'v1', ledger_start_date: '2026-06-30' })
    const r = await confirmFundCapitalEvent(m.admin, 'f', 'u', 'ev1')
    expect(r).toMatchObject({ ok: true, skipped: 'before_ledger_start' })
    expect(h.rebook).not.toHaveBeenCalled()
  })
})
