import { describe, expect, it } from 'vitest'
import {
  buildFeeBillEntry, buildManagerFeeEntry, feeBookings,
  applyFeePeriodEdit, buildFeeSliceEntry, draftFeePeriods, dueDateFor, feeInvoiceNumber, feeSlices, monthsIn,
  parseFeePeriodPatch, periodTotal,
} from './fee-periods'
import type { StoredFeeSchedule } from './fee-schedule'

const facts = { investments: [], exits: [], navs: [], organizationalExpenses: [], portfolioFees: [] }
const schedule: StoredFeeSchedule = {
  frequency: 'quarterly', start: '2025-01-01', end: '2026-01-01',
  steps: [{ from: '2025-01-01', rate: 0.02, basis: 'commitments' }],
}
const payers = [
  { lpEntityId: 'a', commitment: 1_000_000, rateOverride: null, exempt: false },
  { lpEntityId: 'b', commitment: 1_000_000, rateOverride: null, exempt: false },
  { lpEntityId: 'gp', commitment: 100_000, rateOverride: null, exempt: true },
]

describe('draftFeePeriods', () => {
  it('writes one period per quarter, due on its first day in advance', () => {
    const periods = draftFeePeriods(schedule, payers, facts)
    expect(periods.map(p => [p.start, p.end, p.dueDate])).toEqual([
      ['2025-01-01', '2025-04-01', '2025-01-01'],
      ['2025-04-01', '2025-07-01', '2025-04-01'],
      ['2025-07-01', '2025-10-01', '2025-07-01'],
      ['2025-10-01', '2026-01-01', '2025-10-01'],
    ])
    const q1 = periods[0]
    expect(q1.basisAmount).toBe(2_000_000)
    expect(q1.rate).toBe(0.02)
    expect(periodTotal(q1.lines)).toBe(10_000)
    expect(q1.lines.find(l => l.lpEntityId === 'gp')).toBeUndefined()
  })

  it('is due on the last day in arrears', () => {
    expect(draftFeePeriods({ ...schedule, timing: 'arrears' }, payers, facts)[0].dueDate).toBe('2025-03-31')
    expect(dueDateFor('2025-01-01', '2025-04-01', 'arrears')).toBe('2025-03-31')
  })

  it('charges a later closer nothing before it is admitted, then its catch-up in the first period it is in', () => {
    const periods = draftFeePeriods(schedule, payers, facts, new Map([['b', '2025-05-15']]))
    // Q1 and Q2 began before b was admitted: only a pays.
    expect(periods[0].lines.map(l => l.lpEntityId)).toEqual(['a'])
    expect(periods[1].lines.map(l => l.lpEntityId)).toEqual(['a'])
    expect(periods[1].basisAmount).toBe(1_000_000)
    // Q3: b pays its fee and the two quarters it missed.
    const q3 = periods[2]
    expect(q3.lines.filter(l => l.lpEntityId === 'b').map(l => [l.kind, l.amount])).toEqual([['fee', 5_000], ['catch_up', 10_000]])
    expect(q3.lines.find(l => l.kind === 'catch_up')?.note).toContain('2 earlier periods from 2025-01-01')
    expect(periodTotal(periods[3].lines)).toBe(10_000)
  })
})

describe('applyFeePeriodEdit', () => {
  const [q1] = draftFeePeriods(schedule, payers, facts)

  it('re-prices the fee from a new capital amount and rate', () => {
    const next = applyFeePeriodEdit(q1, { basisAmount: 3_000_000, rate: 0.015 })
    expect(periodTotal(next.lines)).toBe(11_250)
    expect(next.lines.every(l => l.rate === 0.015)).toBe(true)
  })

  it('rescales the partners to a typed fee, keeping their proportions', () => {
    const next = applyFeePeriodEdit(q1, { fee: 9_000.01 })
    expect(periodTotal(next.lines)).toBe(9_000.01)
  })

  it('keeps the extra lines when it re-prices the fee', () => {
    const withExtra = { ...q1, lines: [...q1.lines, { lpEntityId: 'a', kind: 'equalization' as const, basisAmount: null, rate: null, amount: 250, auto: false, note: null }] }
    const next = applyFeePeriodEdit(withExtra, { fee: 8_000 })
    expect(periodTotal(next.lines)).toBe(8_250)
  })

  it('takes typed lines as they are', () => {
    const next = applyFeePeriodEdit(q1, { lines: [{ lpEntityId: 'a', kind: 'fee', basisAmount: null, rate: null, amount: 1, auto: false, note: null }] })
    expect(next.lines).toHaveLength(1)
  })
})

describe('parseFeePeriodPatch', () => {
  it('refuses a bad kind, rate or date', () => {
    expect(parseFeePeriodPatch({ rate: 2 })).toHaveProperty('error')
    expect(parseFeePeriodPatch({ dueDate: '1/1/25' })).toHaveProperty('error')
    expect(parseFeePeriodPatch({ lines: [{ lpEntityId: 'a', kind: 'bonus', amount: 1 }] })).toHaveProperty('error')
  })
  it('marks typed lines as manual', () => {
    const p = parseFeePeriodPatch({ lines: [{ lpEntityId: 'a', kind: 'equalization', amount: '100.005' }] })
    expect('ok' in p && p.patch.lines?.[0]).toMatchObject({ kind: 'equalization', amount: 100.01, auto: false })
  })
})

describe('feeSlices', () => {
  const p = { start: '2025-01-01', end: '2025-04-01', dueDate: '2025-01-01', offset: 100, lines: [
    { lpEntityId: 'a', kind: 'fee' as const, basisAmount: null, rate: null, amount: 1000, auto: true, note: null },
    { lpEntityId: 'a', kind: 'catch_up' as const, basisAmount: null, rate: null, amount: 0.01, auto: true, note: null },
    { lpEntityId: 'b', kind: 'fee' as const, basisAmount: null, rate: null, amount: 1000, auto: true, note: null },
  ] }
  it('books once on the due date', () => {
    expect(feeSlices(p, false)).toEqual([{ date: '2025-01-01', offset: 100, lines: [{ lpEntityId: 'a', amount: 1000.01 }, { lpEntityId: 'b', amount: 1000 }] }])
  })
  it('accrues month by month to the cent', () => {
    const slices = feeSlices(p, true)
    expect(slices.map(s => s.date)).toEqual(['2025-01-31', '2025-02-28', '2025-03-31'])
    expect(periodTotal(slices.flatMap(s => s.lines))).toBe(2000.01)
    expect(slices.reduce((s, x) => s + x.offset, 0)).toBeCloseTo(100, 6)
  })
  it('counts months', () => {
    expect(monthsIn('2025-01-01', '2025-04-01')).toBe(3)
    expect(monthsIn('2025-01-01', '2026-01-01')).toBe(12)
  })
})

describe('buildFeeSliceEntry', () => {
  it('charges each partner its own lines through the bridge, offsets booked gross', () => {
    const e = buildFeeSliceEntry(
      { fundId: 'f', entryDate: '2025-01-01', memo: 'm', sourceRef: 'fee-period:p:2025-01-01' },
      { lines: [{ lpEntityId: 'a', amount: 600 }, { lpEntityId: 'b', amount: 400 }], offset: 50 },
      { expense: '5000', offset: '5010', payable: '2100', bridge: '3200' },
      new Map([['a', 'cap-a'], ['b', 'cap-b']]),
    )!
    expect(e.sourceType).toBe('management_fee')
    expect(e.postings.map(p => [p.accountId, p.amount])).toEqual([
      ['5000', 1050], ['5010', -50], ['2100', -1000], ['cap-a', 600], ['cap-b', 400], ['3200', -1000],
    ])
    expect(e.postings.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(0, 6)
  })
  it('books nothing for a zero period', () => {
    expect(buildFeeSliceEntry({ fundId: 'f', entryDate: 'x', memo: 'm', sourceRef: 'r' }, { lines: [], offset: 0 }, { expense: '1', offset: null, payable: '2', bridge: '3' }, new Map())).toBeNull()
  })
})

it('numbers invoices by period and vehicle, with a suffix after a void', () => {
  expect(feeInvoiceNumber('2025-04-01', 'abcdef12-3456', 0)).toBe('MF-20250401-ABCDEF')
  expect(feeInvoiceNumber('2025-04-01', 'abcdef12-3456', 1)).toBe('MF-20250401-ABCDEF-2')
})

describe('the LPA fee schedule', () => {
  it('dates each step from the initial closing', async () => {
    const { coerceFeeScheduleReading, lpaFeeScheduleToStored } = await import('./lpa-terms')
    const reading = coerceFeeScheduleReading({
      frequency: 'quarterly', timing: 'advance', termYears: 10,
      steps: [{ afterYears: 5, rate: 1.5, basis: 'invested' }, { afterYears: 0, rate: 0.02, basis: 'committed' }],
    })!
    expect(reading.steps.map(s => s.afterYears)).toEqual([0, 5])
    const { schedule, warnings } = lpaFeeScheduleToStored(reading, '2024-03-15')
    expect(warnings).toEqual([])
    expect(schedule).toEqual({
      frequency: 'quarterly', timing: 'advance', start: '2024-03-15', end: '2034-03-15',
      steps: [{ from: '2024-03-15', rate: 0.02, basis: 'commitments' }, { from: '2029-03-15', rate: 0.015, basis: 'invested' }],
    })
  })
  it('refuses a schedule with no first rate and warns when there is no term', async () => {
    const { coerceFeeScheduleReading, lpaFeeScheduleToStored } = await import('./lpa-terms')
    expect(coerceFeeScheduleReading({ steps: [{ afterYears: 3, rate: 0.02, basis: 'committed' }] })).toBeNull()
    const r = coerceFeeScheduleReading({ steps: [{ afterYears: 0, rate: 0.02, basis: 'nav' }] })!
    expect(lpaFeeScheduleToStored(r, '2024-01-01').warnings[0]).toContain('ten years')
  })
})

describe('spreading a fee billed in advance', () => {
  const p = { start: '2025-01-01', end: '2025-04-01', dueDate: '2025-01-01', offset: 0, lines: [
    { lpEntityId: 'a', kind: 'fee' as const, basisAmount: null, rate: null, amount: 3000, auto: true, note: null },
  ] }
  it('bills the quarter on its due date, then recognizes it month by month', () => {
    const plan = feeBookings(p, true, 'advance')
    expect(plan.map(b => [b.kind, b.date, b.lines[0].amount])).toEqual([
      ['bill', '2025-01-01', 3000], ['recognize', '2025-01-31', 1000], ['recognize', '2025-02-28', 1000], ['recognize', '2025-03-31', 1000],
    ])
  })
  it('accrues month by month when billed in arrears, and charges once without spreading', () => {
    expect(feeBookings(p, true, 'arrears').map(b => b.kind)).toEqual(['charge', 'charge', 'charge'])
    expect(feeBookings(p, false, 'advance').map(b => [b.kind, b.date])).toEqual([['charge', '2025-01-01']])
  })
  it('books the bill to prepaid fees on the fund and deferred revenue on the manager', () => {
    const base = { fundId: 'f', entryDate: '2025-01-01', memo: 'm', sourceRef: 'r' }
    expect(buildFeeBillEntry(base, 3000, { prepaid: '1500', payable: '2150' })!.postings.map(x => [x.accountId, x.amount])).toEqual([['1500', 3000], ['2150', -3000]])
    const m = { receivable: '1900', income: '4000', deferred: '2400' }
    expect(buildManagerFeeEntry(base, 'bill', 3000, m)!.postings.map(x => [x.accountId, x.amount])).toEqual([['1900', 3000], ['2400', -3000]])
    expect(buildManagerFeeEntry(base, 'recognize', 1000, m)!.postings.map(x => [x.accountId, x.amount])).toEqual([['2400', 1000], ['4000', -1000]])
    expect(buildManagerFeeEntry(base, 'charge', 1000, m)!.postings.map(x => [x.accountId, x.amount])).toEqual([['1900', 1000], ['4000', -1000]])
  })
  it('recognizes a month out of prepaid fees, each partner charged its share', () => {
    const e = buildFeeSliceEntry({ fundId: 'f', entryDate: '2025-01-31', memo: 'm', sourceRef: 'r' },
      { lines: [{ lpEntityId: 'a', amount: 1000 }], offset: 0 },
      { expense: '5000', offset: null, payable: '1500', bridge: '3200' }, new Map([['a', 'cap-a']]))!
    expect(e.postings.map(x => [x.accountId, x.amount])).toEqual([['5000', 1000], ['1500', -1000], ['cap-a', 1000], ['3200', -1000]])
  })
})
