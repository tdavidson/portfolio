import { describe, it, expect } from 'vitest'
import { complianceCalendar } from './calendar'
import type { ComplianceData, ComplianceItemRow } from '@/lib/reminders/sources/compliance'

const adv: ComplianceItemRow = {
  id: 'form-adv', name: 'Form ADV Annual Amendment', short_name: 'Form ADV',
  frequency: 'Annual', scope: 'firm', deadline_month: 3, deadline_day: 31, rolling_days: null,
}
const audit: ComplianceItemRow = {
  id: 'annual-audit', name: 'Annual audit delivery', short_name: 'Audit',
  frequency: 'Annual', scope: 'vehicle', deadline_month: 4, deadline_day: 30, rolling_days: null,
}

const data = (o: Partial<ComplianceData> = {}): ComplianceData => ({
  items: [adv, audit],
  profile: null,
  settings: [
    { compliance_item_id: 'form-adv', portfolio_group: '', applies: 'yes', dismissed: false },
    { compliance_item_id: 'annual-audit', portfolio_group: 'Fund I', applies: 'yes', dismissed: false, notes: 'Auditor: Example Audit LLP' },
    { compliance_item_id: 'annual-audit', portfolio_group: 'Fund II', applies: 'no', dismissed: false },
  ],
  closed: [],
  portfolioGroups: ['Fund I', 'Fund II', 'Fund III'],
  closeDates: {},
  ...o,
})

describe('complianceCalendar', () => {
  it("lists the year's filings that apply, per entity, earliest first, with the entity's notes", () => {
    const rows = complianceCalendar(data(), 2027, '2027-01-15')
    expect(rows.map(r => [r.itemId, r.entity, r.dueDate, r.applicability, r.state])).toEqual([
      ['form-adv', '', '2027-03-31', 'applies', 'open'],
      ['annual-audit', 'Fund I', '2027-04-30', 'applies', 'open'],
      // Nobody has said whether it applies to Fund III: that decision is itself a task.
      ['annual-audit', 'Fund III', '2027-04-30', 'needs_review', 'open'],
    ])
    expect(rows[1].notes).toBe('Auditor: Example Audit LLP')
  })

  it('marks a filed occurrence filed and an unfiled past one overdue', () => {
    const rows = complianceCalendar(data({
      closed: [{ compliance_item_id: 'annual-audit', portfolio_group: 'Fund I', quarter: 0, year: 2027, status: 'filed' }],
    }), 2027, '2027-05-02')
    const state = Object.fromEntries(rows.map(r => [`${r.itemId}|${r.entity}`, r.state]))
    expect(state).toEqual({ 'form-adv|': 'overdue', 'annual-audit|Fund I': 'filed', 'annual-audit|Fund III': 'overdue' })
  })

  it('keeps an occurrence marked not applicable, as such', () => {
    const rows = complianceCalendar(data({
      closed: [{ compliance_item_id: 'form-adv', portfolio_group: '', quarter: 0, year: 2027, status: 'not_applicable' }],
    }), 2027, '2027-01-15')
    expect(rows.find(r => r.itemId === 'form-adv')?.state).toBe('not_applicable')
  })
})
