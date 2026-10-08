// lib/portfolio/fof-nav.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

/**
 * A fake ledger for one holding: `base` is what other entries carry (cost from calls), `booked` is
 * the marks derivation posted, keyed by transaction id so a retract takes one back.
 */
const h = vi.hoisted(() => ({
  base: [] as { accountId: string; amount: number; date: string }[],
  booked: new Map<string, { amount: number; date: string }>(),
  closed: null as string | null,
  retractRefuses: null as string | null,
  derive: vi.fn(),
  retract: vi.fn(),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({
  vehicleIdByName: async (_a: unknown, _f: string, g: string) => (g === 'Fund I' ? 'v1' : g === 'Fund II' ? 'v2' : null),
  vehicleNameById: async (_a: unknown, _f: string, id: string) => (id === 'v1' ? 'Fund I' : id === 'v2' ? 'Fund II' : null),
}))
vi.mock('@/lib/accounting/load', () => ({
  loadPostedLedger: async (_a: unknown, _f: string, _g: string, asOf?: string) => ({
    accounts: [{ id: 'cost', companyId: 'h1', subtype: 'investment' }, { id: 'mark', companyId: 'h1', subtype: 'unrealized' }],
    postings: [
      ...h.base.filter(p => !asOf || p.date <= asOf),
      ...Array.from(h.booked.values()).filter(b => !asOf || b.date <= asOf).map(b => ({ accountId: 'mark', amount: b.amount })),
    ],
  }),
}))
vi.mock('@/lib/accounting/from-portfolio', () => ({
  draftEntryForTransaction: h.derive,
  retractEntriesForTransaction: h.retract,
}))
import { bookNavMark, deleteNavStatement, editNavStatement, rebookNavsFrom, saveNavStatement, type NavInput } from './fof-nav'

let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  h.base = [{ accountId: 'cost', amount: 1000, date: '2026-01-15' }]
  h.booked.clear()
  h.closed = null
  h.retractRefuses = null
  h.derive.mockReset().mockImplementation(async (_a: unknown, _f: string, _u: string, txn: any) => {
    if (h.closed && txn.transaction_date <= h.closed) return { drafted: false, reason: `Entry date ${txn.transaction_date} falls in a closed period.` }
    h.booked.set(txn.id, { amount: txn.unrealized_value_change, date: txn.transaction_date })
    return { drafted: true, posted: true, entryId: `e-${txn.id}` }
  })
  h.retract.mockReset().mockImplementation(async (_a: unknown, _f: string, txnId: string) => {
    if (h.retractRefuses) return { retracted: 0, reason: h.retractRefuses }
    h.booked.delete(txnId)
    return { retracted: 1 }
  })
  m = memoryAdmin({
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
    fund_holding_terms: [{ fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', commitment: 5000 }],
    fund_capital_events: [{ id: 'ev1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2026-01-15', amount: 1000, status: 'confirmed' }],
    fund_nav_statements: [], investment_transactions: [], chart_of_accounts: [], vehicle_accounting_settings: [],
  }, { unique: [{ table: 'fund_nav_statements', key: r => `${r.company_id}|${r.vehicle_id ?? ''}|${r.as_of_date}` }] })
})

const nav = (over: Partial<NavInput> = {}) =>
  saveNavStatement(m.admin, 'f', 'u', { companyId: 'h1', vehicleId: 'v1', asOfDate: '2026-03-31', reportedNav: 1200, ...over })
/** What the ledger carries for the holding at a date: cost plus every mark booked. */
const carried = (asOf = '9999-12-31') =>
  h.base.filter(p => p.date <= asOf).reduce((s, p) => s + p.amount, 0)
  + Array.from(h.booked.values()).filter(b => b.date <= asOf).reduce((s, b) => s + b.amount, 0)
const navId = (r: Awaited<ReturnType<typeof nav>>) => (r.ok ? r.navId : '')

describe('saveNavStatement', () => {
  it('books the mark the statement implies, dated as of the statement, and links it', async () => {
    const r = await nav()
    expect(r).toMatchObject({ ok: true, booking: { status: 'booked', delta: 200, posted: true } })
    const [t] = m.tables.investment_transactions
    expect(t).toMatchObject({
      transaction_type: 'unrealized_gain_change', transaction_date: '2026-03-31', unrealized_value_change: 200,
      valuation_change_source: 'nav', portfolio_group: 'Fund I', company_id: 'h1', fund_id: 'f',
    })
    expect(m.tables.fund_nav_statements[0]).toMatchObject({ vehicle_id: 'v1', reported_nav: 1200, investment_transaction_id: t.id })
    expect(carried()).toBe(1200)
  })

  it('saving the same date again replaces the statement and re-derives its mark', async () => {
    await nav()
    const first = m.tables.investment_transactions[0]
    const r = await nav({ reportedNav: 1300 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'booked', delta: 300 } })
    expect(h.retract).toHaveBeenCalledWith(m.admin, 'f', first.id, { userId: 'u', original: expect.objectContaining({ id: first.id }) })
    expect(m.tables.fund_nav_statements).toHaveLength(1)
    expect(m.tables.investment_transactions.map((t: any) => t.unrealized_value_change)).toEqual([300])
    expect(carried()).toBe(1300)
  })

  it('books nothing when the ledger already carries the statement', async () => {
    const r = await nav({ reportedNav: 1000 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'no_change' } })
    expect(m.tables.investment_transactions).toEqual([])
  })

  it('saves a statement with no entity, books nothing, and says so', async () => {
    const r = await nav({ vehicleId: null })
    expect(r).toMatchObject({ ok: true, booking: { status: 'no_entity', message: expect.stringMatching(/no entity/i) } })
    expect(m.tables.fund_nav_statements).toHaveLength(1)
    expect(h.derive).not.toHaveBeenCalled()
  })

  it('keeps the statement and drops the mark when its period is closed, with the reason', async () => {
    h.closed = '2026-03-31'
    const r = await nav()
    expect(r).toMatchObject({ ok: true, booking: { status: 'refused', message: expect.stringMatching(/closed period/) } })
    expect(m.tables.fund_nav_statements[0].investment_transaction_id ?? null).toBeNull()
    expect(m.tables.investment_transactions).toEqual([])
  })

  it('a re-save whose earlier mark is in a closed period leaves that mark and its link alone', async () => {
    await nav()
    h.retractRefuses = 'Its journal entry is dated 2026-03-31, inside a closed period.'
    const r = await nav({ reportedNav: 1300 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'refused', message: expect.stringMatching(/closed period/) } })
    expect(m.tables.fund_nav_statements[0].reported_nav).toBe(1300)
    expect(m.tables.fund_nav_statements[0].investment_transaction_id).toBe(m.tables.investment_transactions[0].id)
    expect(carried()).toBe(1200)
  })

  it('records a statement dated before the ledger starts without booking it', async () => {
    m.tables.vehicle_accounting_settings.push({ fund_id: 'f', vehicle_id: 'v1', ledger_start_date: '2026-06-30' })
    const r = await nav()
    expect(r).toMatchObject({ ok: true, booking: { status: 'before_ledger_start' } })
    expect(m.tables.investment_transactions).toEqual([])
  })

  it('books a holding whose only activity for the entity is the statement itself', async () => {
    m.tables.fund_holding_terms = []
    m.tables.fund_capital_events = []
    h.base = []
    const r = await nav({ reportedNav: 500 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'booked', delta: 500 } })
  })

  it('refuses a NAV that is not a number, or a date that is not a date', async () => {
    expect(await nav({ reportedNav: Number.NaN })).toMatchObject({ ok: false })
    expect(await nav({ asOfDate: '31/03/2026' })).toMatchObject({ ok: false })
    expect(m.tables.fund_nav_statements).toEqual([])
  })
})

describe('editing and deleting a statement', () => {
  it('editing re-derives the mark', async () => {
    const saved = await nav()
    const r = await editNavStatement(m.admin, 'f', 'u', navId(saved), { reportedNav: 1100 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'booked', delta: 100 } })
    expect(carried()).toBe(1100)
  })

  it('editing an older statement re-books the newest one, so the books end at the newest NAV', async () => {
    const q1 = await nav()                                       // +200 at March
    await nav({ asOfDate: '2026-06-30', reportedNav: 1500 })     // +300 at June
    const r = await editNavStatement(m.admin, 'f', 'u', navId(q1), { reportedNav: 1100 })
    expect(r).toMatchObject({ ok: true, booking: { delta: 100 }, later: [{ status: 'booked', delta: 400 }] })
    expect(carried('2026-03-31')).toBe(1100)
    expect(carried('2026-06-30')).toBe(1500)
  })

  it('editing the first of three statements re-books the two after it, oldest first, each correct', async () => {
    const q1 = await nav()                                       // 1200 at March
    await nav({ asOfDate: '2026-06-30', reportedNav: 1500 })
    await nav({ asOfDate: '2026-09-30', reportedNav: 1800 })
    const r = await editNavStatement(m.admin, 'f', 'u', navId(q1), { reportedNav: 1100 })
    expect(r).toMatchObject({ ok: true, later: [{ status: 'booked', delta: 400 }, { status: 'no_change' }] })
    expect(carried('2026-03-31')).toBe(1100)
    expect(carried('2026-06-30')).toBe(1500)
    expect(carried('2026-09-30')).toBe(1800)
    expect(h.booked.size).toBe(3)
  })

  it('a closed period on a middle statement does not stop the ones after it, and is reported', async () => {
    const q1 = await nav()
    await nav({ asOfDate: '2026-06-30', reportedNav: 1500 })
    await nav({ asOfDate: '2026-09-30', reportedNav: 1800 })
    const midTxn = (m.tables.fund_nav_statements as any[]).find(n => n.as_of_date === '2026-06-30').investment_transaction_id
    h.retract.mockImplementation(async (_a: unknown, _f: string, txnId: string) => {
      if (txnId === midTxn) return { retracted: 0, reason: 'Its journal entry is dated 2026-06-30, inside a closed period.' }
      h.booked.delete(txnId)
      return { retracted: 1 }
    })
    const r = await editNavStatement(m.admin, 'f', 'u', navId(q1), { reportedNav: 1100 })
    expect(r).toMatchObject({ ok: true, later: [{ status: 'refused', message: expect.stringMatching(/closed period/) }, { status: 'booked' }] })
    expect(carried('2026-09-30')).toBe(1800)
  })

  it('re-saving identical figures, or editing only the received date, posts nothing and ignores a closed period', async () => {
    const saved = await nav()
    h.derive.mockClear(); h.retract.mockClear()
    h.retractRefuses = 'Its journal entry is dated 2026-03-31, inside a closed period.'
    const again = await nav()
    expect(again).toMatchObject({ ok: true, booking: { status: 'no_change', transactionId: expect.any(String) } })
    const edit = await editNavStatement(m.admin, 'f', 'u', navId(saved), { receivedDate: '2026-05-01' })
    expect(edit).toMatchObject({ ok: true, booking: { status: 'no_change' } })
    expect(h.derive).not.toHaveBeenCalled()
    expect(h.retract).not.toHaveBeenCalled()
    expect(m.tables.fund_nav_statements[0].received_date).toBe('2026-05-01')
    expect(carried()).toBe(1200)
  })

  it('refuses an invalid basis on edit instead of coercing it', async () => {
    const saved = await nav()
    const r = await editNavStatement(m.admin, 'f', 'u', navId(saved), { basis: 'bogus' as any })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/basis/) })
  })

  it('says the earlier mark was taken back when the re-booking then fails', async () => {
    const saved = await nav()
    h.closed = '2026-03-31'
    const r = await editNavStatement(m.admin, 'f', 'u', navId(saved), { reportedNav: 1300 })
    expect(r).toMatchObject({ ok: true, booking: { status: 'refused', message: expect.stringMatching(/earlier mark was taken back/) } })
  })

  it('deleting retracts the mark and removes the transaction and the statement', async () => {
    const saved = await nav()
    const r = await deleteNavStatement(m.admin, 'f', 'u', navId(saved))
    expect(r).toEqual({ ok: true })
    expect(m.tables.fund_nav_statements).toEqual([])
    expect(m.tables.investment_transactions).toEqual([])
    expect(carried()).toBe(1000)
  })

  it('deleting refuses, and keeps everything, when the mark cannot be taken back', async () => {
    const saved = await nav()
    h.retractRefuses = 'Its journal entry is dated 2026-03-31, inside a closed period.'
    const r = await deleteNavStatement(m.admin, 'f', 'u', navId(saved))
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/closed period/) })
    expect(m.tables.fund_nav_statements).toHaveLength(1)
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
})

describe('rebookNavsFrom', () => {
  it('returns an empty list when nothing is dated then', async () => {
    expect(await rebookNavsFrom(m.admin, 'f', 'u', { companyId: 'h1', vehicleId: 'v1', since: '2026-04-01', inclusive: true })).toEqual([])
  })
})

describe('re-booking from a date', () => {
  it('re-derives the statement on or after a date — a call confirmed late, dated before it', async () => {
    await nav()                                                          // +200 against 1000
    h.base.push({ accountId: 'cost', amount: 100, date: '2026-02-01' })  // the late call's entry
    const r = await rebookNavsFrom(m.admin, 'f', 'u', { companyId: 'h1', vehicleId: 'v1', since: '2026-02-01', inclusive: true })
    expect(r).toMatchObject([{ status: 'booked', delta: 100 }])
    expect(carried()).toBe(1200)
  })
})

/** The admin client, with every select on `table` failing. */
function failingReads(admin: any, table: string) {
  const failed: any = new Proxy({}, {
    get: (_t, k) => k === 'then'
      ? (res: any, rej: any) => Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(res, rej)
      : () => failed,
  })
  return new Proxy(admin, { get: (t, k) => k === 'from' ? (name: string) => (name === table ? { select: () => failed } : t.from(name)) : t[k] })
}

describe('a mark that cannot be derived', () => {
  it('books nothing when the register cannot be loaded, and keeps the earlier mark', async () => {
    const saved = await nav()
    const before = m.tables.investment_transactions[0].id
    m.tables.fund_nav_statements[0].reported_nav = 1300
    const r = await bookNavMark(failingReads(m.admin, 'fund_capital_events'), 'f', 'u', navId(saved))
    expect(r).toMatchObject({ status: 'refused', message: expect.stringMatching(/not booked: The fund register could not be loaded: connection reset/) })
    expect(h.retract).not.toHaveBeenCalled()
    expect(m.tables.investment_transactions.map((t: any) => t.id)).toEqual([before])
    expect(carried()).toBe(1200)
  })

  it('books nothing when the position does not carry this statement', async () => {
    const saved = await nav()
    h.retract.mockClear()
    // The register's position values the holding off a different figure than the statement says.
    const admin = new Proxy(m.admin, { get: (t: any, k) => k === 'from' ? (name: string) => {
      const q = t.from(name)
      if (name !== 'fund_nav_statements') return q
      return { ...q, select: (...a: any[]) => {
        const sel = q.select(...a)
        const then = sel.then.bind(sel)
        sel.then = (res: any, rej: any) => then((r: any) => res({ ...r, data: (r.data ?? []).map((n: any) => ({ ...n, reported_nav: 999 })) }), rej)
        return sel
      } }
    } : t[k] })
    const r = await bookNavMark(admin, 'f', 'u', navId(saved))
    expect(r).toMatchObject({ status: 'refused', message: expect.stringMatching(/could not be derived from the fund register; nothing was booked/) })
    expect(h.retract).not.toHaveBeenCalled()
    expect(carried()).toBe(1200)
  })
})

describe('replacing a recorded NAV', () => {
  it('says which NAV it replaced, and keeps the recorded basis unless one is given', async () => {
    await nav({ basis: 'preliminary' })
    const r = await nav({ reportedNav: 1300 })
    expect(r).toMatchObject({ ok: true, replacedNav: 1200, booking: { message: expect.stringMatching(/replaced the NAV of 1,200 already recorded for 2026-03-31/) } })
    expect(m.tables.fund_nav_statements[0].basis).toBe('preliminary')
    await nav({ reportedNav: 1300, basis: 'final' })
    expect(m.tables.fund_nav_statements[0].basis).toBe('final')
  })

  it('says nothing about replacing when the figure is the same', async () => {
    await nav()
    const r = await nav()
    expect(r.ok && r.replacedNav).toBeFalsy()
    expect(r.ok && r.booking.message).not.toMatch(/replaced/)
  })
})

describe('the statement\'s link to its mark', () => {
  it('a link that cannot be set after posting is reported, not hidden', async () => {
    m = memoryAdmin({ ...m.tables }, {
      before: (table, op, payload) => {
        if (table === 'fund_nav_statements' && op === 'update' && payload?.investment_transaction_id) m.failNext(table, op, 'connection reset')
      },
    })
    const r = await nav()
    expect(r).toMatchObject({ ok: true, booking: { status: 'booked', message: expect.stringMatching(/could not be linked to its mark/) } })
  })

  it('a link that cannot be cleared after taking a mark back refuses, and says so', async () => {
    const saved = await nav()
    const tables = m.tables
    m = memoryAdmin({ ...tables }, {
      before: (table, op, payload) => {
        if (table === 'fund_nav_statements' && op === 'update' && payload && 'investment_transaction_id' in payload && payload.investment_transaction_id === null) {
          m.failNext(table, op, 'connection reset')
        }
      },
    })
    const r = await deleteNavStatement(m.admin, 'f', 'u', navId(saved))
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/could not be updated/) })
    expect(m.tables.fund_nav_statements).toHaveLength(1)
  })
})
