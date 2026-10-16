import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAudit } from '@/lib/audit/events'
import { isRestrictedCredential, type AnalystPrincipal } from '@/lib/ai/analyst/types'
import { mayActOn, stagedAction, type StagedAction } from './staged'
import { CONFIRM_IN_APP_MESSAGE } from './call-notices'
import { adminOnlyMessage } from '@/lib/access/admin-only'
import { AGENT_TOOL_CALL } from '@/lib/agent/tool-call-action'
import { AGENT_RUN, RunStepError, runArgs, type RunResult } from '@/lib/agent/run-action'
import { undoTargets } from '@/lib/agent/run-undo'
import { canSeeVehicle } from '@/lib/access/scope'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PendingActionRow {
  id: string
  fund_id: string
  vehicle_id: string | null
  domain: string
  action_type: string
  args: Record<string, unknown>
  preview: { summary: string; details: Record<string, unknown> }
  status: string
  created_by: string
  created_via: string | null
  /** The credential that staged it (migration 20261013143000); absent before that column. */
  created_credential?: string | null
  approved_by: string | null
  approved_at: string | null
  applied_result: Record<string, unknown> | null
  error: string | null
  created_at: string
  updated_at: string
}

export class PendingActionServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

function actionDto(row: PendingActionRow) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    domain: row.domain,
    actionType: row.action_type,
    preview: row.preview,
    status: row.status,
    createdBy: row.created_by,
    createdVia: row.created_via,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    appliedResult: row.applied_result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt: string; id: string }
    const createdAt = new Date(parsed.createdAt)
    if (!UUID.test(parsed.id) || Number.isNaN(createdAt.getTime())) throw new Error('invalid')
    return { createdAt: createdAt.toISOString(), id: parsed.id }
  } catch {
    throw new PendingActionServiceError('The pending-action cursor is invalid.', 400, 'INVALID_CURSOR')
  }
}

function encodeCursor(row: PendingActionRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString('base64url')
}

export async function listPendingActions(
  admin: SupabaseClient,
  principal: AnalystPrincipal,
  options: { limit: number; cursor?: string | null } = { limit: 20 },
) {
  let query: any = admin
    .from('pending_actions' as any)
    .select('*')
    .eq('fund_id', principal.fundId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1)
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor)
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
  }
  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as PendingActionRow[]
  const hasMore = rows.length > options.limit
  // Advance across the scoped database page even when every row in it is hidden. Returning a
  // short (or empty) page with a next cursor is preferable to skipping accessible rows later.
  const consumed = rows.slice(0, options.limit)
  const permitted = consumed.filter(row => {
    const action = stagedAction(row.action_type, row.args)
    return !!action && mayActOn(principal.access, action, 'read')
  })
  // ...and about the caller's entities: a preview names LPs, amounts and companies.
  const inScope = await Promise.all(permitted.map(row => visibleToCaller(admin, principal, row)))
  const visible = permitted.filter((_, i) => inScope[i])
  return {
    actions: visible.map(actionDto),
    nextCursor: hasMore && consumed.length ? encodeCursor(consumed[consumed.length - 1]) : null,
  }
}

async function loadAction(admin: SupabaseClient, fundId: string, id: string): Promise<PendingActionRow | null> {
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .select('*')
    .eq('id', id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PendingActionRow | null) ?? null
}

/**
 * Is this staged action about one of the caller's entities? Each action's preview resolves its
 * company or vehicle through the caller's access and throws on anything outside it, so the preview
 * IS the rule — re-run here rather than restated per action type. Unscoped callers see every action.
 */
async function visibleToCaller(admin: SupabaseClient, principal: AnalystPrincipal, row: PendingActionRow): Promise<boolean> {
  if (principal.access.vehicles.all) return true
  const action = stagedAction(row.action_type, row.args)
  if (!action) return false
  // The entity it was staged for decides first. Re-running a preview alone is not enough: an action
  // staged with no entity named would resolve to the VIEWER's own entity and pass.
  if (row.vehicle_id && !canSeeVehicle(principal.access, row.vehicle_id)) return false
  if (!row.vehicle_id && action.entity === 'required') return false
  try {
    await action.preview({ admin, fundId: principal.fundId, userId: principal.userId, access: principal.access }, row.args)
    return true
  } catch {
    return false
  }
}

function authorizeDecision(principal: AnalystPrincipal, row: PendingActionRow, decision: 'approve' | 'reject') {
  // A restricted credential changes nothing, whatever its grants say. Checked here rather than at
  // each route so approve and reject cannot diverge, and stated as a property of the credential so
  // no request body can assert its way past it.
  if (isRestrictedCredential(principal)) {
    throw new PendingActionServiceError('This credential cannot decide pending actions.', 403, 'RESTRICTED_CREDENTIAL')
  }
  const action = stagedAction(row.action_type, row.args)
  if (!action) throw new PendingActionServiceError('Unknown pending-action type.', 400, 'UNKNOWN_ACTION_TYPE')
  if (!mayActOn(principal.access, action, 'write')) {
    throw new PendingActionServiceError('You do not have current write access for this action.', 403, 'FORBIDDEN')
  }
  // The tier above write (lib/access/admin-only.ts): anyone with write may propose these, and only
  // an admin may decide them. Rejecting is a decision too, so it is held to the same rule.
  // Only APPROVING an admin-only change needs an admin. Rejecting one changes nothing, and the
  // member who proposed it must be able to withdraw it.
  if (decision === 'approve' && action.adminOnly && principal.role !== 'admin') {
    throw new PendingActionServiceError(adminOnlyMessage(action.adminOnly), 403, 'ADMIN_ONLY')
  }
  // A script's key cannot approve what it staged: no person stands behind that approval. A chat
  // may, since it asks its person in the conversation and approves only on their yes (the
  // approve_action tool says so). Rejecting stays open to the stager: withdrawing changes nothing.
  if (decision === 'approve' && selfApprovalRefused(principal, row)) {
    throw new PendingActionServiceError(SELF_APPROVAL_MESSAGE, 403, 'SELF_APPROVAL')
  }
  return action
}

export const SELF_APPROVAL_MESSAGE =
  'This change was staged with this key, so this key cannot approve it. ' +
  'A person approves it in the app, under Approvals, or from their own chat.'

/**
 * Whether this approval is the stager approving itself with nothing behind it: a script's key
 * approving what that key staged. A chat (an `oauth:` credential) approving its own proposal is
 * allowed, because it acts for a person who confirmed the change in the conversation.
 */
export function selfApprovalRefused(
  principal: Pick<AnalystPrincipal, 'userId' | 'credentialId'>,
  row: Pick<PendingActionRow, 'created_by' | 'created_via' | 'created_credential'>,
): boolean {
  return stagedBySameCredential(principal, row) && !principal.credentialId?.startsWith('oauth:')
}

/**
 * Is the approver the very credential (and person) that staged the action? A chat approving its
 * own proposal is no approval at all: before this, only tool-description wording stood between an
 * assistant and calling approve_action on what it had just staged.
 *
 * A cookie session carries no credential id, so the app always decides. Another credential — an
 * admin's own chat, a different connection — may, since that is a separate person or a separate,
 * deliberate door. Rows staged before `created_credential` existed fall back to their channel:
 * staged over MCP by this person, approved by any assistant credential of theirs, is refused.
 */
export function stagedBySameCredential(
  principal: Pick<AnalystPrincipal, 'userId' | 'credentialId'>,
  row: Pick<PendingActionRow, 'created_by' | 'created_via' | 'created_credential'>,
): boolean {
  if (!principal.credentialId) return false
  if (row.created_by !== principal.userId) return false
  if (row.created_credential) return row.created_credential === principal.credentialId
  return row.created_via === 'mcp' && principal.credentialId.startsWith('oauth:')
}

/**
 * Claim before execute so concurrent retries cannot both run the write. The action id is the
 * durable idempotency boundary: once applied, subsequent approved retries return the stored result.
 */
export interface ApproveOptions {
  /**
   * The person's confirmation an action marked `personConfirms` needs (publishing notices to LPs).
   * The browser's approve route sets it after the person confirmed the approval a second time; a
   * chat's approve_action sets it because it runs only on its person's explicit yes.
   */
  confirmed?: boolean
  /**
   * The executors for `personConfirms` actions, supplied by the doors a person stands behind: the
   * browser's approve route (in-process: it ships headless Chromium, lib/pdf-routes.mjs) and a chat's
   * approve_action (through app/api/agent/call-notices/publish, which ships it). A script's key
   * (/api/v1, or a static key over MCP) passes none, and those actions are refused there.
   */
  executors?: Partial<Record<string, StagedAction['execute']>>
  /** The origin the approver reached the app at, for an executor that calls back into it. */
  origin?: string
}

export async function approvePendingAction(
  admin: SupabaseClient,
  principal: AnalystPrincipal,
  id: string,
  opts: ApproveOptions = {},
) {
  const existing = await loadAction(admin, principal.fundId, id)
  // Another entity's action is not found — checked before anything is claimed or changed.
  if (!existing || !(await visibleToCaller(admin, principal, existing))) {
    throw new PendingActionServiceError('Pending action not found.', 404, 'NOT_FOUND')
  }
  const action = authorizeDecision(principal, existing, 'approve')
  if (existing.status === 'applied') {
    return { ok: true, replayed: true, result: existing.applied_result, action: actionDto(existing) }
  }
  if (existing.status !== 'pending') {
    throw new PendingActionServiceError('Pending action is no longer available.', 409, 'ACTION_NOT_PENDING')
  }
  // Checked before anything is claimed, so a refusal leaves the row pending for the app.
  const execute = action.personConfirms ? opts.executors?.[existing.action_type] : action.execute
  if (!execute) throw new PendingActionServiceError(CONFIRM_IN_APP_MESSAGE, 409, 'CONFIRM_IN_APP')
  if (action.personConfirms && opts.confirmed !== true) {
    throw new PendingActionServiceError('Confirm the approval a second time to publish.', 428, 'CONFIRMATION_REQUIRED')
  }

  const now = new Date().toISOString()
  const { data: claimed, error: claimError } = await (admin as any)
    .from('pending_actions')
    .update({ status: 'approved', approved_by: principal.userId, approved_at: now, updated_at: now })
    .eq('id', id)
    .eq('fund_id', principal.fundId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle()
  if (claimError) throw new Error(claimError.message)
  if (!claimed) {
    const latest = await loadAction(admin, principal.fundId, id)
    if (latest) {
      authorizeDecision(principal, latest, 'approve')
      if (latest.status === 'applied') {
        return { ok: true, replayed: true, result: latest.applied_result, action: actionDto(latest) }
      }
    }
    throw new PendingActionServiceError('Pending action is already being processed.', 409, 'ACTION_IN_PROGRESS')
  }

  try {
    const result = await execute({
      admin,
      fundId: principal.fundId,
      userId: principal.userId,
      access: principal.access,
      ...(opts.origin ? { origin: opts.origin } : {}),
    }, existing.args)
    const appliedAt = new Date().toISOString()
    const { data: applied, error } = await (admin as any)
      .from('pending_actions')
      .update({ status: 'applied', applied_result: result, updated_at: appliedAt })
      .eq('id', id)
      .eq('fund_id', principal.fundId)
      .eq('status', 'approved')
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!applied) throw new Error('The approved action could not be finalized.')
    await recordAudit(admin, {
      fundId: principal.fundId, vehicleId: existing.vehicle_id ?? null, actorId: principal.userId, action: 'pending_action.approve',
      subjectType: 'pending_action', subjectId: id,
      details: {
        actionType: existing.action_type, stagedBy: existing.created_by, stagedVia: existing.created_via ?? null, args: existing.args,
        // The chat that staged it approved it, on its person's word in the conversation.
        ...(stagedBySameCredential(principal, existing) ? { approvedFromChat: true, credentialId: principal.credentialId } : {}),
      },
    })
    return { ok: true, replayed: false, result, action: actionDto(applied as PendingActionRow) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action execution failed.'
    // A run that stopped partway keeps what it did, so the person can see it and undo it.
    const partial = error instanceof RunStepError ? error.appliedResult : null
    await (admin as any)
      .from('pending_actions')
      .update({ status: 'failed', error: message, ...(partial ? { applied_result: partial } : {}), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('fund_id', principal.fundId)
      .eq('status', 'approved')
    throw new PendingActionServiceError(message, 422, 'ACTION_FAILED')
  }
}

export async function rejectPendingAction(
  admin: SupabaseClient,
  principal: AnalystPrincipal,
  id: string,
) {
  const existing = await loadAction(admin, principal.fundId, id)
  // Another entity's action is not found — checked before anything is claimed or changed.
  if (!existing || !(await visibleToCaller(admin, principal, existing))) {
    throw new PendingActionServiceError('Pending action not found.', 404, 'NOT_FOUND')
  }
  authorizeDecision(principal, existing, 'reject')
  if (existing.status === 'rejected') return { ok: true, replayed: true, action: actionDto(existing) }
  if (existing.status !== 'pending') {
    throw new PendingActionServiceError('Pending action is no longer available.', 409, 'ACTION_NOT_PENDING')
  }
  const now = new Date().toISOString()
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .update({ status: 'rejected', approved_by: principal.userId, approved_at: now, updated_at: now })
    .eq('id', id)
    .eq('fund_id', principal.fundId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new PendingActionServiceError('Pending action was already decided.', 409, 'ACTION_NOT_PENDING')
  await recordAudit(admin, {
    fundId: principal.fundId, vehicleId: existing.vehicle_id ?? null, actorId: principal.userId, action: 'pending_action.reject',
    subjectType: 'pending_action', subjectId: id,
    details: {
      actionType: existing.action_type, stagedBy: existing.created_by,
      // A staged tool call's gate is its tool's, read back from its args (lib/audit/read.ts).
      ...(existing.action_type === AGENT_TOOL_CALL ? { args: existing.args } : {}),
    },
  })
  return { ok: true, replayed: false, action: actionDto(data as PendingActionRow) }
}

/**
 * Runs that have been decided and carry a result: applied, or failed partway. The Approvals page
 * shows them under the queue with each step's result, the checks' outcomes and Undo. Filtered as
 * the queue is: every step's domain, and the caller's entities.
 */
export async function listAgentRuns(admin: SupabaseClient, principal: AnalystPrincipal, limit = 20) {
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .select('*')
    .eq('fund_id', principal.fundId)
    .eq('action_type', AGENT_RUN)
    .in('status', ['applied', 'failed'])
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as PendingActionRow[]).filter(row => {
    const action = stagedAction(row.action_type, row.args)
    return !!action && mayActOn(principal.access, action, 'read')
  })
  const inScope = await Promise.all(rows.map(row => visibleToCaller(admin, principal, row)))
  return { runs: rows.filter((_, i) => inScope[i]).map(actionDto) }
}

/**
 * Take back what an approved (or partly applied) run created, where that is safe
 * (lib/agent/run-undo.ts). Needs the same right as approving it — write in every step's domain,
 * from a credential that is not the one that staged it — plus, per entry, whatever voiding or
 * deleting that thing needs on its own (an admin, for a posted entry).
 *
 * Claimed with the row's `updated_at`, so two clicks cannot both run it. A target already undone
 * reports as such, so a partial undo can be retried.
 */
export async function undoAgentRun(admin: SupabaseClient, principal: AnalystPrincipal, id: string) {
  const existing = await loadAction(admin, principal.fundId, id)
  if (!existing || !(await visibleToCaller(admin, principal, existing))) {
    throw new PendingActionServiceError('Pending action not found.', 404, 'NOT_FOUND')
  }
  if (existing.action_type !== AGENT_RUN) {
    throw new PendingActionServiceError('Only a run can be undone here.', 400, 'NOT_A_RUN')
  }
  authorizeDecision(principal, existing, 'approve')
  const prior = existing.applied_result as unknown as RunResult | null
  if (!prior?.run || (existing.status !== 'applied' && existing.status !== 'failed')) {
    throw new PendingActionServiceError('This run has not been applied, so there is nothing to undo.', 409, 'NOTHING_TO_UNDO')
  }
  if (prior.undo?.status === 'done') return { ok: true, replayed: true, action: actionDto(existing) }
  if (prior.undo?.status === 'running') {
    throw new PendingActionServiceError('This run is already being undone.', 409, 'UNDO_IN_PROGRESS')
  }
  const steps = prior.run.steps
    .filter(s => s.status === 'applied' && (s.undo?.length ?? 0) > 0)
    .map(s => ({ step: s.step, targets: s.undo! }))
  if (steps.length === 0) {
    throw new PendingActionServiceError('Nothing this run did can be undone from the app.', 409, 'NOTHING_TO_UNDO')
  }

  const startedAt = new Date().toISOString()
  const running: RunResult = { ...prior, undo: { status: 'running', by: principal.userId, at: startedAt } }
  const { data: claimed, error: claimError } = await (admin as any)
    .from('pending_actions')
    .update({ applied_result: running, updated_at: startedAt })
    .eq('id', id)
    .eq('fund_id', principal.fundId)
    .eq('updated_at', existing.updated_at)
    .select('*')
    .maybeSingle()
  if (claimError) throw new Error(claimError.message)
  if (!claimed) throw new PendingActionServiceError('This run changed while it was being undone. Reload and try again.', 409, 'UNDO_IN_PROGRESS')

  // Targets an earlier, partial undo already took back are skipped.
  const done = new Set((prior.undo?.outcomes ?? []).filter(o => o.status === 'undone' || o.status === 'already').map(o => `${o.target.kind}:${o.target.id}`))
  const pending = steps
    .map(s => ({ step: s.step, targets: s.targets.filter(t => !done.has(`${t.kind}:${t.id}`)) }))
    .filter(s => s.targets.length > 0)
  const title = runArgs(existing.args)?.title ?? 'run'
  const fresh = await undoTargets(
    { admin, fundId: principal.fundId, userId: principal.userId, access: principal.access, role: principal.role },
    pending,
    { runId: id, title },
  )
  const outcomes = [...(prior.undo?.outcomes ?? []).filter(o => done.has(`${o.target.kind}:${o.target.id}`)), ...fresh]
  const complete = outcomes.length > 0 && outcomes.every(o => o.status === 'undone' || o.status === 'already')
  const finishedAt = new Date().toISOString()
  const result: RunResult = { ...prior, undo: { status: complete ? 'done' : 'partial', by: principal.userId, at: finishedAt, outcomes } }
  const { data: saved, error } = await (admin as any)
    .from('pending_actions')
    .update({ applied_result: result, updated_at: finishedAt })
    .eq('id', id)
    .eq('fund_id', principal.fundId)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  await recordAudit(admin, {
    fundId: principal.fundId, vehicleId: existing.vehicle_id ?? null, actorId: principal.userId, action: 'pending_action.undo',
    subjectType: 'pending_action', subjectId: id,
    details: {
      actionType: existing.action_type, stagedBy: existing.created_by, args: existing.args,
      outcomes: fresh.map(o => ({ step: o.step, kind: o.target.kind, id: o.target.id, status: o.status, message: o.message ?? null })),
    },
  })
  return { ok: true, replayed: false, action: actionDto((saved ?? { ...existing, applied_result: result }) as PendingActionRow) }
}
