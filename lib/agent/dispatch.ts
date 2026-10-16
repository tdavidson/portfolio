// One path for every agent tool call, whichever door it came through (MCP or the REST agent API).
//
// Before this, both routes called `tool.handler` themselves, so a write from Claude reached the
// books with nothing around it: no audit event (the web journal route records `entry.post`; the
// MCP `post_entry` did not), no record of which credential or channel made it, no protection
// against a host retrying a timed-out call, and no chance for a person to look before it landed.
// This module is where all four live, so a tool added to the registry gets them without asking.
//
//   1. Idempotency. A write may carry a key; a retry under it replays the first result instead of
//      writing twice (the /api/v1 store, lib/api-v1/idempotency.ts). A chat assistant's write that
//      would be staged and carries NO key gets one derived from what it asks (see
//      `assistantDedupeKey`), so the same change asked twice — a retry, or two chats — is staged once.
//   2. Staging. A chat assistant's write (an OAuth credential) is staged as a pending action and
//      applied only when a person approves it. An API key — a script someone wrote on purpose —
//      writes directly, as before. Calls that only make drafts or previews always run directly:
//      a draft is already a proposal someone has to post.
//   3. Audit. Every write that runs, and every one that is staged, leaves an append-only
//      `accounting_audit_events` row naming the person, the source (mcp or api) and the credential.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import {
  accessDomainForCall, accessFeatureFor, getTool, isLedgerTool, resolveVehicleForTool, type AgentTool,
} from '@/lib/accounting/agent-tools'
import { authorizeToolUse } from '@/lib/accounting/api-keys'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { recordAudit } from '@/lib/audit/events'
import type { ChangeSource } from '@/lib/audit/source'
import {
  canonicalJson, claimIdempotentRequest, completeIdempotentRequest, releaseIdempotentRequest, requestFingerprint,
  IDEMPOTENCY_MAX_KEY_LENGTH, type IdempotencyOutcome, type IdempotencyScope,
} from '@/lib/api-v1/idempotency'
import { AGENT_TOOL_CALL, stageToolCall } from './tool-call-action'
import { destructiveRefusal } from './destructive'
import { AGENT_RUN, runAdminOnlyLabel, stageRun, type RunArgs } from './run-action'
import { notifyAdminsOfStagedChange } from '@/lib/pending-actions/notify'
import { ADMIN_ONLY_ACTIONS, adminOnlyMessage, adminOnlyToolLabel } from '@/lib/access/admin-only'
import { getWriteAction } from '@/lib/pending-actions/registry'
import { previewBlockers } from '@/lib/pending-actions/blockers'
import { stagedTarget } from '@/lib/pending-actions/target'
import type { ActionDeps } from '@/lib/pending-actions/types'

/** Which door a call came through. Recorded on every write, as `source` (lib/audit/source.ts). */
export type AgentChannel = Extract<ChangeSource, 'mcp' | 'api'>

export interface AgentCall {
  admin: SupabaseClient
  tool: AgentTool
  input: Record<string, unknown>
  auth: ResolvedKey
  access: AccessContext
  channel: AgentChannel
  origin?: string
  /** Optional, writes only. A retry with the same key and input returns the first result. */
  idempotencyKey?: string | null
}

/** What a staged write returns in place of the tool's own result. */
export interface StagedResult {
  staged: true
  pendingActionId: string
  summary: string
  preview: Record<string, unknown>
  /** The app's approvals page, when the request's origin is known. */
  approveUrl?: string
  next: string
}

/** OAuth credentials are a chat assistant acting for someone; static keys are scripts. */
export function isAssistantCredential(auth: Pick<ResolvedKey, 'keyId'>): boolean {
  return auth.keyId.startsWith('oauth:')
}

/**
 * Calls that only create drafts or previews. They change nothing anyone relies on until a
 * person posts the draft, and posting is itself a write that stages, so staging these too would
 * only make the assistant ask twice.
 */
const DRAFT_ONLY: Record<string, (input: Record<string, unknown>) => boolean> = {
  post_entry: input => input.status === 'draft',
  post_ledger_text: input => input.status === 'draft',
  allocation: input => input.post === false,
  // The memo agent run on the person's own model: it writes only into the open memo draft, which the
  // agent can never finalise (diligence_finalize_memo stages), and starting the stage already staged.
  diligence_stage_next: () => true,
  diligence_stage_submit: () => true,
  // Stage a feed as drafts and re-point those drafts; posting them is post_bank_transaction / post_drafts.
  import_bank_transactions: () => true,
  // An outside ledger lands as drafts too (lib/accounting/quickbooks/import-journal.ts); a mapping
  // change is not a draft and still stages.
  import_journal: () => true,
  categorize_bank_transactions: () => true,
  set_bank_transaction_account: () => true,
  // Filling a saved template makes a draft document for the person to read before sending; it
  // changes nothing else. Saving the template itself still stages.
  document_generate: () => true,
  // Always a NEW letter, status draft, shared with no one (lib/lp-letters/draft-from-brief.ts). Editing,
  // completing and sharing a letter still stage.
  lp_draft_letter: () => true,
  // The LP portal tools' previews and dry runs (lib/agent/lp-portal-tools.ts): they send and change
  // nothing, and exist so the person sees the recipients and the email before saying yes. The send
  // or commit itself stages. Admin-only like the rest of these tools: the handler checks the role.
  lp_portal_invite: input => input.preview === true,
  lp_portal_resend_invite: input => input.preview === true,
  lp_authorized_user_add: input => input.preview === true,
  lp_announce: input => input.preview === true,
  lp_send_item: input => input.preview === true,
  lp_portal_invite_bulk: input => input.commit !== true,
}

export function isDraftOnlyCall(tool: Pick<AgentTool, 'name'>, input: Record<string, unknown>): boolean {
  return DRAFT_ONLY[tool.name]?.(input) ?? false
}

/** Whether some calls of this tool are draft-only (search_tools says so beside "staged"). */
export function hasDraftMode(name: string): boolean {
  return name in DRAFT_ONLY
}

/**
 * Whether this write waits for a person. Reads never do. A tool that `stagesAs` a pending action
 * (what goes out to LPs) always does, from a script's key too: a person approves it, in the app or
 * from their own chat. So does a `destructive` tool (a delete, a merge, undoing posted books), from
 * any credential, an admin's own API key included: it is staged as the ordinary tool call, and an
 * admin approves it (lib/agent/destructive.ts).
 */
export function shouldStage(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId'>): boolean {
  if (tool.scope !== 'write') return false
  if (tool.stagesAs || tool.destructive) return true
  if (tool.runsDirectly) return false
  return isAssistantCredential(auth) && !isDraftOnlyCall(tool, input)
}

/**
 * An admin-only operation (lib/access/admin-only.ts) from someone who is not an admin. From chat
 * it is still staged, so they can propose it and an admin decides; from a key it is refused, since
 * a key has no one to ask.
 */
export function adminOnlyRefusal(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId' | 'role'>): string | null {
  const label = adminOnlyToolLabel(tool.name, input)
  if (!label || auth.role === 'admin' || isAssistantCredential(auth)) return null
  return adminOnlyMessage(label)
}

/** A key the caller sent, or null when it is absent or unusable. */
export function idempotencyKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return key && key.length <= IDEMPOTENCY_MAX_KEY_LENGTH ? key : null
}

/**
 * The input as the audit trail keeps it: whole when small, otherwise its size. A bank CSV or a
 * ledger text can run to megabytes, and the trail is read by a person, not replayed.
 */
const AUDIT_INPUT_LIMIT = 20_000
export function auditInput(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input)
  return json.length <= AUDIT_INPUT_LIMIT ? input : { truncated: true, bytes: json.length }
}

/** The ids a result names, so the trail can point at what changed without copying the payload. */
function resultRefs(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {}
  const refs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if ((/Id$|^id$/.test(k) && (typeof v === 'string' || typeof v === 'number')) || ((k === 'posted' || k === 'imported') && typeof v === 'number')) {
      refs[k] = v
    }
  }
  return refs
}

/**
 * How long an assistant's identical write is treated as the same request. Long enough to cover a
 * second chat opened the same day on the same task (which is how a carry reallocation was booked
 * twice); short enough that the same routine entry next week is a new request.
 */
export const ASSISTANT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000
/** The derived keys' client: every OAuth client of one person shares it, so a second host is caught too. */
const ASSISTANT_DEDUPE_CLIENT = 'assistant:derived'

/**
 * The key an assistant's write is deduplicated under when it sent none, or null when it is not
 * deduplicated. Only writes that will be STAGED: replaying the first pending action for an
 * identical request is always right, because staging changes nothing and the replay names the same
 * action to approve. Draft-only calls (DRAFT_ONLY) run directly and are left alone — their result
 * depends on the books at the time (a categorization re-run, a bank row pointed back to its first
 * account, a regenerated document, a ledger text re-sent after its unknown account was added), so
 * replaying a stale result would be wrong, and a duplicate draft still has to be posted through a
 * call that stages. Per person (the key names them), across every assistant host they use.
 */
export async function assistantDedupeKey(call: AgentCall): Promise<{ key: string; fingerprint: string; scope: IdempotencyScope } | null> {
  const { admin, tool, input, auth, access } = call
  if (!shouldStage(tool, input, auth)) return null
  // The entity as it will be staged, so "vehicle omitted" and "vehicle named" are the same request.
  const vehicle = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
  const rest = vehicle ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'vehicle')) : input
  const fingerprint = requestFingerprint({ canonical: canonicalJson({ tool: tool.name, vehicle: vehicle || null, input: rest }) })
  return {
    key: `derived:${auth.userId ?? 'anyone'}:${fingerprint}`,
    fingerprint,
    scope: { fundId: auth.fundId, clientId: ASSISTANT_DEDUPE_CLIENT, userId: auth.userId },
  }
}

/** A staged action's current status, or null when the result is not a staged one or cannot be read. */
async function stagedStatus(admin: SupabaseClient, fundId: string, result: unknown): Promise<string | null> {
  const id = (result as Partial<StagedResult> | null)?.pendingActionId
  if (!(result as Partial<StagedResult> | null)?.staged || typeof id !== 'string') return null
  const { data, error } = await (admin as any).from('pending_actions').select('status').eq('id', id).eq('fund_id', fundId).maybeSingle()
  return error ? null : ((data as { status?: string } | null)?.status ?? null)
}

/** What a repeat of an already-staged request returns: the first action, and what to do about it. */
function repeatOfStaged(prior: StagedResult, status: string | null): StagedResult & { duplicate: true; status: string | null } {
  const id = prior.pendingActionId
  const done = status === 'approved' || status === 'applied'
  return {
    ...prior,
    duplicate: true,
    status,
    next: done
      ? `Nothing was staged: this exact change was already requested (pending action "${id}") and has been ${status} — possibly from another chat. ` +
        'Do NOT approve or send it again; tell the user it is already done. Only if the user explicitly confirms they want the same change ' +
        'made a SECOND time, call the tool again with _meta.idempotencyKey (or the Idempotency-Key header) set to a new unique value.'
      // The first staging's own instructions still apply (they differ for an admin-only change).
      : `Nothing new was staged: this exact change is already waiting for approval as pending action "${id}" — possibly from another chat; ` +
        'approve it once, not once per request. ' + prior.next + ' ' +
        'Only if the user explicitly wants the same change made twice, call the tool again with _meta.idempotencyKey set to a new unique value.',
  }
}

export class AgentCallError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/**
 * Run one authorized tool call. The caller has already checked the credential and the owner's
 * grants for this call (authorizeToolUse / authorizeMcpTool); this adds what every write needs.
 */
export async function runAgentTool(call: AgentCall): Promise<unknown> {
  const { admin, tool, input, auth, access, origin } = call
  // Destructive tools exist only where the deployment turned them on (AGENT_DESTRUCTIVE_ACTIONS).
  // Every door reaches here: a direct MCP call, call_tool, and POST /api/agent.
  const disabled = destructiveRefusal(tool)
  if (disabled) throw new AgentCallError(disabled, 'DESTRUCTIVE_DISABLED')
  if (tool.scope === 'read') {
    const portfolioGroup = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
    return tool.handler({ admin, fundId: auth.fundId, portfolioGroup, userId: auth.userId, access, origin }, input)
  }

  const refusal = adminOnlyRefusal(tool, input, auth)
  if (refusal) throw new AgentCallError(refusal, 'ADMIN_ONLY')

  // An explicit key always wins; without one, an assistant's staged write gets a derived one.
  const derived = call.idempotencyKey ? null : await assistantDedupeKey(call)
  const scope: IdempotencyScope = derived?.scope ?? { fundId: auth.fundId, clientId: auth.keyId, userId: auth.userId }
  const key = call.idempotencyKey ?? derived?.key ?? null
  const endpoint = `agent:${tool.name}`
  if (key) {
    const claim = (): Promise<IdempotencyOutcome> => claimIdempotentRequest(admin, scope, derived
      ? { endpoint, key, fingerprint: derived.fingerprint, windowMs: ASSISTANT_DEDUPE_WINDOW_MS }
      : { endpoint, key, fingerprint: requestFingerprint({ tool: tool.name, input }) })
    let outcome = await claim()
    if (derived && outcome.kind === 'replay') {
      const prior = (outcome.body as { result?: unknown }).result ?? null
      const status = await stagedStatus(admin, auth.fundId, prior)
      // Declined, or tried and failed: nothing was applied, so asking again is a new request.
      if (status === 'rejected' || status === 'failed') {
        await releaseIdempotentRequest(admin, scope, { endpoint, key })
        outcome = await claim()
      } else if (prior && (prior as StagedResult).staged) {
        return repeatOfStaged(prior as StagedResult, status)
      }
    }
    if (outcome.kind === 'replay') return (outcome.body as { result?: unknown }).result ?? null
    if (outcome.kind === 'conflict') throw new AgentCallError(outcome.message, outcome.code)
  }

  try {
    const result = shouldStage(tool, input, auth) ? await stage(call) : await apply(call)
    if (key) await completeIdempotentRequest(admin, scope, { endpoint, key, status: 200, body: { result: result as any } })
    return result
  } catch (e) {
    if (key) await releaseIdempotentRequest(admin, scope, { endpoint, key })
    throw e
  }
}

/** Run the write now, as its owner, and record it. */
async function apply(call: AgentCall): Promise<unknown> {
  const { admin, tool, input, auth, access, origin, channel } = call
  const portfolioGroup = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
  const result = await tool.handler({ admin, fundId: auth.fundId, portfolioGroup, userId: auth.userId, access, origin }, input)
  const vehicleId = isLedgerTool(tool) && portfolioGroup ? await vehicleIdByName(admin, auth.fundId, portfolioGroup) : null
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'agent.write',
    subjectType: 'agent_tool', subjectId: tool.name, source: channel,
    details: {
      tool: tool.name, credentialId: auth.keyId,
      domain: accessDomainForCall(tool, input), feature: accessFeatureFor(tool) ?? null,
      input: auditInput(input), result: resultRefs(result),
    },
  })
  return result
}

/**
 * Insert a pending_actions row, naming the credential that staged it. Until migration
 * 20261013143000 is pushed the column is missing (Postgres' undefined column); the row is then
 * written without it and the service falls back to its channel, so the deploy and the push may
 * land in either order.
 */
async function insertStaged(admin: SupabaseClient, row: Record<string, unknown>, credentialId: string): Promise<string> {
  const insert = (r: Record<string, unknown>) => (admin as any).from('pending_actions').insert(r).select('id').single()
  let { data, error } = await insert({ ...row, created_credential: credentialId })
  if (error?.code === '42703') ({ data, error } = await insert(row))
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

/** The app's approvals page, when the request's origin is known. */
function approveUrlFor(origin: string | undefined): string | undefined {
  return origin ? `${origin}/pending-actions` : undefined
}

/**
 * What the assistant is told to do with a staged change. A chat asks its person in the
 * conversation and approves on their explicit yes; a script's key cannot approve what it staged
 * (the service refuses it), so it hands over the link.
 */
function nextStep(opts: { id: string; approveUrl?: string; adminLabel?: string | null; emailed: number; isAdmin: boolean; chat: boolean }): string {
  const inApp = opts.approveUrl ? `in the app at ${opts.approveUrl}` : 'in the app, under Approvals'
  if (opts.adminLabel && !opts.isAdmin) {
    return `Nothing has changed yet. ${adminOnlyMessage(opts.adminLabel)}${opts.emailed ? " The fund's admins have been emailed." : ''} ` +
      `Tell the user it is waiting for an admin, who approves it ${inApp}.`
  }
  if (opts.chat) {
    return 'Nothing has changed yet. Show the user this change in plain words and ask them to approve it here. ' +
      `Only after they explicitly say yes, call approve_action with id "${opts.id}"; if they decline, call reject_action. ` +
      `They can also approve it ${inApp}. When a fix needs several changes, stage them together with stage_run so they are approved once. ` +
      'If a tool named here is not in your tool list (a stale list), run it through call_tool.'
  }
  return 'Nothing has changed yet. Show the user this change in plain words, then give them the link to approve it ' +
    `${inApp}. This key cannot approve its own changes: approve_action on id "${opts.id}" from here is refused. ` +
    'If they decline, call reject_action. When a fix needs several changes, stage them together with stage_run so they are approved once. ' +
    'If a tool named here is not in your tool list (a stale list), run it through call_tool.'
}

/**
 * What a `stagesAs` tool stages: its own pending action, previewed and pinned to its entity the way
 * the Analyst's are (lib/pending-actions/target.ts), rather than a generic tool call.
 */
async function stageAsAction(deps: ActionDeps, actionType: string, input: Record<string, unknown>) {
  const action = getWriteAction(actionType)
  if (!action) throw new Error(`Unknown pending action "${actionType}".`)
  const target = await stagedTarget(deps, action, input)
  const preview = await action.preview(deps, target.input)
  const blocked = previewBlockers(preview)
  if (blocked) throw new AgentCallError(blocked, 'BLOCKED')
  return {
    actionType, domain: action.domain, args: target.input as Record<string, unknown>, vehicleId: target.vehicleId,
    preview, adminLabel: ADMIN_ONLY_ACTIONS[actionType] ?? null, auditArgs: target.input as Record<string, unknown>,
  }
}

/** Stage the write as a pending action for a person to approve. Nothing else changes. */
async function stage(call: AgentCall): Promise<StagedResult> {
  const { admin, tool, input, auth, access, channel, origin } = call
  const deps = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const staged = tool.stagesAs
    ? await stageAsAction(deps, tool.stagesAs, input)
    : await stageToolCall(deps, tool.name, input).then(s => ({
      actionType: AGENT_TOOL_CALL, domain: accessDomainForCall(tool, input), args: s.args as unknown as Record<string, unknown>,
      vehicleId: s.vehicleId, preview: s.preview, adminLabel: adminOnlyToolLabel(tool.name, input) ?? null, auditArgs: s.args.input,
    }))
  const { args, vehicleId, preview } = staged
  const id = await insertStaged(admin, {
    fund_id: auth.fundId,
    domain: staged.domain,
    action_type: staged.actionType,
    args,
    vehicle_id: vehicleId,
    preview,
    status: 'pending',
    created_by: auth.userId,
    created_via: channel,
  }, auth.keyId)
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'pending_action.stage',
    subjectType: 'pending_action', subjectId: id, source: channel,
    details: { actionType: staged.actionType, args: { tool: tool.name, input: auditInput(staged.auditArgs) }, credentialId: auth.keyId },
  })
  // An admin-only change from a member waits on someone outside this conversation: tell them.
  const adminLabel = staged.adminLabel
  const emailed = adminLabel && auth.role !== 'admin'
    ? await notifyAdminsOfStagedChange(admin, { fundId: auth.fundId, label: adminLabel, summary: preview.summary, requesterId: auth.userId, origin })
    : 0
  const approveUrl = approveUrlFor(origin)
  return {
    staged: true,
    pendingActionId: id,
    summary: preview.summary,
    preview: preview.details,
    ...(approveUrl ? { approveUrl } : {}),
    next: nextStep({ id, approveUrl, adminLabel, emailed, isAdmin: auth.role === 'admin', chat: isAssistantCredential(auth) }),
  }
}

export interface RunCall {
  admin: SupabaseClient
  auth: ResolvedKey
  access: AccessContext
  channel: AgentChannel
  origin?: string
}

/**
 * Stage a whole run as ONE pending action (lib/agent/run-action.ts). Every step is checked the way
 * the same call made directly would be — the credential's scope and the owner's grant for that
 * call's domain, admin-only rules for a key — before anything is written. Always staged, whatever
 * the credential: a run exists to be looked at once by a person.
 */
export async function stageAgentRun(call: RunCall, input: unknown): Promise<StagedResult & { steps: number }> {
  const { admin, auth, access, channel, origin } = call
  const deps = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const { args, vehicleId, preview } = await stageRun(deps, input, (name, stepInput) => {
    const tool = getTool(name)!
    return destructiveRefusal(tool)
      ?? authorizeToolUse(tool.scope, auth, access, accessDomainForCall(tool, stepInput), accessFeatureFor(tool))
      ?? adminOnlyRefusal(tool, stepInput, auth)
  })
  const first = getTool(args.steps[0].tool)!
  const id = await insertStaged(admin, {
    fund_id: auth.fundId,
    // The column holds one domain; the service gates a run on every step's (lib/pending-actions/staged.ts).
    domain: accessDomainForCall(first, args.steps[0].input),
    action_type: AGENT_RUN,
    args,
    vehicle_id: vehicleId,
    preview,
    status: 'pending',
    created_by: auth.userId,
    created_via: channel,
  }, auth.keyId)
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'pending_action.stage',
    subjectType: 'pending_action', subjectId: id, source: channel,
    details: { actionType: AGENT_RUN, args: auditRunArgs(args), credentialId: auth.keyId },
  })
  const adminLabel = runAdminOnlyLabel(args)
  const emailed = adminLabel && auth.role !== 'admin'
    ? await notifyAdminsOfStagedChange(admin, { fundId: auth.fundId, label: adminLabel, summary: preview.summary, requesterId: auth.userId, origin })
    : 0
  const approveUrl = approveUrlFor(origin)
  return {
    staged: true,
    pendingActionId: id,
    steps: args.steps.length,
    summary: preview.summary,
    preview: preview.details,
    ...(approveUrl ? { approveUrl } : {}),
    next: nextStep({ id, approveUrl, adminLabel, emailed, isAdmin: auth.role === 'admin', chat: isAssistantCredential(auth) }),
  }
}

/** A run's args as the trail keeps them: each step's input whole when small. */
function auditRunArgs(args: RunArgs): Record<string, unknown> {
  return { ...args, steps: args.steps.map(s => ({ tool: s.tool, input: auditInput(s.input) })) }
}
