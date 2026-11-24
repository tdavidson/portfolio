import { describe, expect, it } from 'vitest'
import { buildRecurringEntry, cadenceLabel, nextOccurrence, occurrenceDates, parseRecurringInput, renderMemo } from './recurring-entries'
import { bookingPart } from './fee-periods'
import { recurringDueReminders } from '@/lib/reminders/sources/recurring'

const monthly = { frequency: 'monthly' as const, dayOfMonth: 31, startDate: '2026-01-01', endDate: null }

describe('occurrenceDates', () => {
  it('lands on the last day of each month, clamped', () => {
    expect(occurrenceDates(monthly, '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })
  it('counts quarters from the start month and stops at the end date', () => {
    const q = { frequency: 'quarterly' as const, dayOfMonth: 1, startDate: '2026-02-01', endDate: '2026-12-31' }
    expect(occurrenceDates(q, '2026-01-01', '2027-12-31')).toEqual(['2026-02-01', '2026-05-01', '2026-08-01', '2026-11-01'])
  })
  it('never lists a date before the start date', () => {
    expect(occurrenceDates({ frequency: 'monthly', dayOfMonth: 1, startDate: '2026-03-15', endDate: null }, '2026-01-01', '2026-05-31'))
      .toEqual(['2026-04-01', '2026-05-01'])
  })
  it('jumps straight to a window years after the start', () => {
    const a = { frequency: 'annual' as const, dayOfMonth: 31, startDate: '2010-12-01', endDate: null }
    expect(occurrenceDates(a, '2026-01-01', '2027-12-31')).toEqual(['2026-12-31', '2027-12-31'])
  })
  it('finds the next due date', () => {
    expect(nextOccurrence(monthly, '2026-01-31')).toBe('2026-02-28')
    expect(nextOccurrence({ ...monthly, endDate: '2026-02-01' }, '2026-01-31')).toBeNull()
  })
})

it('describes the cadence', () => {
  expect(cadenceLabel(monthly)).toBe('Monthly on the last day')
  expect(cadenceLabel({ frequency: 'quarterly', dayOfMonth: 15, startDate: '2026-03-01' })).toBe('Quarterly on day 15, from March')
})

it('fills memo placeholders per date', () => {
  expect(renderMemo('Accrual, {month} ({quarter}, {year}) {date}', '2026-11-30')).toBe('Accrual, November 2026 (Q4 2026, 2026) 2026-11-30')
  expect(renderMemo('Plain memo', '2026-11-30')).toBe('Plain memo')
})

describe('parseRecurringInput', () => {
  const base = { name: 'Audit accrual', frequency: 'monthly', dayOfMonth: 'last', startDate: '2026-01-01', lines: [{ accountId: 'a', amount: 500 }, { accountId: 'b', amount: -500 }] }
  it('accepts a balanced entry', () => {
    const r = parseRecurringInput(base)
    expect('ok' in r && r.value.dayOfMonth).toBe(31)
  })
  it('refuses unbalanced or one-line entries', () => {
    expect(parseRecurringInput({ ...base, lines: [{ accountId: 'a', amount: 500 }, { accountId: 'b', amount: -400 }] })).toEqual({ error: expect.stringContaining('balance') })
    expect(parseRecurringInput({ ...base, lines: [{ accountId: 'a', amount: 500 }] })).toEqual({ error: expect.stringContaining('two lines') })
  })
  it('refuses a bad cadence or mode', () => {
    expect('error' in parseRecurringInput({ ...base, frequency: 'weekly' })).toBe(true)
    expect('error' in parseRecurringInput({ ...base, mode: 'sometimes' })).toBe(true)
    expect('error' in parseRecurringInput({ ...base, endDate: '2025-12-31' })).toBe(true)
  })
  it('checks only what an update gives', () => {
    expect(parseRecurringInput({ mode: 'post' }, true)).toEqual({ ok: true, value: { mode: 'post' } })
  })
})

it('books each occurrence with its own reference and memo', () => {
  const e = buildRecurringEntry('f', { id: 's1', name: 'Audit accrual', memo: 'Audit accrual, {month}', sourceType: 'partnership_expense', lines: [
    { accountId: 'x', amount: 250, lpEntityId: null }, { accountId: 'y', amount: -250, lpEntityId: null },
  ] }, '2026-03-31')
  expect(e.sourceRef).toBe('schedule:s1:2026-03-31')
  expect(e.memo).toBe('Audit accrual, March 2026')
  expect(e.postings.map(p => p.amount)).toEqual([250, -250])
})

it('splits the fee bookings between the fee schedule and the monthly spread', () => {
  expect(bookingPart({ kind: 'bill' }, true)).toBe('schedule')
  expect(bookingPart({ kind: 'recognize' }, true)).toBe('months')
  expect(bookingPart({ kind: 'charge' }, true)).toBe('months')
  expect(bookingPart({ kind: 'charge' }, false)).toBe('schedule')
})

it('reminds of due and drafted recurring entries, linking to the Recurring tab', () => {
  const items = recurringDueReminders({ entries: [
    { id: 's1', vehicleId: 'v1', vehicle: 'Example Fund I', name: 'Audit accrual', date: '2026-03-31', amount: 250, status: 'due', leadDays: 3, currency: 'USD' },
    { id: 's2', vehicleId: 'v1', vehicle: 'Example Fund I', name: 'Interest', date: '2026-03-31', amount: 10, status: 'drafted', leadDays: 3, currency: 'USD' },
  ] }, '2026-03-29')
  expect(items.map(i => i.title)).toEqual([
    'Audit accrual — Example Fund I: USD 250.00 not yet booked',
    'Interest — Example Fund I: USD 10.00 drafted, waiting to be posted',
  ])
  expect(items[0].href).toBe('/funds/v1/journal?tab=recurring')
  expect(items[0].keys[0]).toMatch(/^rje:s1:2026-03-31:/)
})
