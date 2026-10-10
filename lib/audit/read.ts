// Reading the books' audit trail back: filtered to what the caller may see, and as CSV.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { hasAccess } from '@/lib/access/effective'
import { fetchAllRows } from '@/lib/accounting/load'

export interface AuditRow {
  id: string
  createdAt: string
  action: string
  subjectType: string
  subjectId: string | null
  vehicleId: string | null
  actorId: string | null
  actorName: string | null
  reason: string | null
  details: Record<string, unknown>
}

/**
 * Which events a caller may read. The route is gated on `accounting`; events about partners'
 * positions, commitments, registers and reports carry partner figures (`lp_capital`), and K-1
 * events the carry too (`gp_economics`) — the same straddle the statements route gates in-handler.
 */
export function visibleTo(access: AccessContext) {
  const partners = hasAccess(access, 'lp_capital', 'read')
  const carry = hasAccess(access, 'gp_economics', 'read')
  return (action: string) => {
    if (action.startsWith('k1.')) return partners && carry
    if (/^(commitment|lp_position|snapshot|lp_statement|capital_call|distribution)\./.test(action)) return partners
    return true
  }
}

export async function loadAuditTrail(
  admin: SupabaseClient,
  fundId: string,
  opts: { vehicleId?: string | null; from?: string | null; to?: string | null; limit?: number },
  allowed: (action: string) => boolean,
): Promise<AuditRow[]> {
  const rows = await fetchAllRows<any>((f, t) => {
    let q = (admin as any).from('accounting_audit_events').select('*').eq('fund_id', fundId)
    if (opts.vehicleId) q = q.eq('vehicle_id', opts.vehicleId)
    if (opts.from) q = q.gte('created_at', opts.from)
    if (opts.to) q = q.lte('created_at', `${opts.to}T23:59:59.999Z`)
    return q.order('created_at', { ascending: false }).range(f, t)
  })
  const kept = rows.filter(r => allowed(r.action)).slice(0, opts.limit ?? Infinity)
  // Names, not ids, for the people — the trail is read by an auditor, not a database.
  const ids = Array.from(new Set(kept.map(r => r.actor_id).filter(Boolean)))
  const names = new Map<string, string>()
  // Auth holds them (as lp-onboarding-notify.ts reads them); a trail touches few people.
  await Promise.all(ids.map(async id => {
    try {
      const { data } = await admin.auth.admin.getUserById(id)
      const u = data?.user
      if (u) names.set(id, (u.user_metadata?.full_name as string | undefined) || u.email || id)
    } catch { /* an id with no user stays an id */ }
  }))
  return kept.map(r => ({
    id: r.id, createdAt: r.created_at, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id ?? null,
    vehicleId: r.vehicle_id ?? null, actorId: r.actor_id ?? null, actorName: r.actor_id ? names.get(r.actor_id) ?? null : null,
    reason: r.reason ?? null, details: r.details ?? {},
  }))
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function auditCsv(rows: AuditRow[], vehicleNames: Map<string, string>): string {
  const header = ['When (UTC)', 'Entity', 'Who', 'Action', 'Subject', 'Subject id', 'Reason', 'Details']
  const lines = rows.map(r => [
    r.createdAt, r.vehicleId ? vehicleNames.get(r.vehicleId) ?? r.vehicleId : '', r.actorName ?? r.actorId ?? '',
    r.action, r.subjectType, r.subjectId ?? '', r.reason ?? '', r.details,
  ].map(csvCell).join(','))
  return [header.join(','), ...lines].join('\n')
}
