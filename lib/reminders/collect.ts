import { complianceReminders, type ComplianceData } from './sources/compliance'
import { asksSendReminders, type AsksData } from './sources/asks-send'
import { asksFollowupReminders } from './sources/asks-followup'
import { callsDueReminders, type CallsData } from './sources/calls'
import { onboardingReminders, type OnboardingData } from './sources/onboarding'
import { feeDueReminders, type FeesData } from './sources/fees'
import type { ReminderItem } from './types'

export interface FundReminderData {
  compliance: ComplianceData
  asks: AsksData
  calls: CallsData
  /** Absent when no vehicle has a stored fee schedule. */
  fees?: FeesData
  /** Absent on a fund with the LP portal off. */
  onboarding?: OnboardingData
}

/** Every open reminder for one fund as of `today`, earliest due first. Pure. */
export function collectReminders(data: FundReminderData, today: string): ReminderItem[] {
  return [
    ...complianceReminders(data.compliance, today),
    ...asksSendReminders(data.asks, today),
    ...asksFollowupReminders(data.asks, today),
    ...callsDueReminders(data.calls, today),
    ...(data.fees ? feeDueReminders(data.fees, today) : []),
    ...(data.onboarding ? onboardingReminders(data.onboarding, today) : []),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}
