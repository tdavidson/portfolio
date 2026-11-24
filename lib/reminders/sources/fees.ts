// Management fee periods coming due and not yet booked (lib/accounting/fee-periods.ts): from the
// vehicle's reminder lead time (default five days) before the due date, then on the day, then
// weekly while still unbooked. A drafted period counts too: its drafts are waiting for a person.
// Keys embed the due date, so moving it re-arms the reminder.

import { crossedThresholds, stateFor } from '../thresholds'
import { daysBetween } from '../dates'
import type { ReminderItem } from '../types'

export interface DueFeePeriod {
  id: string
  vehicleId: string
  vehicle: string
  start: string
  dueDate: string
  status: 'scheduled' | 'drafted'
  total: number
  /** Days before the due date to start listing it. */
  leadDays: number
  currency: string
}

export interface FeesData {
  periods: DueFeePeriod[]
}

export function feeDueReminders(data: FeesData, today: string): ReminderItem[] {
  return data.periods
    .filter(p => p.total > 0.005 && daysBetween(today, p.dueDate) <= p.leadDays)
    .map(p => {
      const amount = `${p.currency} ${p.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      return {
        source: 'fees_due' as const,
        keys: crossedThresholds(p.dueDate, today, [p.leadDays]).map(t => `mf:${p.id}:${p.dueDate}:${t}`),
        title: `Management fee — ${p.vehicle}: ${amount} ${p.status === 'drafted' ? 'drafted, waiting to be posted' : 'not yet booked'}`,
        detail: `Period from ${p.start}. Post it and issue its invoice from the fee schedule.`,
        dueDate: p.dueDate,
        state: stateFor(p.dueDate, today),
        href: `/funds/${p.vehicleId}/allocation-terms`,
      }
    })
}
