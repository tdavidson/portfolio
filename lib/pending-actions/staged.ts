// Every action type a pending_actions row may hold, and the gate each row answers to.
//
// Three families share the table: the Analyst's drafts (WRITE_ACTIONS, one fixed domain each), an
// external assistant's staged tool calls (lib/agent/tool-call-action.ts), whose domain is the
// staged tool's, and an assistant's runs (lib/agent/run-action.ts), which answer to every step's
// domain at once (`gates`). Deciding, listing and reading the audit trail all go through
// `stagedAction` and `stagedGates`, so every family is gated the same way. The Analyst's drafting menu still reads WRITE_ACTIONS
// directly and never sees the tool-call type.

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import { getWriteAction } from './registry'
import { ADMIN_ONLY_ACTIONS, adminOnlyToolLabel } from '@/lib/access/admin-only'
import type { ActionDeps, PreviewResult } from './types'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import {
  AGENT_TOOL_CALL, executeToolCall, previewToolCall, toolCallGate,
} from '@/lib/agent/tool-call-action'
import { AGENT_RUN, executeRun, previewRun, runAdminOnlyLabel, runGates } from '@/lib/agent/run-action'

export interface StagedGate {
  domain: Domain
  accessFeature?: FeatureKey
  /** The level DECIDING needs; seeing the row needs read. Default write. */
  level?: 'read' | 'write'
}

export interface StagedAction {
  domain: Domain
  accessFeature?: FeatureKey
  /** As WriteAction.entity: whether a row with no vehicle is about everyone's data. */
  entity: 'required' | 'optional' | 'none'
  /** Set when only an admin may approve it (lib/access/admin-only.ts): what it does, for the refusal. */
  adminOnly?: string
  /**
   * Set when the action spans several domains (a run): every gate must hold, and `domain` is only
   * the first of them. Read through `stagedGates`, never `domain` alone.
   */
  gates?: StagedGate[]
  /** Approved only where a person confirms it, by a door that supplies the executor (WriteAction.personConfirms). */
  personConfirms?: true
  preview: (deps: ActionDeps, input: any) => Promise<PreviewResult>
  execute: (deps: ActionDeps, input: any) => Promise<Record<string, unknown>>
}

/** The action a row holds, gated for ITS args; undefined when nothing says who may see it. */
export function stagedAction(actionType: string, args: unknown): StagedAction | undefined {
  if (actionType === AGENT_RUN) {
    const gates = runGates(args)
    if (!gates) return undefined
    return {
      domain: gates[0].domain, accessFeature: gates[0].accessFeature, gates,
      entity: 'optional', preview: previewRun, execute: executeRun, adminOnly: runAdminOnlyLabel(args),
    }
  }
  if (actionType === AGENT_TOOL_CALL) {
    const gate = toolCallGate(args)
    if (!gate) return undefined
    const a = args as { tool?: string; input?: unknown }
    return {
      ...gate, entity: 'optional', preview: previewToolCall, execute: executeToolCall,
      adminOnly: adminOnlyToolLabel(String(a.tool), a.input),
    }
  }
  const action = getWriteAction(actionType)
  return action && { ...action, adminOnly: ADMIN_ONLY_ACTIONS[actionType] }
}

/** Every gate an action answers to: its own domain, or each of a run's. */
export function stagedGates(action: StagedAction): StagedGate[] {
  return action.gates ?? [{ domain: action.domain, accessFeature: action.accessFeature }]
}

/** May this access see (`read`) or decide (`write`) the action? Every gate must hold. */
export function mayActOn(access: AccessContext, action: StagedAction, need: 'read' | 'write'): boolean {
  return stagedGates(action).every(g => hasAccess(access, g.domain, need === 'read' ? 'read' : (g.level ?? 'write'), g.accessFeature))
}
