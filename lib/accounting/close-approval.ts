// Approving a close: the second half of prepare / approve.
//
// The close prepares its review (lib/accounting/close.ts persistCloseReview). Approving it is a
// different person's act — the person who closed the books does not also sign them off. A fund
// with only one member who can do the books has nobody else to ask, so there the preparer may
// approve their own close, and the record says that is what happened rather than pretending a
// second review took place.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { recordAudit } from '@/lib/audit/events'
import { vehicleIdByName } from './vehicle-id'

export interface ApprovalResult {
  approved: { periodId: string; periodEnd: string; selfApproved: boolean }[]
}

/** How many members of the fund may write the books. */
async function accountingWriters(admin: SupabaseClient, fundId: string): Promise<string[]> {
  const { data } = await (admin as any).from('fund_members').select('user_id, role').eq('fund_id', fundId)
  const out: string[] = []
  for (const m of ((data as any[]) ?? [])) {
    if (m.role === 'viewer') continue
    const ctx = await loadAccessContext(admin, fundId, m.user_id, m.role)
    if (hasAccess(ctx, 'accounting', 'write')) out.push(m.user_id)
  }
  return out
}

/**
 * The approval rule, on its own so it can be tested: may `approverId` sign off a review prepared
 * by `preparedBy`, in a fund whose book-keepers are `writers`?
 */
export function approvalDecision(preparedBy: string | null, approverId: string, writers: string[]):
  { ok: true; selfApproved: boolean } | { ok: false; reason: string } {
  if (!preparedBy || preparedBy !== approverId) return { ok: true, selfApproved: false }
  const others = writers.filter(w => w !== approverId)
  if (others.length === 0) return { ok: true, selfApproved: true }
  return { ok: false, reason: `You prepared this close, so someone else has to approve it — ${others.length} other member${others.length === 1 ? '' : 's'} can.` }
}

/**
 * Approve every prepared review for periods ending on or before `through` (or the one period `periodId`).
 * All or nothing per call: if any of them was prepared by the approver and someone else could
 * approve, none are approved and the reason says which.
 */
export async function approveCloses(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  approverId: string,
  target: { periodId: string } | { through: string },
  attestation: string | null,
): Promise<ApprovalResult | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  let q = (admin as any).from('fiscal_periods').select('id, period_end').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'closed')
  q = 'periodId' in target ? q.eq('id', target.periodId) : q.lte('period_end', target.through)
  const { data: periods } = await q
  const periodRows = ((periods as any[]) ?? [])
  if (periodRows.length === 0) return { error: 'No closed period to approve.' }

  const { data: reviews } = await (admin as any).from('close_reviews')
    .select('id, fiscal_period_id, status, prepared_by')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'prepared')
    .in('fiscal_period_id', periodRows.map(p => p.id))
  const pending = ((reviews as any[]) ?? [])
  if (pending.length === 0) return { error: 'Every closed period in that range is already approved.' }

  const writers = await accountingWriters(admin, fundId)
  const endOf = new Map(periodRows.map(p => [p.id as string, p.period_end as string]))
  const decisions = pending.map(r => ({ r, d: approvalDecision(r.prepared_by ?? null, approverId, writers) }))
  const refused = decisions.find(x => !x.d.ok)
  if (refused && !refused.d.ok) return { error: `${endOf.get(refused.r.fiscal_period_id)}: ${refused.d.reason}` }

  const now = new Date().toISOString()
  const approved: ApprovalResult['approved'] = []
  for (const { r, d } of decisions) {
    if (!d.ok) continue
    const periodEnd = endOf.get(r.fiscal_period_id) ?? ''
    const text = attestation?.trim()
      || `Reviewed the reconciliations, exceptions, supporting schedules, and material entries through ${periodEnd}.`
    const { error } = await (admin as any).from('close_reviews')
      .update({ status: 'approved', approved_by: approverId, approved_at: now, attestation: text.slice(0, 2000), updated_at: now })
      .eq('id', r.id).eq('status', 'prepared')
    if (error) return { error: error.message }
    await recordAudit(admin, {
      fundId, vehicleId, actorId: approverId, action: 'close.approve', subjectType: 'fiscal_period', subjectId: r.fiscal_period_id,
      details: { periodEnd, reviewId: r.id, preparedBy: r.prepared_by ?? null, selfApproved: d.selfApproved, attestation: text },
    })
    approved.push({ periodId: r.fiscal_period_id, periodEnd, selfApproved: d.selfApproved })
  }
  return { approved }
}
