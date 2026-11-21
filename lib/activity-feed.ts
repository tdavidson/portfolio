// The Usage page's activity feed: user_activity_logs and the books' audit trail
// (accounting_audit_events) read as one list.
//
// They record different things. The activity log is what a feature chose to note (a login, a
// company edited, a document uploaded) and a fund can switch it off. The audit trail is every change
// to the books, LP positions and closes, and cannot be switched off. Each says which door the action
// came through (web, api, mcp), so read together they show what each person did, wherever they did it.
//
// Kept free of the database so the merge and the counting can be tested on plain rows.

import { parseChangeSource } from '@/lib/audit/source-labels'

export interface ActivityLogRow {
  user_id: string
  action: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface AuditFeedRow {
  actor_id: string | null
  action: string
  subject_type: string | null
  subject_id: string | null
  /** The source column, or the copy older events kept in details (lib/audit/events.ts). */
  source: string | null
  legacy_source?: string | null
  /** details.tool on an `agent.write`: the MCP or API tool that made the change. */
  tool?: string | null
  created_at: string
}

export interface FeedEntry {
  userId: string
  action: string
  metadata: Record<string, unknown>
  source: ReturnType<typeof parseChangeSource>
  /** Which store it came from: `activity` (user_activity_logs) or `books` (the audit trail). */
  kind: 'activity' | 'books'
  createdAt: string
}

/**
 * How close another event must be for an `agent.write` to be the same call. A tool's own record
 * (an activity entry, or a ledger event like `entry.post`) is written inside the call, and the
 * `agent.write` just after it returns (lib/agent/dispatch.ts apply), so the window looks back.
 */
const SAME_CALL_MS = 15_000

/**
 * Merge both stores, newest first.
 *
 * Every write through MCP or the API also leaves an `agent.write` naming its tool. When the tool
 * wrote a record of its own, that record says more, so the `agent.write` is dropped as a
 * duplicate. It stays when it is the call's only trace (a bank import, a drafted letter), shown as
 * the tool it ran.
 */
export function mergeActivityFeed(activity: ActivityLogRow[], audit: AuditFeedRow[]): FeedEntry[] {
  const fromActivity: FeedEntry[] = activity.map(r => ({
    userId: r.user_id,
    action: r.action,
    metadata: r.metadata ?? {},
    source: parseChangeSource(r.metadata?.changeSource),
    kind: 'activity',
    createdAt: r.created_at,
  }))

  const people = audit.filter(r => r.actor_id)
  const specific = people.filter(r => r.action !== 'agent.write')
  const fromAudit: FeedEntry[] = specific.map(r => ({
    userId: r.actor_id!,
    action: r.action,
    metadata: { subjectType: r.subject_type, subjectId: r.subject_id },
    source: parseChangeSource(r.source ?? r.legacy_source),
    kind: 'books',
    createdAt: r.created_at,
  }))

  // Times of every other record, per person, to spot an agent.write that duplicates one.
  const times = new Map<string, number[]>()
  for (const e of [...fromActivity, ...fromAudit]) {
    const list = times.get(e.userId) ?? []
    list.push(Date.parse(e.createdAt))
    times.set(e.userId, list)
  }
  const sameCall = (userId: string, at: number) =>
    (times.get(userId) ?? []).some(t => t <= at + 1000 && t >= at - SAME_CALL_MS)

  const fromTools: FeedEntry[] = people
    .filter(r => r.action === 'agent.write' && !sameCall(r.actor_id!, Date.parse(r.created_at)))
    .map(r => ({
      userId: r.actor_id!,
      action: r.tool ? `tool:${r.tool}` : 'agent.write',
      metadata: { tool: r.tool ?? null },
      source: parseChangeSource(r.source ?? r.legacy_source),
      kind: 'books',
      createdAt: r.created_at,
    }))

  return [...fromActivity, ...fromAudit, ...fromTools]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Each person's action counts, over the whole feed. */
export function countByUser(feed: FeedEntry[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  for (const e of feed) {
    const actions = out.get(e.userId) ?? {}
    actions[e.action] = (actions[e.action] ?? 0) + 1
    out.set(e.userId, actions)
  }
  return out
}

/** Audit-trail actions: the books, LP positions and closes (lib/audit/events.ts AuditAction). */
const BOOKS_ACTION = /^(entry|entries|period|close|commitment|lp_position|snapshot|lp_statement|capital_call|distribution|credit_facility|proposed_call|k1|tax|pending_action|agent|lp_change)\.|^tool:/

export type ActionCategory = 'signins' | 'companies' | 'imports' | 'books' | 'other'

export function categorizeAction(action: string): ActionCategory {
  if (action === 'login' || action === 'logout' || action === 'connect') return 'signins'
  if (action.startsWith('company.')) return 'companies'
  if (action.startsWith('import.')) return 'imports'
  if (BOOKS_ACTION.test(action)) return 'books'
  return 'other'
}

export function categorizeActions(actions: Record<string, number>): Record<ActionCategory, number> {
  const out: Record<ActionCategory, number> = { signins: 0, companies: 0, imports: 0, books: 0, other: 0 }
  for (const [action, count] of Object.entries(actions)) out[categorizeAction(action)] += count
  return out
}

const ACTION_LABELS: Record<string, string> = {
  'login': 'Login',
  'logout': 'Logout',
  'connect': 'Connected',
  'company.create': 'Create Company',
  'company.update': 'Update Company',
  'company.summary': 'Generate Summary',
  'company.document_upload': 'Upload Document',
  'import.data': 'Import Data',
  'import.documents': 'Import Documents',
  'review.resolve': 'Resolve Review',
  'requests.send': 'Send Requests',
  'settings.update': 'Update Settings',
  'note.create': 'Create Note',
  'entry.post': 'Post Entry',
  'entry.unpost': 'Unpost Entry',
  'entry.void': 'Void Entry',
  'entry.reverse': 'Reverse Entry',
  'entry.propose': 'Propose Entry',
  'entries.bulk_post': 'Post Entries',
  'entries.bulk_void': 'Void Entries',
  'period.close': 'Close Period',
  'period.reopen': 'Reopen Period',
  'close.approve': 'Approve Close',
  'capital_call.issue': 'Issue Capital Call',
  'distribution.declare': 'Declare Distribution',
  'pending_action.approve': 'Approve Change',
  'pending_action.reject': 'Reject Change',
  'pending_action.stage': 'Stage Change',
}

export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action]
  if (action.startsWith('tool:')) return `Ran ${action.slice(5)}`
  return action
}
