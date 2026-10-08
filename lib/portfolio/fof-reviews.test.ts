// lib/portfolio/fof-reviews.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const h = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./fof-nav', () => ({ saveNavStatement: h.save }))
import { approveFundReview, type FundReviewRow } from './fof-reviews'

const ALL = { vehicles: { all: true, ids: [] as string[] } }
const MEMBER = { vehicles: { all: false, ids: ['v1'] } }
const navReview = (over: Partial<FundReviewRow> = {}): FundReviewRow => ({
  id: 'r1', company_id: 'h1', vehicle_id: 'v1', issue_type: 'fund_nav',
  payload: { kind: 'nav', asOfDate: '2025-09-30', reportedNav: 9_445_000, fundName: 'Meridian', confidence: 'high', sourceText: null },
  ...over,
})
const callReview = (over: Partial<FundReviewRow> = {}): FundReviewRow => ({
  id: 'r2', company_id: 'h1', vehicle_id: 'v1', issue_type: 'fund_capital_call',
  payload: { kind: 'call', eventDate: '2025-09-30', dueDate: '2025-10-15', noticeNumber: 'Drawdown No. 7', purpose: 'Investments', amount: 1_250_000, dateAssumed: true, fundName: 'Meridian', confidence: 'high', sourceText: null },
  ...over,
})

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  h.save.mockReset().mockResolvedValue({ ok: true, navId: 'n1', booking: { status: 'booked', delta: 100, message: 'Saved, and its mark posted to the ledger.' } })
  m = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
    fund_capital_events: [], fund_nav_statements: [], chart_of_accounts: [],
  })
})
const ctx = (access = ALL) => ({ fundId: 'f', userId: 'u', access })

describe('approveFundReview', () => {
  it('approving a NAV saves it through the one NAV writer, for the review\'s entity', async () => {
    const r = await approveFundReview(m.admin, ctx(), navReview())
    expect(r).toEqual({ ok: true, vehicleId: 'v1', booking: expect.objectContaining({ status: 'booked' }), message: 'Saved, and its mark posted to the ledger.' })
    expect(h.save).toHaveBeenCalledWith(m.admin, 'f', 'u', { companyId: 'h1', vehicleId: 'v1', asOfDate: '2025-09-30', reportedNav: 9_445_000, source: 'extracted' })
  })

  it('approving a call records a DRAFT notice from the proposal, with the approver\'s corrections', async () => {
    const r = await approveFundReview(m.admin, ctx(), callReview(), { edits: { eventDate: '2025-08-12' } })
    expect(r).toMatchObject({ ok: true, vehicleId: 'v1', eventId: expect.any(String) })
    expect(m.tables.fund_capital_events).toEqual([expect.objectContaining({
      fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2025-08-12', due_date: '2025-10-15',
      notice_number: 'Drawdown No. 7', description: 'Investments', amount: 1_250_000, purpose_investments: 1_250_000,
      status: 'draft', source: 'extracted', created_by: 'u',
    })])
    expect(h.save).not.toHaveBeenCalled()
  })

  it('approving a distribution drafts it as a return of capital', async () => {
    const r = await approveFundReview(m.admin, ctx(), callReview({
      issue_type: 'fund_distribution',
      payload: { ...(callReview().payload as object), kind: 'distribution', amount: 400_000 },
    }))
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/draft distribution/) })
    expect(m.tables.fund_capital_events).toEqual([expect.objectContaining({
      kind: 'distribution', amount: 400_000, char_return_of_capital: 400_000, purpose_investments: 0, status: 'draft',
    })])
  })

  it('a review with no entity takes the approver\'s choice, and refuses one they cannot see', async () => {
    expect(await approveFundReview(m.admin, ctx(MEMBER), navReview({ vehicle_id: null }), { vehicleId: 'v2' }))
      .toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/access/) })
    expect(h.save).not.toHaveBeenCalled()
    expect(await approveFundReview(m.admin, ctx(MEMBER), navReview({ vehicle_id: null }), { vehicleId: 'v1' }))
      .toMatchObject({ ok: true, vehicleId: 'v1' })
  })

  it('a review naming an entity cannot be redirected to another by the approver', async () => {
    const r = await approveFundReview(m.admin, ctx(MEMBER), navReview(), { vehicleId: 'v2' })
    expect(r).toMatchObject({ ok: true, vehicleId: 'v1' })
    expect(h.save).toHaveBeenCalledWith(m.admin, 'f', 'u', expect.objectContaining({ vehicleId: 'v1' }))
  })

  it('another entity\'s review is not found', async () => {
    expect(await approveFundReview(m.admin, ctx(MEMBER), navReview({ vehicle_id: 'v2' }))).toMatchObject({ ok: false, status: 404 })
    expect(await approveFundReview(m.admin, ctx(MEMBER), callReview({ vehicle_id: 'v2' }))).toMatchObject({ ok: false, status: 404 })
    expect(h.save).not.toHaveBeenCalled()
    expect(m.tables.fund_capital_events).toEqual([])
  })

  it('refuses corrections that cannot be used', async () => {
    expect(await approveFundReview(m.admin, ctx(), callReview(), { edits: { amount: -5 } })).toMatchObject({ ok: false, status: 400 })
    expect(m.tables.fund_capital_events).toEqual([])
  })

  it('a refused NAV save is a refusal', async () => {
    h.save.mockResolvedValue({ ok: false, error: 'asOfDate must be a date (YYYY-MM-DD).' })
    expect(await approveFundReview(m.admin, ctx(), navReview())).toEqual({ ok: false, status: 400, error: 'asOfDate must be a date (YYYY-MM-DD).' })
  })

  it('refuses a review that is not a fund proposal', async () => {
    expect(await approveFundReview(m.admin, ctx(), navReview({ issue_type: 'low_confidence' }))).toMatchObject({ ok: false, status: 400 })
    expect(h.save).not.toHaveBeenCalled()
  })
})
