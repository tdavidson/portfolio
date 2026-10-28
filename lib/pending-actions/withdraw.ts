// Withdrawing the Analyst's own drafts once the conversation has moved past them.
//
// A person who keeps talking instead of approving ("make February higher", "drop the hire") gets a
// revised proposal from the Analyst, and the earlier card would otherwise sit there, still
// approvable, describing a change nobody wants any more. So a draft is withdrawn when:
//   - the Analyst stages a new draft of the same kind, for the same entity and the same subject
//     (plan, company), in a later turn of the same conversation: the new one replaces it. Only for
//     kinds where a second draft is a revision (REPLACEABLE); two metric updates for one company
//     are usually two different months, so those wait for the Analyst to withdraw one; or
//   - the Analyst withdraws it with `withdraw_proposal`, because the person declined or moved on.
//
// Only the person's own drafts from the in-app Analyst, still pending, and only ones the client
// says are in this conversation. A withdrawn draft is `rejected`, as Reject would leave it, and the
// audit trail records it as a withdrawal and what replaced it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAudit } from '@/lib/audit/events'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_OPEN = 50

/** Kinds where a later draft for the same entity and subject is a revision of the earlier one. */
export const REPLACEABLE = new Set([
  'create_forecast_plan', 'update_forecast_plan', 'publish_forecast_plan',
  'update_portfolio_construction', 'update_company', 'issue_capital_call',
  'set_waterfall_terms', 'set_recycling_terms', 'set_credit_facility',
])

/** A draft still waiting in this conversation. */
export interface OpenProposal {
  id: string
  actionType: string
  vehicleId: string | null
  subject: string | null
  summary: string
}

/** What a draft is about, beyond its entity: the plan or company it changes, when it names one. */
export function proposalSubject(args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  for (const key of ['planId', 'companyId', 'callId']) {
    if (typeof a[key] === 'string' && a[key]) return `${key}:${a[key]}`
  }
  return null
}

/** Does a new draft replace an open one? Same kind, same entity, same subject. */
export function replaces(
  next: { actionType: string; vehicleId: string | null; subject: string | null },
  open: OpenProposal,
): boolean {
  return REPLACEABLE.has(next.actionType)
    && next.actionType === open.actionType && next.vehicleId === open.vehicleId && next.subject === open.subject
}

/**
 * The caller's pending Analyst drafts among `ids`. Anything else (another person's, a connected
 * chat's, already decided, another fund's) is dropped silently: the ids come from the browser.
 */
export async function loadOpenProposals(
  admin: SupabaseClient,
  scope: { fundId: string; userId: string },
  ids: unknown,
): Promise<OpenProposal[]> {
  if (!Array.isArray(ids)) return []
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(0, MAX_OPEN)
  if (wanted.length === 0) return []
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .select('id, action_type, vehicle_id, args, preview, created_at')
    .eq('fund_id', scope.fundId)
    .eq('created_by', scope.userId)
    .eq('created_via', 'analyst')
    .eq('status', 'pending')
    .in('id', wanted)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ id: string; action_type: string; vehicle_id: string | null; args: unknown; preview: { summary?: string } | null }>)
    .map(row => ({
      id: row.id,
      actionType: row.action_type,
      vehicleId: row.vehicle_id ?? null,
      subject: proposalSubject(row.args),
      summary: String(row.preview?.summary ?? row.action_type),
    }))
}

/** Withdraw the caller's own pending drafts. Returns the ids actually withdrawn. */
export async function withdrawProposals(
  admin: SupabaseClient,
  scope: { fundId: string; userId: string },
  ids: string[],
  why: { replacedBy?: string; reason?: string } = {},
): Promise<string[]> {
  if (ids.length === 0) return []
  const now = new Date().toISOString()
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .update({ status: 'rejected', approved_by: scope.userId, approved_at: now, updated_at: now })
    .eq('fund_id', scope.fundId)
    .eq('created_by', scope.userId)
    .eq('created_via', 'analyst')
    .eq('status', 'pending')
    .in('id', ids)
    .select('id, action_type, vehicle_id')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ id: string; action_type: string; vehicle_id: string | null }>
  for (const row of rows) {
    await recordAudit(admin, {
      fundId: scope.fundId, vehicleId: row.vehicle_id ?? null, actorId: scope.userId, action: 'pending_action.withdraw',
      subjectType: 'pending_action', subjectId: row.id,
      reason: why.reason ?? (why.replacedBy ? 'Replaced by a revised proposal' : null),
      details: { actionType: row.action_type, stagedBy: scope.userId, ...(why.replacedBy ? { replacedBy: why.replacedBy } : {}) },
    })
  }
  return rows.map(r => r.id)
}

/** The system prompt's list of drafts still waiting in this conversation, and what to do with them. */
export function openProposalsBlock(open: OpenProposal[]): string {
  if (open.length === 0) return ''
  const lines = open.map(p => `- ${p.id} (${p.actionType}): ${p.summary}`)
  return [
    '=== PROPOSALS WAITING IN THIS CONVERSATION ===',
    'These changes you drafted earlier in this conversation are still waiting for approval:',
    ...lines,
    '',
    'When you draft a revised version of a forecast, construction, terms, facility, company or capital-call change listed here (same kind of change, same entity and plan or company), the new draft replaces the earlier one automatically, so put every change the person still wants into the revised draft. For any other kind, withdraw the earlier draft yourself when the new one replaces it.',
    'When the person declines one, says they no longer want it, or has clearly moved on to something that makes it obsolete, call withdraw_proposal with its id so it stops asking for approval. Do not withdraw a proposal the person may still approve.',
  ].join('\n')
}
