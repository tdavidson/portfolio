// Recurring journal entries coming due and not yet booked (lib/accounting/recurring-entries.ts):
// an entry in remind mode from its lead time (default three days) before each due date, then on the
// day, then weekly while still unbooked; and a draft the daily run saved, until a person posts it.
// Keys embed the date, so each occurrence is reminded on its own.

import { crossedThresholds, stateFor } from '../thresholds'
import type { ReminderItem } from '../types'

export interface DueRecurringEntry {
  id: string
  vehicleId: string
  vehicle: string
  name: string
  date: string
  amount: number
  status: 'due' | 'drafted'
  leadDays: number
  currency: string
}

export interface RecurringData {
  entries: DueRecurringEntry[]
}

export function recurringDueReminders(data: RecurringData, today: string): ReminderItem[] {
  return data.entries.map(e => {
    const amount = `${e.currency} ${e.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    return {
      source: 'recurring_due' as const,
      keys: crossedThresholds(e.date, today, [e.leadDays]).map(t => `rje:${e.id}:${e.date}:${t}`),
      title: `${e.name} — ${e.vehicle}: ${amount} ${e.status === 'drafted' ? 'drafted, waiting to be posted' : 'not yet booked'}`,
      detail: e.status === 'drafted' ? 'Post the draft from the journal.' : 'Book it from the Recurring tab of the journal.',
      dueDate: e.date,
      state: stateFor(e.date, today),
      href: `/funds/${e.vehicleId}/journal?tab=recurring`,
    }
  })
}
