import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AGENT_TOOLS,
  getTool,
  accessDomainFor,
  accessDomainForCall,
  accessFeatureFor,
  resolveVehicleForTool,
} from '@/lib/accounting/agent-tools'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import type { ToolDefinition, ToolExecutor, ToolInvocation } from '@/lib/ai/types'
import { WRITE_ACTIONS, getWriteAction } from '@/lib/pending-actions/registry'
import type { ActionType, PreviewResult } from '@/lib/pending-actions/types'
import { stagedTarget } from '@/lib/pending-actions/target'
import { ENTITY_DOCUMENTS_TOOL, runEntityDocumentsTool } from '@/lib/entity-documents/analyst'

/** A write the Analyst staged this turn — surfaced so the caller can render approval cards. */
export interface StagedActionRecord {
  id: string
  actionType: ActionType
  preview: PreviewResult
}

/** A successfully completed read tool, retained for deterministic presentation builders. */
export interface CompletedAnalystTool {
  name: string
  input: Record<string, unknown>
  result: unknown
}

export interface AnalystToolDeps {
  admin: SupabaseClient
  fundId: string
  userId: string | null
  access: AccessContext
  vehicle?: string
  /** The entity the Analyst is opened on (any domain), for the governing-documents tool's default. */
  entity?: string | null
  /**
   * Expose WRITE actions as drafting tools. They never execute from the model — a call runs the
   * read-only preview and stages a `pending_actions` row for human approval. Drafting normally
   * needs domain READ; an action may require WRITE. Approval always requires WRITE.
   */
  enableDrafts?: boolean
  /** Recorded on staged rows, e.g. 'analyst'. */
  createdVia?: string | null
  /** Executor pushes each staged write here (when provided) for the caller to render. */
  stagedActions?: StagedActionRecord[]
  /** Executor pushes validated read results here; never populated for failed or write tools. */
  completedTools?: CompletedAnalystTool[]
}

/**
 * Turns the access-filtered agent-tool registry into `{ tools, executeTool }` for a provider's
 * `createToolLoop`. READ tools execute live, each gated by `hasAccess(read)` on the tool's access
 * domain (re-checked per call, since some tools' domain depends on their input). With
 * `enableDrafts`, WRITE actions are added as tools that STAGE a `pending_actions` row instead of
 * executing. Scope from the request narrows what appears; it never widens the caller's access.
 */
export function buildAnalystTools(deps: AnalystToolDeps): { tools: ToolDefinition[]; executeTool: ToolExecutor } {
  const readTools = AGENT_TOOLS.filter(
    t => t.scope === 'read' && hasAccess(deps.access, accessDomainFor(t), 'read', accessFeatureFor(t)),
  )
  const tools: ToolDefinition[] = readTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))

  // Write actions appear as drafting tools only when the caller clears that action's stage level.
  if (deps.enableDrafts) {
    for (const [name, action] of Object.entries(WRITE_ACTIONS)) {
      if (!hasAccess(deps.access, action.domain, action.stageAccess ?? 'read', action.accessFeature)) continue
      tools.push({ name, description: action.description, inputSchema: action.inputSchema })
    }
  }

  // Governing documents follow entity access, not a domain grant: offered to every caller, scoped
  // inside the tool to the entities they can see.
  tools.push(ENTITY_DOCUMENTS_TOOL)

  const executeTool: ToolExecutor = async (call: ToolInvocation) => {
    if (call.name === ENTITY_DOCUMENTS_TOOL.name) {
      try {
        const result = await runEntityDocumentsTool(
          { admin: deps.admin, fundId: deps.fundId, access: deps.access, defaultEntity: deps.entity ?? deps.vehicle ?? null },
          call.input,
        )
        deps.completedTools?.push({ name: call.name, input: call.input, result })
        return JSON.stringify(result)
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message })
      }
    }

    // Write actions: stage for approval, never execute here.
    if (deps.enableDrafts) {
      const action = getWriteAction(call.name)
      if (action) {
        if (!hasAccess(deps.access, action.domain, action.stageAccess ?? 'read', action.accessFeature)) {
          return JSON.stringify({ error: 'Access denied' })
        }
        if (!deps.userId) return JSON.stringify({ error: 'Sign in required to stage an action' })
        try {
          const actionDeps = { admin: deps.admin, fundId: deps.fundId, userId: deps.userId, access: deps.access }
          // Pin the entity now, with the stager's access (lib/pending-actions/target.ts).
          const target = await stagedTarget(actionDeps, action, call.input)
          const preview = await action.preview(actionDeps, target.input)
          const { data, error } = await deps.admin
            .from('pending_actions')
            .insert({
              fund_id: deps.fundId,
              domain: action.domain,
              action_type: call.name,
              args: target.input,
              vehicle_id: target.vehicleId,
              preview,
              status: 'pending',
              created_by: deps.userId,
              created_via: deps.createdVia ?? 'analyst',
            })
            .select('id')
            .single()
          if (error) return JSON.stringify({ error: error.message })
          const id = (data as { id: string }).id
          deps.stagedActions?.push({ id, actionType: call.name as ActionType, preview })
          return `Staged pending action ${id} for approval: ${preview.summary}`
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message })
        }
      }
    }

    // Read tools: execute live.
    const tool = getTool(call.name)
    if (!tool || tool.scope !== 'read') {
      return JSON.stringify({ error: `Unknown or non-readable tool: ${call.name}` })
    }
    if (!hasAccess(deps.access, accessDomainForCall(tool, call.input), 'read', accessFeatureFor(tool))) {
      return JSON.stringify({ error: 'Access denied' })
    }
    try {
      const vehicle = (call.input as { vehicle?: string })?.vehicle ?? deps.vehicle
      const portfolioGroup = await resolveVehicleForTool(tool, deps.admin, deps.fundId, vehicle, deps.access)
      const result = await tool.handler(
        { admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access },
        call.input,
      )
      deps.completedTools?.push({ name: call.name, input: call.input, result })
      return JSON.stringify(result)
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message })
    }
  }

  return { tools, executeTool }
}
