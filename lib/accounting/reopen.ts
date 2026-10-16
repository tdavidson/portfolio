// Reopening closed periods, shared by POST /api/accounting/periods { action: 'reopen' } and the
// `reopen_period` agent tool. Admin-only on every surface (lib/access/admin-only.ts).
//
// Reopens the named period (or every closed period covering or after a date) and every closed
// period after it, newest first, voiding each one's allocation entries (reopenThrough). Needs a
// reason, recorded with who reopened. Closing again re-runs the allocation; the voided entries stay
// void, and a K-1 already issued for a reopened year is named in the result, not withdrawn.

import type { SupabaseClient } from '@supabase/supabase-js'
import { auditReason, recordAudit } from '@/lib/audit/events'
import { done, fail, type Outcome } from '@/lib/service-outcome'
import { reopenThrough } from './close'
import { vehicleIdByName } from './vehicle-id'

export type ReopenResult = Extract<Awaited<ReturnType<typeof reopenThrough>>, { reopened: unknown }>

export async function reopenClosedPeriods(
  admin: SupabaseClient,
  who: { fundId: string; userId: string },
  group: string,
  input: { id?: unknown; fromDate?: unknown; reason?: unknown },
): Promise<Outcome<ReopenResult>> {
  if (!input.id && !input.fromDate) return fail(400, 'id or fromDate is required')
  const reason = auditReason(input.reason)
  if (!reason) return fail(400, 'A reason is required to reopen a closed period.')
  const result = await reopenThrough(admin, who.fundId, group, input.id ? { periodId: String(input.id) } : { fromDate: String(input.fromDate) })
  if ('error' in result) return fail(400, result.error)
  await recordAudit(admin, {
    fundId: who.fundId, vehicleId: await vehicleIdByName(admin, who.fundId, group), actorId: who.userId,
    action: 'period.reopen', subjectType: 'fiscal_period', subjectId: input.id ? String(input.id) : null, reason,
    details: { fromDate: input.fromDate ?? null, reopened: result.reopened, voided: result.voided, reopenedPeriods: result.reopenedPeriods, issuedK1Years: result.issuedK1Years },
  })
  return done(result as ReopenResult)
}
