// A connected assistant's RUN: an ordered list of write-tool calls, staged as ONE pending action
// and applied, in order, by one approval.
//
// One staged call per tool call (lib/agent/tool-call-action.ts) made a real correction cost dozens
// of approvals — a holdings fix was 44, and post_drafts staged one per page of 100 — so threads fell
// back to SQL scripts that nobody approved at all. A run puts the whole fix in front of the person
// once: a title, why, every step with its own preview, and what should be true of the books after
// (lib/agent/run-checks.ts).
//
// Each step is the same `agent_tool_call` a single staged call would have been: staged with the
// stager's access (its entity pinned the same way), and applied through executeToolCall, re-
// authorized against the APPROVER's live access. Approval runs the steps in order and stops at the
// first failure, recording where; then it evaluates the expected checks. Steps are not one database
// transaction — each tool commits as it goes — so what a run created can be undone where that is
// safe (lib/agent/run-undo.ts), and the result says which steps cannot be.

import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { getTool } from '@/lib/accounting/agent-tools'
import type { ActionDeps, PreviewResult } from '@/lib/pending-actions/types'
import { executeToolCall, previewToolCall, stageToolCall, toolCallArgs, toolCallGate } from './tool-call-action'
import { describeCheck, evaluateChecks, parseChecks, resolveCheckVehicle, type CheckOutcome, type RunCheck } from './run-checks'
import { notUndoableReason, undoTargetsFor, type UndoOutcome, type UndoTarget } from './run-undo'

export const AGENT_RUN = 'agent_run'
export const MAX_RUN_STEPS = 100
/** A post_drafts step follows its own cursor; this bounds how many pages one step may post. */
const MAX_DRAFT_PAGES = 50

/** Never a step: the approval tools and runs themselves. */
const NOT_A_STEP = new Set(['stage_run', 'approve_action', 'reject_action', 'list_pending_actions'])

export interface RunStep { tool: string; input: Record<string, unknown> }

/** What a staged run stores in pending_actions.args. */
export interface RunArgs {
  title: string
  rationale: string
  steps: RunStep[]
  expected: RunCheck[]
}

export interface StepOutcome {
  step: number
  tool: string
  status: 'applied' | 'failed' | 'skipped'
  summary?: string
  /** The tool's result, whole when small, otherwise its ids and counts. */
  result?: unknown
  error?: string
  /** What undo would take back for this step. */
  undo?: UndoTarget[]
  /** Set when this step cannot be undone from the app. */
  notUndoable?: string
}

/** What applied_result holds for a run, before and after an undo. */
export interface RunResult {
  run: {
    steps: StepOutcome[]
    checks: CheckOutcome[]
    /** Null when every check passed or there were none; else how many failed. */
    checksFailed: number | null
    /** The step the run stopped at (1-based), when one failed. */
    stoppedAt: number | null
    undoable: boolean
  }
  undo?: {
    status: 'running' | 'done' | 'partial'
    by: string
    at: string
    outcomes?: UndoOutcome[]
  }
}

/** The run a row's args hold, or null when they are not one. Shape only; staging validates. */
export function runArgs(raw: unknown): RunArgs | null {
  const a = raw as Partial<RunArgs> | null
  if (!a || typeof a.title !== 'string' || !Array.isArray(a.steps)) return null
  const steps = a.steps.map(s => toolCallArgs(s)).filter((s): s is RunStep => !!s)
  if (steps.length !== a.steps.length) return null
  return { title: a.title, rationale: typeof a.rationale === 'string' ? a.rationale : '', steps, expected: parseChecks(a.expected).checks }
}

function requireRun(raw: unknown): RunArgs {
  const args = runArgs(raw)
  if (!args) throw new Error('This staged run is malformed.')
  return args
}

/**
 * Who may see and decide a run: every step's gate (its tool's domain for that input, and its
 * feature switch), and read on the books when it carries checks. Undefined when any step's tool
 * is no longer a write tool, which hides the row rather than guessing.
 */
export function runGates(raw: unknown): { domain: Domain; accessFeature?: FeatureKey; level: 'read' | 'write' }[] | undefined {
  const args = runArgs(raw)
  if (!args || args.steps.length === 0) return undefined
  const gates: { domain: Domain; accessFeature?: FeatureKey; level: 'read' | 'write' }[] = []
  for (const step of args.steps) {
    const gate = toolCallGate(step)
    if (!gate) return undefined
    if (!gates.some(g => g.domain === gate.domain && g.accessFeature === gate.accessFeature && g.level === 'write')) {
      gates.push({ ...gate, level: 'write' })
    }
  }
  if (args.expected.length > 0 && !gates.some(g => g.domain === 'accounting')) gates.push({ domain: 'accounting', level: 'read' })
  return gates
}

/** The admin-only operations a run contains, in words; undefined when there are none. */
export function runAdminOnlyLabel(raw: unknown): string | undefined {
  const args = runArgs(raw)
  if (!args) return undefined
  const labels = [...new Set(args.steps.map(s => adminOnlyToolLabel(s.tool, s.input)).filter((l): l is string => !!l))]
  return labels.length ? labels.join(', ') : undefined
}

// ── Staging ─────────────────────────────────────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validators = new Map<string, ValidateFunction>()

/** A tool's input checked against its declared schema; the problems, worded for the assistant. */
export function schemaProblems(toolName: string, schema: Record<string, unknown>, input: unknown): string[] {
  let validate = validators.get(toolName)
  if (!validate) {
    validate = ajv.compile(schema)
    validators.set(toolName, validate)
  }
  if (validate(input)) return []
  return (validate.errors ?? []).slice(0, 5).map(e => `${e.instancePath || 'input'} ${e.message ?? 'is invalid'}`.trim())
}

export class RunValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`The run was not staged:\n- ${problems.join('\n- ')}`)
  }
}

/**
 * Check a proposed run without writing anything: its shape, every step's tool and input, the
 * caller's right to each step (`authorizeStep`, the same refusal a direct call would get), and
 * each step's entity and preview with the stager's access. Throws RunValidationError listing every
 * problem found, so the assistant can fix them all in one go.
 */
export async function stageRun(
  deps: ActionDeps,
  raw: unknown,
  authorizeStep: (toolName: string, input: Record<string, unknown>) => string | null,
): Promise<{ args: RunArgs; vehicleId: string | null; preview: PreviewResult }> {
  const r = (raw ?? {}) as Record<string, any>
  const problems: string[] = []
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 200) : ''
  const rationale = typeof r.rationale === 'string' ? r.rationale.trim().slice(0, 2000) : ''
  if (!title) problems.push('title is required: a few words naming the change.')
  if (!rationale) problems.push('rationale is required: why this change, in a sentence or two.')
  if (!Array.isArray(r.steps) || r.steps.length === 0) problems.push('steps must list at least one { tool, input }.')
  else if (r.steps.length > MAX_RUN_STEPS) problems.push(`A run holds at most ${MAX_RUN_STEPS} steps; split it into several runs.`)
  const { checks, problems: checkProblems } = parseChecks(r.expected)
  problems.push(...checkProblems)
  if (problems.length) throw new RunValidationError(problems)

  const steps: RunStep[] = []
  const previews: { tool: string; vehicle: string | null; summary: string }[] = []
  const vehicleIds = new Set<string | null>()
  for (const [i, s] of (r.steps as any[]).entries()) {
    const at = `steps[${i}]`
    const name = typeof s?.tool === 'string' ? s.tool : ''
    const input = s?.input && typeof s.input === 'object' && !Array.isArray(s.input) ? s.input as Record<string, unknown> : {}
    if (NOT_A_STEP.has(name)) { problems.push(`${at}: ${name} cannot be a step of a run.`); continue }
    const tool = getTool(name)
    if (!tool) { problems.push(`${at}: unknown tool "${name}".`); continue }
    if (tool.scope !== 'write') { problems.push(`${at}: ${name} only reads; call it directly instead of putting it in a run.`); continue }
    // Its own approval, with its own confirmation in the app: never one step among many.
    if (tool.stagesAs) { problems.push(`${at}: ${name} is approved on its own in the app; call it directly, not in a run.`); continue }
    // An upload URL or a preview is for the chat, now; inside a run it would reach only the approver.
    if (tool.runsDirectly) { problems.push(`${at}: ${name} changes nothing; call it directly, not in a run.`); continue }
    const invalid = schemaProblems(tool.name, tool.inputSchema as Record<string, unknown>, input)
    if (invalid.length) { problems.push(...invalid.map(p => `${at} (${name}): ${p}`)); continue }
    const denied = authorizeStep(name, input)
    if (denied) { problems.push(`${at} (${name}): ${denied}`); continue }
    try {
      const staged = await stageToolCall(deps, name, input)
      steps.push(staged.args)
      vehicleIds.add(staged.vehicleId)
      previews.push({ tool: name, vehicle: (staged.preview.details as any)?.vehicle ?? null, summary: staged.preview.summary })
    } catch (e) {
      problems.push(`${at} (${name}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const [i, check] of checks.entries()) {
    try { await resolveCheckVehicle(deps, check) } catch (e) { problems.push(`expected[${i}]: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (problems.length) throw new RunValidationError(problems)

  const args: RunArgs = { title, rationale, steps, expected: checks }
  // One entity for the whole run when every step is on the same one; otherwise none, and each
  // step's own entity decides who may see it (lib/pending-actions/service.ts re-runs the preview).
  const vehicleId = vehicleIds.size === 1 ? [...vehicleIds][0] : null
  return { args, vehicleId, preview: describeRun(args, previews) }
}

function describeRun(args: RunArgs, steps: { tool: string; vehicle: string | null; summary: string }[]): PreviewResult {
  const n = args.steps.length
  return {
    summary: `${args.title}: ${n} step${n === 1 ? '' : 's'}${args.expected.length ? `, ${args.expected.length} expected check${args.expected.length === 1 ? '' : 's'}` : ''}`,
    details: {
      run: true,
      title: args.title,
      rationale: args.rationale,
      steps: steps.map((s, i) => ({ step: i + 1, ...s })),
      expected: args.expected.map(describeCheck),
    },
  }
}

/** The run, previewed with the given access. Throws when any step is outside it. */
export async function previewRun(deps: ActionDeps, raw: unknown): Promise<PreviewResult> {
  const args = requireRun(raw)
  const steps: { tool: string; vehicle: string | null; summary: string }[] = []
  for (const step of args.steps) {
    const p = await previewToolCall(deps, step)
    steps.push({ tool: step.tool, vehicle: (p.details as any)?.vehicle ?? null, summary: p.summary })
  }
  return describeRun(args, steps)
}

// ── Applying ────────────────────────────────────────────────────────────────────────────────

/** Thrown when a step fails; carries what the run did up to there, so the row keeps it. */
export class RunStepError extends Error {
  constructor(message: string, readonly appliedResult: RunResult) {
    super(message)
  }
}

/**
 * A result that is not an exception but did not apply: a review hold (post_ledger_text,
 * import_bank_transactions, import_journal), or a text ledger that reported errors. In a run that
 * is a failure: the steps after it assumed it had applied.
 */
function softFailure(result: unknown): string | null {
  const r = result as Record<string, any> | null
  if (!r || typeof r !== 'object') return null
  if (r.reviewRequired === true) return String(r.error ?? 'The step was held for review and applied nothing.')
  if (Array.isArray(r.errors) && r.errors.length > 0) return `The step reported errors: ${r.errors.slice(0, 3).map(String).join('; ')}`
  if (Array.isArray(r.unknownAccounts) && r.unknownAccounts.length > 0) return `Unknown accounts: ${r.unknownAccounts.join(', ')}`
  return null
}

const RESULT_LIMIT = 2000

function compactResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null)
  if (json.length <= RESULT_LIMIT) return result ?? null
  if (!result || typeof result !== 'object') return { truncated: true, bytes: json.length }
  const refs: Record<string, unknown> = { truncated: true }
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) refs[k] = v
    else if (v && typeof v === 'object' && typeof (v as any).id === 'string') refs[k] = { id: (v as any).id }
  }
  return refs
}

function resultSummary(tool: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, any>
  if (typeof r.posted === 'number') return `Posted ${r.posted}${Array.isArray(r.skipped) && r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`
  if (typeof r.entryId === 'string') return `Entry ${r.entryId}.`
  if (typeof r.transaction?.id === 'string') return `Transaction ${r.transaction.id}.`
  if (typeof r.created === 'number') return `Created ${r.created}.`
  return `${tool} applied.`
}

/**
 * One step. A post_drafts step that names no ids follows its cursor to the end, so "post every
 * draft" is one step however many pages it takes, instead of one approval per page.
 */
async function runStep(deps: ActionDeps, step: RunStep): Promise<unknown> {
  if (step.tool !== 'post_drafts' || Array.isArray(step.input.ids)) {
    return ((await executeToolCall(deps, step)) as { result: unknown }).result
  }
  let input = step.input
  const total = { posted: 0, skipped: [] as unknown[], warnings: [] as unknown[], pages: 0, hasMore: false }
  for (let page = 0; page < MAX_DRAFT_PAGES; page++) {
    const r = ((await executeToolCall(deps, { tool: step.tool, input })) as { result: any }).result ?? {}
    total.pages++
    total.posted += Number(r.posted ?? 0)
    if (Array.isArray(r.skipped)) total.skipped.push(...r.skipped)
    if (Array.isArray(r.warnings)) total.warnings.push(...r.warnings)
    total.hasMore = !!r.hasMore
    if (!r.hasMore || !r.cursor) break
    input = { ...step.input, afterId: r.cursor }
  }
  return total
}

/**
 * Apply a run as the approver: each step in order through its tool's own handler, then the checks.
 * Throws RunStepError at the first failed step, carrying the steps applied before it.
 */
export async function executeRun(deps: ActionDeps, raw: unknown): Promise<Record<string, unknown>> {
  const args = requireRun(raw)
  const steps: StepOutcome[] = []
  for (const [i, step] of args.steps.entries()) {
    try {
      const result = await runStep(deps, step)
      const soft = softFailure(result)
      if (soft) throw new Error(soft)
      const undo = undoTargetsFor(step.tool, step.input, result)
      const notUndoable = notUndoableReason(step.tool, undo)
      steps.push({
        step: i + 1, tool: step.tool, status: 'applied', summary: resultSummary(step.tool, result), result: compactResult(result),
        undo, ...(notUndoable ? { notUndoable } : {}),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      steps.push({ step: i + 1, tool: step.tool, status: 'failed', error: message })
      for (let j = i + 1; j < args.steps.length; j++) steps.push({ step: j + 1, tool: args.steps[j].tool, status: 'skipped' })
      const applied = steps.filter(s => s.status === 'applied').length
      const result: RunResult = {
        run: { steps, checks: [], checksFailed: null, stoppedAt: i + 1, undoable: steps.some(s => (s.undo?.length ?? 0) > 0) },
      }
      throw new RunStepError(
        `Step ${i + 1} of ${args.steps.length} (${step.tool}) failed: ${message} ` +
        (applied
          ? `The ${applied} step${applied === 1 ? '' : 's'} before it stay applied; nothing after it ran. Undo what can be undone from the app's Approvals page.`
          : 'Nothing was applied.'),
        result,
      )
    }
  }
  const checks = await evaluateChecks(deps, args.expected)
  const failed = checks.filter(c => !c.passed).length
  const result: RunResult = {
    run: { steps, checks, checksFailed: failed || null, stoppedAt: null, undoable: steps.some(s => (s.undo?.length ?? 0) > 0) },
  }
  return result as unknown as Record<string, unknown>
}
