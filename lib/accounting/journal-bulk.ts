import type { SupabaseClient } from '@supabase/supabase-js'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { ACTUAL_BOOK } from './books'
import { postExistingEntryWithAllocation } from './continuous-allocation'

// Shared machinery behind the journal's two bulk actions — post many drafts, void many
// drafts. Both page the same way, scope the same way and guard the same way; only the
// per-entry checks and the resulting status differ, so the paging and the guards live here
// rather than being copied into a second route and drifting.

// One page per call — each transition is a real write, and a serverless request must finish
// well inside its timeout. The caller repeats while `hasMore`.
export const BULK_BATCH = 500

export type BulkAction = 'post' | 'void'

export interface BulkScope {
  /** Act on exactly these entries, one shot (no cursor — the caller chunks). */
  ids: string[] | null
  /** Restrict the window; omit both for every draft in the vehicle. */
  start: string | null
  end: string | null
  /** Keyset cursor from the previous call's `cursor`. */
  afterId: string | null
}

export interface BulkOutcome {
  /** Entries that actually changed status. */
  changed: number
  skipped: { id: string; reason: string }[]
  hasMore: boolean
  cursor: string | null
}

/** Pull the scope out of a request body, ignoring anything malformed. */
export function readBulkScope(body: unknown): BulkScope {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    ids: Array.isArray(b.ids) && b.ids.length > 0 ? (b.ids as string[]) : null,
    start: (b.start as string) || null,
    end: (b.end as string) || null,
    afterId: typeof b.afterId === 'string' ? b.afterId : null,
  }
}

/**
 * Move a page of DRAFT entries to `posted` or `void`.
 *
 * Draft-only in both directions: posting a posted entry is a no-op, and voiding a POSTED
 * entry reverses real ledger effects — that stays a deliberate, one-at-a-time act through
 * the PATCH route, not something a bulk button can do to 300 rows.
 *
 * Every entry is checked individually and anything refused comes back in `skipped` with a
 * reason, so one stuck entry never blocks the rest of the batch.
 */
export async function runBulkDraftAction(
  admin: SupabaseClient,
  opts: {
    fundId: string
    vehicleId: string | null
    group: string
    action: BulkAction
    scope: BulkScope
    userId: string | null
  },
): Promise<{ ok: true; outcome: BulkOutcome } | { ok: false; error: unknown }> {
  const { fundId, vehicleId, group, action, scope, userId } = opts

  // Candidate drafts — scoped to the vehicle, ordered by id for a stable keyset, with
  // postings for the balance check.
  let query = (admin as any)
    .from('journal_entries')
    .select('id, entry_date, journal_postings(amount)')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'draft')
    .order('id', { ascending: true })
    .limit(BULK_BATCH + 1)
  if (scope.ids) {
    query = query.in('id', scope.ids)
  } else {
    if (scope.start) query = query.gte('entry_date', scope.start)
    if (scope.end) query = query.lte('entry_date', scope.end)
    if (scope.afterId) query = query.gt('id', scope.afterId)
  }

  const { data: drafts, error } = await query
  if (error) return { ok: false, error }

  const rows = (drafts as any[]) ?? []
  const hasMore = rows.length > BULK_BATCH
  const batch = rows.slice(0, BULK_BATCH)

  const closed = await closedPeriodRanges(admin, fundId, group)

  const target: string[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const e of batch) {
    if (dateInAnyClosedPeriod(closed, e.entry_date)) {
      skipped.push({ id: e.id, reason: `In a closed period (${e.entry_date}) — reopen it first.` })
      continue
    }
    // Balance only gates posting. A lopsided draft is precisely the kind you want to be
    // able to throw away, so refusing to void it would trap the mess it represents.
    if (action === 'post') {
      if (((e.journal_postings as any[]) ?? []).length === 0) {
        skipped.push({ id: e.id, reason: 'Has no lines — add them before posting.' })
        continue
      }
      const sum = ((e.journal_postings as any[]) ?? []).reduce((s, p) => s + Number(p.amount), 0)
      if (Math.abs(sum) > 0.005) {
        skipped.push({ id: e.id, reason: `Out of balance by ${sum.toFixed(2)} — fix it before posting.` })
        continue
      }
    }
    target.push(e.id)
  }

  if (target.length > 0) {
    if (action === 'post') {
      // Every post goes through the choke point: it adopts investment lines and allocates to
      // partners. A raw status flip here used to skip both.
      for (const id of target) {
        const posted = await postExistingEntryWithAllocation(admin, fundId, group, userId, id)
        if ('error' in posted) skipped.push({ id, reason: posted.error })
      }
    } else {
      const { error: upErr } = await (admin as any)
        .from('journal_entries').update({ status: 'void', posted_at: null }).in('id', target).eq('fund_id', fundId).eq('status', 'draft')
      if (upErr) return { ok: false, error: upErr }
    }
    // Keep any bank transactions that point at these entries in step — the same two states
    // the single-entry bank actions use.
    const failed = new Set(skipped.map(item => item.id))
    const changedIds = target.filter(id => !failed.has(id))
    if (changedIds.length > 0) {
      await (admin as any).from('bank_transactions')
        .update({ status: action === 'post' ? 'reconciled' : 'ignored' })
        .in('journal_entry_id', changedIds)
        .eq('fund_id', fundId)
    }
  }

  return {
    ok: true,
    outcome: {
      changed: target.length - skipped.filter(item => target.includes(item.id)).length,
      skipped,
      hasMore,
      cursor: batch.length ? batch[batch.length - 1].id : null,
    },
  }
}
