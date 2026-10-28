// The books' audit trail (accounting_audit_events): who changed an entry, a period, a commitment,
// a shared report or a K-1, when, and why.
//
// Not user_activity_logs, which a fund can switch off and which records activity rather than
// changes. This one cannot be switched off, and the table refuses updates and deletes.

import type { SupabaseClient } from '@supabase/supabase-js'
import { currentChangeSource, type ChangeSource } from './source'

export type AuditAction =
  | 'entry.post' | 'entry.unpost' | 'entry.void' | 'entry.reverse'
  | 'entries.bulk_post' | 'entries.bulk_void'
  | 'period.close' | 'period.reopen' | 'close.approve'
  | 'commitment.create' | 'commitment.edit' | 'commitment.delete'
  | 'lp_position.edit' | 'lp_position.delete'
  | 'snapshot.share' | 'snapshot.unshare' | 'snapshot.edit' | 'snapshot.delete'
  | 'lp_statement.force_publish'
  | 'capital_call.issue' | 'distribution.declare'
  | 'credit_facility.save' | 'credit_facility.remove' | 'credit_facility.record' | 'credit_facility.remove_row'
  | 'proposed_call.create' | 'proposed_call.revise' | 'proposed_call.approve' | 'proposed_call.discard'
  | 'k1.generate' | 'k1.finalize' | 'k1.amend'
  | 'tax.adjustments' | 'pending_action.approve' | 'pending_action.reject' | 'pending_action.stage'
  | 'pending_action.undo' | 'pending_action.withdraw'
  | 'agent.write'

export interface AuditEvent {
  fundId: string
  vehicleId?: string | null
  actorId: string | null
  action: AuditAction
  subjectType: string
  subjectId?: string | null
  reason?: string | null
  details?: Record<string, unknown>
  /** The door the change came through. Defaults to the request's (lib/audit/source.ts). */
  source?: ChangeSource
}

function row(e: AuditEvent) {
  return {
    fund_id: e.fundId,
    vehicle_id: e.vehicleId ?? null,
    actor_id: e.actorId,
    action: e.action,
    subject_type: e.subjectType,
    subject_id: e.subjectId ?? null,
    reason: e.reason ?? null,
    details: e.details ?? {},
    source: e.source ?? currentChangeSource(),
  }
}

/**
 * Postgres' "undefined column": the release is live but the migration adding `source` has not
 * been pushed yet. The event is still worth more than the column, so it is written without it,
 * with the source kept in `details` where nothing is lost.
 */
const UNDEFINED_COLUMN = '42703'

async function insertRows(admin: SupabaseClient, rows: ReturnType<typeof row>[]) {
  const table = () => (admin as any).from('accounting_audit_events')
  const { error } = await table().insert(rows)
  if (error?.code !== UNDEFINED_COLUMN) return error
  const { error: retry } = await table().insert(rows.map(({ source, ...r }) => ({ ...r, details: { ...r.details, source } })))
  return retry
}

/** A reason the person typed, trimmed and capped; null when there is none. */
export function auditReason(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s ? s.slice(0, 1000) : null
}

/**
 * Record one event. Never throws: an audit write that fails is logged loudly, but the change it
 * describes has already happened and refusing the response would not undo it. Callers that need
 * the record to exist BEFORE acting (none yet) should check the result.
 */
export async function recordAudit(admin: SupabaseClient, e: AuditEvent): Promise<boolean> {
  try {
    const error = await insertRows(admin, [row(e)])
    if (error) { console.error('[audit] not recorded', e.action, error.message); return false }
    return true
  } catch (err) {
    console.error('[audit] not recorded', e.action, err)
    return false
  }
}

/** Several at once (a bulk action), one insert. */
export async function recordAuditMany(admin: SupabaseClient, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return
  try {
    const error = await insertRows(admin, events.map(row))
    if (error) console.error('[audit] bulk not recorded', error.message)
  } catch (err) {
    console.error('[audit] bulk not recorded', err)
  }
}
