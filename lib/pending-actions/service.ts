import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess } from '@/lib/access/effective'
import { isRestrictedCredential, type AnalystPrincipal } from '@/lib/ai/analyst/types'
import { getWriteAction } from './registry'

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
    const action = getWriteAction(row.action_type)
    return !!action && hasAccess(principal.access, action.domain, 'read', action.accessFeature)
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
  const action = getWriteAction(row.action_type)
  if (!action) return false
  try {
    await action.preview({ admin, fundId: principal.fundId, userId: principal.userId, access: principal.access }, row.args)
    return true
  } catch {
    return false
  }
}

function authorizeDecision(principal: AnalystPrincipal, row: PendingActionRow) {
  // A restricted credential changes nothing, whatever its grants say. Checked here rather than at
  // each route so approve and reject cannot diverge, and stated as a property of the credential so
  // no request body can assert its way past it.
  if (isRestrictedCredential(principal)) {
    throw new PendingActionServiceError('This credential cannot decide pending actions.', 403, 'RESTRICTED_CREDENTIAL')
  }
  const action = getWriteAction(row.action_type)
  if (!action) throw new PendingActionServiceError('Unknown pending-action type.', 400, 'UNKNOWN_ACTION_TYPE')
  if (!hasAccess(principal.access, action.domain, 'write', action.accessFeature)) {
    throw new PendingActionServiceError('You do not have current write access for this action.', 403, 'FORBIDDEN')
  }
  return action
}

/**
 * Claim before execute so concurrent retries cannot both run the write. The action id is the
 * durable idempotency boundary: once applied, subsequent approved retries return the stored result.
 */
export async function approvePendingAction(
  admin: SupabaseClient,
  principal: AnalystPrincipal,
  id: string,
) {
  const existing = await loadAction(admin, principal.fundId, id)
  // Another entity's action is not found — checked before anything is claimed or changed.
  if (!existing || !(await visibleToCaller(admin, principal, existing))) {
    throw new PendingActionServiceError('Pending action not found.', 404, 'NOT_FOUND')
  }
  const action = authorizeDecision(principal, existing)
  if (existing.status === 'applied') {
    return { ok: true, replayed: true, result: existing.applied_result, action: actionDto(existing) }
  }
  if (existing.status !== 'pending') {
    throw new PendingActionServiceError('Pending action is no longer available.', 409, 'ACTION_NOT_PENDING')
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
      authorizeDecision(principal, latest)
      if (latest.status === 'applied') {
        return { ok: true, replayed: true, result: latest.applied_result, action: actionDto(latest) }
      }
    }
    throw new PendingActionServiceError('Pending action is already being processed.', 409, 'ACTION_IN_PROGRESS')
  }

  try {
    const result = await action.execute({
      admin,
      fundId: principal.fundId,
      userId: principal.userId,
      access: principal.access,
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
    return { ok: true, replayed: false, result, action: actionDto(applied as PendingActionRow) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action execution failed.'
    await (admin as any)
      .from('pending_actions')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
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
  authorizeDecision(principal, existing)
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
  return { ok: true, replayed: false, action: actionDto(data as PendingActionRow) }
}
