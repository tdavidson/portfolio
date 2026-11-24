// The daily operational-reminder email: every open item, grouped by urgency. Sent only when
// undeliveredKeys() is non-empty, so a quiet day sends nothing but a sent day shows the whole
// picture, not just what changed.

import { daysBetween } from './dates'
import type { ReminderItem, ReminderState } from './types'

export function undeliveredKeys(items: ReminderItem[], delivered: Set<string>): string[] {
  const out = new Set<string>()
  for (const item of items) for (const k of item.keys) if (!delivered.has(k)) out.add(k)
  return [...out]
}

const GROUPS: { state: ReminderState; label: string }[] = [
  { state: 'overdue', label: 'Overdue' },
  { state: 'due_soon', label: 'Due soon' },
  { state: 'upcoming', label: 'Upcoming' },
]

const RANK: Record<ReminderState, number> = { overdue: 0, due_soon: 1, upcoming: 2 }

export function renderDigest(
  items: ReminderItem[],
  opts: { fundName: string; baseUrl: string; today: string },
): { subject: string; html: string } {
  const sorted = [...items].sort((a, b) => RANK[a.state] - RANK[b.state] || a.dueDate.localeCompare(b.dueDate))
  const lead = sorted[0]
  const more = sorted.length - 1
  const subject = `${opts.fundName}: ${phrase(lead, opts.today)}${more > 0 ? ` + ${more} more` : ''}`

  const sections = GROUPS.map(({ state, label }) => {
    const group = sorted.filter(i => i.state === state)
    if (group.length === 0) return ''
    const rows = group.map(i => `
      <li style="margin: 0 0 12px 0;">
        <strong>${escapeHtml(i.title)}</strong><br/>
        ${i.detail ? `<span style="color:#555; font-size: 13px; white-space: pre-line;">${escapeHtml(i.detail)}</span><br/>` : ''}
        <span style="color:#555; font-size: 13px;">${escapeHtml(dueLine(i, opts.today))}</span>
        · <a href="${opts.baseUrl}${i.href}" style="font-size: 13px;">Open →</a>
      </li>`).join('')
    return `<h3 style="font-size: 14px; margin: 20px 0 8px;">${label}</h3><ul style="list-style: none; padding: 0; margin: 0;">${rows}</ul>`
  }).join('')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px;">
      <p>Here's what needs attention for ${escapeHtml(opts.fundName)}.</p>
      ${sections}
      <p style="font-size: 12px; color: #888; margin-top: 24px;">
        Operational reminders. Change recipients or turn them off in
        <a href="${opts.baseUrl}/settings">Settings</a>.
      </p>
    </div>`

  return { subject, html }
}

function phrase(item: ReminderItem, today: string): string {
  if (item.source !== 'compliance') return item.title
  const until = daysBetween(today, item.dueDate)
  if (until < 0) return `${item.title} overdue`
  if (until === 0) return `${item.title} due today`
  return `${item.title} due in ${until} day${until === 1 ? '' : 's'}`
}

function dueLine(item: ReminderItem, today: string): string {
  const date = new Date(`${item.dueDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
  const until = daysBetween(today, item.dueDate)
  const verb = item.source === 'asks_send' ? 'Send by' : item.source === 'calls_due' ? 'Wires due' : item.source === 'fees_due' ? 'Fee due' : item.source === 'onboarding' && item.keys[0]?.startsWith('ob:close') ? 'Closes' : 'Due'
  if (until < 0) return `${verb} ${date} · ${-until} day${until === -1 ? '' : 's'} overdue`
  if (until === 0) return `${verb} today`
  return `${verb} ${date} · in ${until} day${until === 1 ? '' : 's'}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
