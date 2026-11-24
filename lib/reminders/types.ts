export type ReminderState = 'overdue' | 'due_soon' | 'upcoming'
export type ReminderSource = 'compliance' | 'asks_send' | 'asks_followup' | 'calls_due' | 'fees_due' | 'recurring_due' | 'onboarding'

/** One line in the digest. `keys` are the thresholds this item has crossed as of today; the
 *  digest is sent when any of them has not been logged in reminder_deliveries. */
export interface ReminderItem {
  source: ReminderSource
  keys: string[]
  title: string
  detail?: string
  dueDate: string
  state: ReminderState
  href: string
}
