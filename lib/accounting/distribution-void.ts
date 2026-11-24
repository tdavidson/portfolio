import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { listDistributions } from './distributions'
import { changeEntryState } from './journal-state'
import { recordAudit } from '@/lib/audit/events'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'

/**
 * VOID a declared distribution: take its declaration entries off the books and mark the register
 * row void, so it no longer lists, notices or counts on a statement.
 *
 * Voiding only the journal entry (void_entry) put the ledger right but left the register saying
 * the distribution was declared, and nothing on the agent surface could change that. This does
 * both, as one action, and refuses while anything has been paid against it: a payment settles the
 * payable this would remove, so it has to be undone first (void or reverse the payment entry),
 * or the payable is left owing the other way.
 *
 * A declaration in an OPEN period is voided. One in a CLOSED period cannot be: pass reverseDate
 * (in an open period) and it is reversed there instead, posted, so the closed period stays as
 * reported and the correction lands where the books are open.
 */
export interface VoidDistributionInput {
  distributionId: string
  reason: string
  /** YYYY-MM-DD in an open period: reverse the declaration there instead of voiding it. */
  reverseDate?: string | null
}

export interface VoidDistributionCaller {
  fundId: string
  userId: string
  role: string
  mayTouchInvestments: () => Promise<boolean>
}

export interface VoidDistributionResult {
  distributionId: string
  mode: 'void' | 'reverse'
  entries: { entryId: string; reversalId?: string }[]
  total: number
}

/** What a void would do, writing nothing — and why it would be refused, if it would be. */
export async function voidDistributionPlan(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  distributionId: string,
): Promise<{ date: string; description: string | null; total: number; entryIds: string[]; partners: { lpEntityId: string; name: string; amount: number; settled: number }[]; noticesIssued: number; problem: string | null } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data: row } = await (admin as any).from('distributions')
    .select('id, status, journal_entry_id, carry_journal_entry_id')
    .eq('id', distributionId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
  if (!row) return { error: 'Distribution not found on this vehicle.' }
  if (row.status === 'void') return { error: 'That distribution is already void.' }
  if (row.status !== 'declared') return { error: 'Only a declared distribution can be voided.' }

  const declared = (await listDistributions(admin, fundId, group)).find(d => d.distributionId === distributionId)
  if (!declared) return { error: 'Distribution not found on this vehicle.' }
  const partners = declared.lines.map(l => ({ lpEntityId: l.lpEntityId, name: l.name, amount: l.amount, settled: l.settled }))
  const paid = partners.filter(p => p.settled > 0.005)
  const problem = paid.length > 0
    ? `${paid.length === 1 ? 'One partner has' : `${paid.length} partners have`} been paid ${roundCents(paid.reduce((s, p) => s + p.settled, 0))} against this distribution ` +
      `(${paid.map(p => p.name).join(', ')}). Void or reverse those payment entries first (capital_settlements, kind distribution, lists them), then void the distribution.`
    : null
  return {
    date: declared.date,
    description: declared.description,
    total: declared.total,
    entryIds: Array.from(new Set([row.journal_entry_id, row.carry_journal_entry_id].filter(Boolean))) as string[],
    partners,
    noticesIssued: declared.lines.filter(l => l.noticeDocumentId).length,
    problem,
  }
}

export async function voidDistribution(
  admin: SupabaseClient,
  who: VoidDistributionCaller,
  group: string,
  input: VoidDistributionInput,
): Promise<VoidDistributionResult | { error: string; status: number }> {
  const reason = String(input.reason ?? '').trim()
  if (!reason) return { error: 'A reason is required to void a distribution.', status: 400 }
  if (input.reverseDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.reverseDate))) {
    return { error: 'reverseDate must be YYYY-MM-DD.', status: 400 }
  }
  const plan = await voidDistributionPlan(admin, who.fundId, group, input.distributionId)
  if ('error' in plan) return { error: plan.error, status: 400 }
  if (plan.problem) return { error: plan.problem, status: 400 }

  const vehicleId = await vehicleIdByName(admin, who.fundId, group)
  const mode: 'void' | 'reverse' = input.reverseDate ? 'reverse' : 'void'

  // The register first: if the database predates 'void' (20261124010000), nothing has changed yet.
  const now = new Date().toISOString()
  const { error: markErr } = await (admin as any).from('distributions')
    .update({ status: 'void', voided_at: now, voided_by: who.userId, void_reason: reason })
    .eq('id', input.distributionId).eq('fund_id', who.fundId).eq('status', 'declared')
  if (markErr) {
    return /void|check constraint|column/i.test(markErr.message)
      ? { error: 'Voiding a distribution needs migration 20261124010000_distribution_void.sql. Apply it, then try again.', status: 400 }
      : { error: markErr.message, status: 500 }
  }

  const done: { entryId: string; reversalId?: string }[] = []
  for (const entryId of plan.entryIds) {
    const { data: entry } = await (admin as any).from('journal_entries').select('status').eq('book', ACTUAL_BOOK).eq('id', entryId).eq('fund_id', who.fundId).maybeSingle()
    if (!entry || entry.status === 'void') { done.push({ entryId }); continue }
    const out = await changeEntryState(admin, who, group, vehicleId, mode === 'reverse'
      ? { id: entryId, action: 'reverse', reason, reverseDate: input.reverseDate, post: true }
      : { id: entryId, action: 'void', reason })
    if (out.status >= 400) {
      // Put the register back while nothing (or only part) moved, and say what did.
      if (done.length === 0) {
        await (admin as any).from('distributions')
          .update({ status: 'declared', voided_at: null, voided_by: null, void_reason: null })
          .eq('id', input.distributionId).eq('fund_id', who.fundId)
        return { error: String(out.body.error ?? 'The declaration entry could not be voided.'), status: out.status }
      }
      return { error: `The distribution is marked void and ${done.map(d => d.entryId).join(', ')} ${mode === 'void' ? 'voided' : 'reversed'}, but entry ${entryId} was not: ${String(out.body.error ?? 'unknown error')}. ${mode === 'void' ? 'Void' : 'Reverse'} it from the journal.`, status: 500 }
    }
    done.push({ entryId, ...(out.body.reversalId ? { reversalId: String(out.body.reversalId) } : {}) })
  }

  await recordAudit(admin, {
    fundId: who.fundId, vehicleId, actorId: who.userId, action: 'distribution.void', subjectType: 'distribution',
    subjectId: input.distributionId, reason,
    details: { date: plan.date, total: plan.total, partners: plan.partners.length, mode, entries: done, noticesIssued: plan.noticesIssued },
  })
  return { distributionId: input.distributionId, mode, entries: done, total: plan.total }
}
