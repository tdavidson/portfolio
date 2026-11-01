// Proposed journal entries: what a member with the `propose` level on accounting makes instead of
// an entry.
//
// A proposal is an ordinary DRAFT entry with `proposed_by` / `proposed_at` set
// (20261031190000_propose_access_level.sql). Drafts never touch the ledger, so nothing about the
// books changes until someone with write posts it, and everything a draft already gets comes for
// free: the journal lists it, someone with write can edit it before posting, and voiding a draft
// discards it, which is how a proposal is rejected. The columns stay on the entry once it posts,
// so the ledger shows where it came from.
//
// What a proposer may do, on every door (the journal route, the post_entry tool, the API):
//   - create a draft, never a posted entry, whatever status they ask for;
//   - edit or withdraw (void) a draft THEY proposed while it is still a draft;
//   - nothing else that changes the books.
// Everyone with write keeps doing everything they did before, proposals included.

import type { SupabaseClient } from '@supabase/supabase-js'
import { entityAccess, type AccessContext } from '@/lib/access/effective'
import { recordAudit } from '@/lib/audit/events'
import { ACTUAL_BOOK } from './books'

/**
 * Does a write from this caller become a proposal? True only at exactly the propose level: their
 * accounting grant, lowered to their level in the entity when one is named
 * (fund_member_vehicles.level). So a fund administrator with write on the books but capped at
 * propose in Fund II proposes there and posts everywhere else.
 */
export function isProposer(access: AccessContext, vehicleId: string | null = null): boolean {
  return entityAccess(access, 'accounting', vehicleId) === 'propose'
}

/** Mark a draft as proposed by `userId`, and record it in the books' audit trail. */
export async function markProposed(
  admin: SupabaseClient,
  args: { fundId: string; vehicleId: string | null; entryId: string; userId: string },
): Promise<{ error: string } | null> {
  const { error } = await (admin as any)
    .from('journal_entries')
    .update({ proposed_by: args.userId, proposed_at: new Date().toISOString() })
    .eq('id', args.entryId)
    .eq('fund_id', args.fundId)
    .eq('status', 'draft')
  if (error) return { error: 'The entry was saved as a draft, but could not be marked as proposed.' }
  await recordAudit(admin, {
    fundId: args.fundId, vehicleId: args.vehicleId, actorId: args.userId,
    action: 'entry.propose', subjectType: 'journal_entry', subjectId: args.entryId,
  })
  return null
}

/**
 * Why this proposer may not change this entry, or null when they may: it must be a draft they
 * proposed themselves. Not found and someone else's read the same, so the id says nothing.
 */
export async function proposerChangeProblem(
  admin: SupabaseClient,
  args: { fundId: string; entryId: string; userId: string },
): Promise<string | null> {
  const { data } = await (admin as any)
    .from('journal_entries')
    .select('status, proposed_by')
    .eq('book', ACTUAL_BOOK)
    .eq('id', args.entryId)
    .eq('fund_id', args.fundId)
    .maybeSingle()
  const row = data as { status?: string; proposed_by?: string | null } | null
  if (!row || row.proposed_by !== args.userId) {
    return 'You can propose journal entries, and change or withdraw only your own proposals while they are drafts.'
  }
  if (row.status !== 'draft') return 'This proposal has already been posted or withdrawn, so it can no longer be changed.'
  return null
}

/** The refusal for any other change a proposer tries to make to the books. */
export const PROPOSER_REFUSAL =
  'You can propose journal entries, not post or change the books. Your entry is saved as a draft for someone with write access to post or reject.'

export interface ProposalRow {
  id: string
  entryDate: string
  memo: string | null
  reference: string | null
  entity: string
  proposedBy: string | null
  proposedByEmail: string | null
  proposedAt: string | null
  status: string
  total: number
}

/**
 * Proposals in this fund, newest first: open ones (still drafts) by default, or every one ever made.
 * `entities` narrows to the entity names the caller may see; null means all.
 */
export async function listProposals(
  admin: SupabaseClient,
  args: { fundId: string; entities: string[] | null; includeClosed?: boolean; limit?: number },
): Promise<ProposalRow[]> {
  if (args.entities && args.entities.length === 0) return []
  let q = (admin as any)
    .from('journal_entries')
    .select('id, entry_date, memo, reference, portfolio_group, proposed_by, proposed_at, status, journal_postings(amount)')
    .eq('fund_id', args.fundId)
    .eq('book', ACTUAL_BOOK)
    .not('proposed_by', 'is', null)
    .order('proposed_at', { ascending: false })
    .limit(Math.min(Math.max(args.limit ?? 50, 1), 200))
  if (!args.includeClosed) q = q.eq('status', 'draft')
  if (args.entities) q = q.in('portfolio_group', args.entities)
  const { data, error } = await q
  if (error) throw new Error('Could not read proposed entries.')
  const rows = (data ?? []) as any[]

  const ids = [...new Set(rows.map(r => r.proposed_by).filter(Boolean))] as string[]
  const emails = new Map<string, string>()
  await Promise.all(ids.map(async id => {
    const { data: u } = await admin.auth.admin.getUserById(id)
    if (u?.user?.email) emails.set(id, u.user.email)
  }))

  return rows.map(r => ({
    id: r.id,
    entryDate: r.entry_date,
    memo: r.memo ?? null,
    reference: r.reference ?? null,
    entity: r.portfolio_group,
    proposedBy: r.proposed_by ?? null,
    proposedByEmail: r.proposed_by ? emails.get(r.proposed_by) ?? null : null,
    proposedAt: r.proposed_at ?? null,
    status: r.status,
    // Debits are positive and the entry balances, so the debit side is its size.
    total: ((r.journal_postings ?? []) as { amount: number }[]).reduce((s, p) => s + (Number(p.amount) > 0 ? Number(p.amount) : 0), 0),
  }))
}
