// A connected assistant's write, staged for a person to approve.
//
// The Analyst drafts only the handful of writes in lib/pending-actions/registry.ts, each with its
// own hand-written preview. An external assistant (Claude, ChatGPT over OAuth) can call EVERY write
// tool in the agent registry, so its staging can't be per-action: one action type,
// `agent_tool_call`, stores the tool's name and input, and approval runs that tool exactly as a
// direct call would have — through its own handler, re-authorized against the APPROVER's live
// access, never the stager's.
//
// Deliberately NOT in WRITE_ACTIONS. That map is the Analyst's drafting menu, and anything in it is
// offered to the in-app model as a tool. A generic "run any write tool" entry there would hand the
// Analyst every write in the registry behind a read grant. Only lib/pending-actions/staged.ts knows
// about this action.

import { describeSetupPlan, parseSetupPlan } from '@/lib/onboarding/setup-plan'
import { resolveCompany } from './portfolio-tools'
import { resolveInboundDeal } from './deals-tools'
import { resolveDeal } from './diligence-tools'
import { DESTRUCTIVE_PREVIEWS } from './destructive-tools'
import { destructiveRefusal } from './destructive'
import type { Domain } from '@/lib/access/domains'
import { hasAccess } from '@/lib/access/effective'
import type { FeatureKey } from '@/lib/types/features'
import {
  accessDomainForCall, accessFeatureFor, getTool, isLedgerTool, resolveVehicleForTool,
  type AgentTool,
} from '@/lib/accounting/agent-tools'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import type { ActionDeps, PreviewResult } from '@/lib/pending-actions/types'
import { serverAIRefusal } from '@/lib/ai/server-ai'

export const AGENT_TOOL_CALL = 'agent_tool_call'

/** What a staged tool call stores in pending_actions.args. */
export interface ToolCallArgs {
  tool: string
  input: Record<string, unknown>
}

export function toolCallArgs(raw: unknown): ToolCallArgs | null {
  const a = raw as Partial<ToolCallArgs> | null
  if (!a || typeof a.tool !== 'string') return null
  return { tool: a.tool, input: a.input && typeof a.input === 'object' ? a.input as Record<string, unknown> : {} }
}

/**
 * Who may see and decide a staged call: the domain the CALL touches (an `allocation` with
 * action 'carry' is GP economics, not accounting) and the tool's feature switch. Undefined for a
 * tool the registry no longer has, which hides the row rather than guessing its gate.
 */
export function toolCallGate(raw: unknown): { domain: Domain; accessFeature?: FeatureKey } | undefined {
  const args = toolCallArgs(raw)
  const tool = args ? getTool(args.tool) : undefined
  if (!args || !tool || tool.scope !== 'write') return undefined
  return { domain: accessDomainForCall(tool, args.input), accessFeature: accessFeatureFor(tool) }
}

function requireTool(raw: unknown): { tool: AgentTool; args: ToolCallArgs } {
  const args = toolCallArgs(raw)
  const tool = args ? getTool(args.tool) : undefined
  if (!args || !tool || tool.scope !== 'write') throw new Error('Unknown tool in staged call.')
  return { tool, args }
}

/**
 * The entity the call acts on, resolved with the caller's access. Throws when it is outside it.
 *
 * Ledger tools run against exactly one vehicle, resolved the way a direct call resolves it. Other
 * tools take `vehicle` as an optional input; a named one must be visible, and an unnamed one is
 * visible only to a caller who sees every entity, since nothing else says whose data it is.
 */
async function resolveEntity(deps: ActionDeps, tool: AgentTool, input: Record<string, unknown>): Promise<string | null> {
  const requested = typeof input.vehicle === 'string' && input.vehicle.trim() ? input.vehicle : undefined
  if (isLedgerTool(tool)) return resolveVehicleForTool(tool, deps.admin, deps.fundId, requested, deps.access)
  // A change to one deal is the caller's when they can see that deal; the resolvers throw otherwise.
  // Checked before `vehicle`, which on these tools names where the deal MOVES to, not whose it is.
  // Nothing is pinned: the deal is resolved again, with the approver's access, when the call runs.
  if ((tool.domain === 'deals' || tool.domain === 'diligence') && typeof input.deal === 'string' && input.deal.trim()) {
    await (tool.domain === 'deals' ? resolveInboundDeal : resolveDeal)(deps.admin, deps.fundId, input.deal, deps.access)
    if (requested) await resolveVehicleWithAccess(deps.admin, deps.access, requested, 'read')
    return null
  }
  if (requested) return (await resolveVehicleWithAccess(deps.admin, deps.access, requested, 'read')).name
  if (deps.access.vehicles?.all) return null
  // A change about one company (a KPI value, a note, an update) is the stager's when the company is
  // linked to one of their entities; resolveCompany throws otherwise. The approver's access is
  // checked again when the call runs.
  if (typeof input.company === 'string' && input.company.trim()) {
    await resolveCompany(deps.admin, deps.fundId, input.company, deps.access)
    return null
  }
  // A file for an email (add_email_attachment): the stager's when the email is an inbound deal they
  // can see, or about a company they can see.
  if (tool.name === 'add_email_attachment') {
    if (typeof input.deal === 'string' && input.deal.trim()) {
      await resolveInboundDeal(deps.admin, deps.fundId, input.deal, deps.access)
      return null
    }
    const { data: email } = await (deps.admin as any)
      .from('inbound_emails').select('company_id').eq('id', String(input.email ?? '')).eq('fund_id', deps.fundId).maybeSingle()
    if (email?.company_id) {
      await resolveCompany(deps.admin, deps.fundId, email.company_id, deps.access)
      return null
    }
  }
  // A new company names the entities that will hold it; each must be the stager's.
  if (tool.name === 'create_company' && Array.isArray(input.vehicles) && input.vehicles.length > 0) {
    for (const v of input.vehicles) await resolveVehicleWithAccess(deps.admin, deps.access, String(v), 'read')
    return null
  }
  throw new Error(tool.name === 'submit_company_update'
    ? 'Name the company this update is for.'
    : 'This staged change is not about one of your entities.')
}

/** A short, readable line for the approver: the tool, the entity, and the inputs that matter. */
export function summarizeToolCall(tool: string, input: Record<string, unknown>, vehicle: string | null): string {
  const shown = Object.entries(input)
    .filter(([k, v]) => k !== 'vehicle' && v !== undefined && v !== null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
  const where = vehicle ? ` on ${vehicle}` : ''
  return `${tool}${where}${shown.length ? ` (${shown.join(', ')})` : ''}`
}

/** Pin the entity with the stager's access, as stagedTarget does for the Analyst's actions. */
export async function stageToolCall(deps: ActionDeps, toolName: string, input: Record<string, unknown>) {
  const { tool } = requireTool({ tool: toolName, input })
  const vehicle = await resolveEntity(deps, tool, input)
  // A call the server's model has to make could never run on a fund with no key: say so now.
  const noKey = await serverAIRefusal(deps.admin, deps.fundId, tool.name)
  if (noKey) throw new Error(noKey)
  let pinned = vehicle ? { ...input, vehicle } : input
  // A destructive change acts on the record its preview names: the ids it resolved to are pinned.
  const destructive = DESTRUCTIVE_PREVIEWS[toolName]
  if (destructive) pinned = { ...pinned, ...(await destructive(deps, pinned)).pin }
  const vehicleId = vehicle ? await vehicleIdByName(deps.admin, deps.fundId, vehicle) : null
  const args: ToolCallArgs = { tool: toolName, input: pinned }
  return { args, vehicleId, preview: await previewToolCall(deps, args) }
}

export async function previewToolCall(deps: ActionDeps, raw: unknown): Promise<PreviewResult> {
  const { tool, args } = requireTool(raw)
  const vehicle = await resolveEntity(deps, tool, args.input)
  // A setup plan is many changes in one call; the person approving it should see each of them.
  if (tool.name === 'setup_fund') {
    const plan = parseSetupPlan(args.input)
    const lines = 'error' in plan ? [plan.error] : describeSetupPlan(plan)
    return { summary: `Set up the fund: ${lines.join('; ')}`, details: { tool: tool.name, vehicle: null, plan: lines, input: args.input } }
  }
  // Files travel inline; the approver needs their names and sizes, not the bytes.
  const described = describeFiles(args.input.files)
  if (tool.name === 'submit_company_update') {
    const files = described ?? []
    const text = typeof args.input.text === 'string' ? args.input.text : ''
    const parts = [
      files.length ? `${files.length} file${files.length === 1 ? '' : 's'} (${files.map(f => f.filename).join(', ')})` : null,
      text ? `${text.length.toLocaleString('en-US')} characters of text` : null,
    ].filter(Boolean)
    const company = typeof args.input.company === 'string' && args.input.company.trim() ? args.input.company.trim() : 'a company the app will identify'
    return {
      summary: `Process an update for ${company}: ${parts.join(' and ') || 'nothing attached'}. KPIs found are recorded; anything uncertain goes to review.`,
      details: {
        tool: tool.name, vehicle,
        input: { company: args.input.company ?? null, subject: args.input.subject ?? null, text: text.slice(0, 500), files },
      },
    }
  }
  // A destructive change: what it would remove, read now, and that it waits for an admin.
  const destructive = DESTRUCTIVE_PREVIEWS[tool.name]
  if (destructive) {
    const p = await destructive(deps, args.input)
    // reopen_period previews the same way but is not a destructive tool: it can be closed again.
    if (!tool.destructive) {
      return {
        summary: `${p.summary} Needs an admin's approval.`,
        details: { tool: tool.name, vehicle, input: args.input, impact: p.impact },
      }
    }
    return {
      summary: `${p.summary} Cannot be undone; needs an admin's approval.`,
      details: { tool: tool.name, vehicle, input: args.input, destructive: true, impact: p.impact },
    }
  }
  const input = described ? { ...args.input, files: described } : args.input
  const summary = summarizeToolCall(tool.name, input, vehicle)
  return {
    summary: described ? `${summary}, with ${described.map(f => `${f.filename} (${f.kb} KB)`).join(', ')}` : summary,
    details: { tool: tool.name, vehicle, input },
  }
}

function describeFiles(files: unknown): { filename: string; kb: number }[] | null {
  if (!Array.isArray(files)) return null
  return files.map((f: any) => ({
    filename: String(f?.filename ?? 'file'),
    kb: Math.round((String(f?.content_base64 ?? '').length * 3) / 4 / 1024),
  }))
}

/**
 * Run the staged call as the approver. The service has already checked the approver's write
 * access for the call's domain; the vehicle is re-resolved with their access, so an approver who
 * cannot see the entity cannot apply it.
 */
export async function executeToolCall(deps: ActionDeps, raw: unknown): Promise<Record<string, unknown>> {
  const { tool, args } = requireTool(raw)
  // Staged while destructive tools were on, approved after they were turned off: refused.
  const disabled = destructiveRefusal(tool)
  if (disabled) throw new Error(disabled)
  if (!hasAccess(deps.access, accessDomainForCall(tool, args.input), 'write', accessFeatureFor(tool))) {
    throw new Error('You do not have current write access for this change.')
  }
  const requested = typeof args.input.vehicle === 'string' ? args.input.vehicle : undefined
  const portfolioGroup = await resolveVehicleForTool(tool, deps.admin, deps.fundId, requested, deps.access)
  const result = await tool.handler(
    { admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access, origin: deps.origin },
    args.input,
  )
  return { tool: tool.name, result: result ?? null }
}
