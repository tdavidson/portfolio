// lib/portfolio/fof-reviews.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { saveNavStatement, type NavBooking } from './fof-nav'
import { resolveHoldingVehicle } from './fof-register'
import { applyEdits, checkProposal, isFundReviewType } from './fof-review-types'

/**
 * Approving a manager-email proposal (fof-email.ts) writes the register row it proposes, exactly as
 * a person typing it would: a NAV through the one NAV writer, which books its mark; a call or
 * distribution as a DRAFT notice, confirmed on the holding like any other.
 *
 * The caller (api/review/[id]/resolve) claims the review before calling this, so a review is
 * approved — and its row written — once.
 */
export interface FundReviewRow {
  id: string
  company_id: string | null
  vehicle_id: string | null
  issue_type: string
  payload: unknown
}

export type FundApproval =
  | { ok: true; vehicleId: string; message: string; booking?: NavBooking; later?: NavBooking[]; eventId?: string }
  | { ok: false; status: number; error: string }

export async function approveFundReview(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string; access: Pick<AccessContext, 'vehicles'> },
  review: FundReviewRow,
  choice: { vehicleId?: unknown; edits?: Record<string, unknown> | null } = {},
): Promise<FundApproval> {
  if (!isFundReviewType(review.issue_type)) return { ok: false, status: 400, error: 'This is not a fund holding review.' }
  if (!review.company_id || !review.payload) return { ok: false, status: 400, error: 'This review has no proposal to approve.' }

  // The entity: the review's own, which the approver must be able to see (and cannot redirect);
  // else the approver's choice, validated like any notice's (resolveHoldingVehicle).
  let vehicleId: string
  if (review.vehicle_id) {
    if (!canSeeVehicle(ctx.access, review.vehicle_id)) return { ok: false, status: 404, error: 'Not found' }
    vehicleId = review.vehicle_id
  } else {
    const resolved = await resolveHoldingVehicle(admin, ctx.fundId, review.company_id, choice.vehicleId, ctx.access)
    if ('error' in resolved) return { ok: false, status: 400, error: resolved.error }
    vehicleId = resolved.vehicleId
  }

  // The stored proposal is re-checked before anything is written from it, then the corrections.
  const stored = checkProposal(review.issue_type, review.payload)
  if ('error' in stored) return { ok: false, status: 400, error: stored.error }
  const proposal = applyEdits(stored, choice.edits)
  if ('error' in proposal) return { ok: false, status: 400, error: proposal.error }

  if (proposal.kind === 'nav') {
    const saved = await saveNavStatement(admin, ctx.fundId, ctx.userId, {
      companyId: review.company_id, vehicleId, asOfDate: proposal.asOfDate, reportedNav: proposal.reportedNav, source: 'extracted',
    })
    if (!saved.ok) return { ok: false, status: 400, error: saved.error }
    return {
      ok: true, vehicleId, booking: saved.booking, message: saved.booking.message,
      // A NAV dated before later ones re-books those marks (B-R14); say what happened to each.
      ...(saved.later?.length ? { later: saved.later } : {}),
    }
  }

  const { data, error } = await (admin as any).from('fund_capital_events').insert({
    fund_id: ctx.fundId,
    vehicle_id: vehicleId,
    company_id: review.company_id,
    kind: proposal.kind,
    event_date: proposal.eventDate,
    due_date: proposal.dueDate,
    notice_number: proposal.noticeNumber,
    description: proposal.purpose,
    amount: proposal.amount,
    // The whole call capitalizes and a distribution defaults to return of capital, as on a typed
    // notice (events/route.ts); the split is corrected on the notice before it is confirmed.
    purpose_investments: proposal.kind === 'call' ? proposal.amount : 0,
    purpose_fees: 0,
    purpose_expenses: 0,
    char_return_of_capital: proposal.kind === 'distribution' ? proposal.amount : 0,
    char_realized_gain: 0,
    char_income: 0,
    recallable_amount: 0,
    status: 'draft',
    source: 'extracted',
    created_by: ctx.userId,
  }).select('id').single()
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? 'The notice could not be recorded.' }
  return {
    ok: true, vehicleId, eventId: (data as { id: string }).id,
    message: `Recorded as a draft ${proposal.kind}. Confirm it on the holding to book it.`,
  }
}
