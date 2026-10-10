// The books' audit trail (accounting_audit_events): who changed an entry, a period, a commitment,
// a shared report or a K-1, when, and why.
//
// Not user_activity_logs, which a fund can switch off and which records activity rather than
// changes. This one cannot be switched off, and the table refuses updates and deletes.

import type { SupabaseClient } from '@supabase/supabase-js'

export type AuditAction =
  | 'entry.post' | 'entry.unpost' | 'entry.void' | 'entry.reverse'
  | 'entries.bulk_post' | 'entries.bulk_void'
  | 'period.close' | 'period.reopen' | 'close.approve'
  | 'commitment.create' | 'commitment.edit' | 'commitment.delete'
  | 'lp_position.edit' | 'lp_position.delete'
  | 'snapshot.share' | 'snapshot.unshare' | 'snapshot.edit' | 'snapshot.delete'
  | 'lp_statement.force_publish'
  | 'capital_call.issue' | 'distribution.declare'
  | 'k1.generate' | 'k1.finalize' | 'k1.amend'
  | 'tax.adjustments' | 'pending_action.approve' | 'pending_action.reject'

export interface AuditEvent {
  fundId: string
  vehicleId?: string | null
  actorId: string | null
  action: AuditAction
  subjectType: string
  subjectId?: string | null
  reason?: string | null
  details?: Record<string, unknown>
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
    const { error } = await (admin as any).from('accounting_audit_events').insert({
      fund_id: e.fundId,
      vehicle_id: e.vehicleId ?? null,
      actor_id: e.actorId,
      action: e.action,
      subject_type: e.subjectType,
      subject_id: e.subjectId ?? null,
      reason: e.reason ?? null,
      details: e.details ?? {},
    })
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
    const { error } = await (admin as any).from('accounting_audit_events').insert(events.map(e => ({
      fund_id: e.fundId, vehicle_id: e.vehicleId ?? null, actor_id: e.actorId, action: e.action,
      subject_type: e.subjectType, subject_id: e.subjectId ?? null, reason: e.reason ?? null, details: e.details ?? {},
    })))
    if (error) console.error('[audit] bulk not recorded', error.message)
  } catch (err) {
    console.error('[audit] bulk not recorded', err)
  }
}
