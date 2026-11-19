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
//
// A run keeps its own clock (executeRun): it saves its progress around every step, starts a step
// only with time left in the request, and pauses before the function limit instead of being cut
// off. A paused run stays approved and continues from where it stopped when approved again.

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
  /** `pending`: not reached yet because the run paused for time; it runs when the run continues. */
  status: 'applied' | 'failed' | 'skipped' | 'pending'
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
    /**
     * Set while the run is not finished: the step (1-based) it continues from. A run pauses on its
     * own before the request's time limit would cut it off, and continues under the same approval.
     */
    resumeAt?: number | null
    /**
     * The step (1-based) that was executing when this progress was saved. Still set on a stored
     * result means the request died during that step, so whether it applied is unknown.
     */
    inFlight?: number | null
    /** Why the run paused, when it did. */
    paused?: { at: string; message: string } | null
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
 * How long one approval request may keep starting steps. The MCP route and the approve routes run
 * under a 300-second function limit; this leaves room for the step in flight to finish, the checks
 * to run and the result to be saved. Before, a run had no clock of its own: each close watched its
 * own 240 seconds, two of them in one run overran the limit, and the request was killed mid-step
 * with nothing saved.
 */
export const RUN_TIME_BUDGET_MS = 240_000
/** A new step is started only with at least this much of the run's budget left. */
export const STEP_RESERVE_MS = 45_000
/**
 * Steps that are safe to run again after the request died in the middle of them: a close derives
 * its start from the last closed period, so running it again picks up where it stopped.
 */
const RERUNNABLE_TOOLS = new Set(['close_period'])

/** The months a close_period result reports as still open, if it stopped for time. */
function closeRemaining(result: unknown): { from: string; months: number; message: string } | null {
  const r = (result ?? {}) as Record<string, any>
  return r.remaining && typeof r.remaining.months === 'number' && r.remaining.months > 0 ? r.remaining : null
}

/** A close step that ran in rounds: every month it closed, across rounds and requests. */
function mergeCloseResults(prior: unknown, next: unknown): unknown {
  const a = (prior ?? {}) as Record<string, any>
  const b = (next ?? {}) as Record<string, any>
  const closed = [...(Array.isArray(a.closed) ? a.closed : []), ...(Array.isArray(b.closed) ? b.closed : [])]
  const merged: Record<string, unknown> = { ...b, closed }
  if (!closeRemaining(b)) delete merged.remaining
  return merged
}

export interface ExecuteRunOptions {
  /** What an earlier request of this same approval did; the run continues from its `resumeAt`. */
  resume?: RunResult | null
  /** Called with the run's progress before and after each step, so a request that dies keeps a record. */
  onProgress?: (progress: RunResult) => Promise<void>
  now?: () => number
  budgetMs?: number
}

/**
 * Apply a run as the approver: each step in order through its tool's own handler, then the checks.
 * Throws RunStepError at the first failed step, carrying the steps applied before it.
 *
 * Returns early, with `run.resumeAt` set, when the next step would not fit in the request's time
 * budget; the approval service keeps the row approved, and approving it again continues from there.
 * A close that runs out of time partway is run again in the same request while time allows (its
 * start is derived, so it picks up where it stopped); it counts as applied only once every month
 * through its date is closed.
 */
export async function executeRun(deps: ActionDeps, raw: unknown, opts: ExecuteRunOptions = {}): Promise<Record<string, unknown>> {
  const args = requireRun(raw)
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.budgetMs ?? RUN_TIME_BUDGET_MS)
  const prior = opts.resume?.run ?? null

  // Outcomes carried over from earlier requests of this approval, by step number.
  const outcomes = new Map<number, StepOutcome>()
  for (const s of prior?.steps ?? []) if (s.status === 'applied') outcomes.set(s.step, s)
  let start = prior?.resumeAt != null ? prior.resumeAt - 1 : 0

  if (prior?.inFlight != null) {
    const step = args.steps[prior.inFlight - 1]
    if (!step || !RERUNNABLE_TOOLS.has(step.tool)) {
      throw new RunStepError(
        `Step ${prior.inFlight} of ${args.steps.length} (${step?.tool ?? 'unknown'}) was interrupted while it ran, so it is not known ` +
        'whether it applied. Check the books for it, then stage what is still needed as a new run.',
        snapshot(args, outcomes, { stoppedAt: prior.inFlight, inFlight: null }),
      )
    }
    start = prior.inFlight - 1
  }

  let ranThisRequest = false
  for (let i = start; i < args.steps.length; i++) {
    const step = args.steps[i]
    if (ranThisRequest && deadline - now() < STEP_RESERVE_MS) {
      return pause(args, outcomes, i, opts) as unknown as Record<string, unknown>
    }
    ranThisRequest = true
    // A close paused partway in an earlier request: its months closed so far carry over.
    let carried: unknown = prior?.steps.find(s => s.step === i + 1 && s.status === 'pending')?.result ?? null

    try {
      for (;;) {
        await opts.onProgress?.(snapshot(args, outcomes, { resumeAt: i + 1, inFlight: i + 1 }))
        const result = await runStep({ ...deps, deadline }, step)
        const soft = softFailure(result)
        if (soft) throw new Error(soft)
        const remaining = step.tool === 'close_period' ? closeRemaining(result) : null
        if (remaining) {
          carried = mergeCloseResults(carried, result)
          if (deadline - now() >= STEP_RESERVE_MS) continue
          outcomes.set(i + 1, {
            step: i + 1, tool: step.tool, status: 'pending', summary: remaining.message, result: compactResult(carried),
          })
          return pause(args, outcomes, i, opts) as unknown as Record<string, unknown>
        }
        const final = carried ? mergeCloseResults(carried, result) : result
        const undo = undoTargetsFor(step.tool, step.input, final)
        const notUndoable = notUndoableReason(step.tool, undo)
        outcomes.set(i + 1, {
          step: i + 1, tool: step.tool, status: 'applied', summary: resultSummary(step.tool, final), result: compactResult(final),
          undo, ...(notUndoable ? { notUndoable } : {}),
        })
        break
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      outcomes.set(i + 1, { step: i + 1, tool: step.tool, status: 'failed', error: message })
      const result = snapshot(args, outcomes, { stoppedAt: i + 1, inFlight: null })
      const applied = result.run.steps.filter(s => s.status === 'applied').length
      throw new RunStepError(
        `Step ${i + 1} of ${args.steps.length} (${step.tool}) failed: ${message} ` +
        (applied
          ? `The ${applied} step${applied === 1 ? '' : 's'} before it stay applied; nothing after it ran. Undo what can be undone from the app's Approvals page.`
          : 'Nothing was applied.'),
        result,
      )
    }
    await opts.onProgress?.(snapshot(args, outcomes, { resumeAt: i + 2 <= args.steps.length ? i + 2 : null, inFlight: null }))
  }
  const checks = await evaluateChecks(deps, args.expected)
  const failed = checks.filter(c => !c.passed).length
  const result = snapshot(args, outcomes, {})
  result.run.checks = checks
  result.run.checksFailed = failed || null
  return result as unknown as Record<string, unknown>
}

/**
 * The run as it stands: every step's outcome so far, the rest `pending` (paused or not reached) or
 * `skipped` (after a failure).
 */
function snapshot(
  args: RunArgs,
  outcomes: Map<number, StepOutcome>,
  state: { stoppedAt?: number; resumeAt?: number | null; inFlight?: number | null; paused?: RunResult['run']['paused'] },
): RunResult {
  const steps = args.steps.map((step, i) =>
    outcomes.get(i + 1) ?? { step: i + 1, tool: step.tool, status: state.stoppedAt != null ? 'skipped' as const : 'pending' as const })
  return {
    run: {
      steps,
      checks: [],
      checksFailed: null,
      stoppedAt: state.stoppedAt ?? null,
      undoable: steps.some(s => (s.undo?.length ?? 0) > 0),
      ...(state.resumeAt != null ? { resumeAt: state.resumeAt } : {}),
      ...(state.inFlight != null ? { inFlight: state.inFlight } : {}),
      ...(state.paused ? { paused: state.paused } : {}),
    },
  }
}

function pause(args: RunArgs, outcomes: Map<number, StepOutcome>, index: number, opts: ExecuteRunOptions): RunResult {
  const done = [...outcomes.values()].filter(s => s.status === 'applied').length
  return snapshot(args, outcomes, {
    resumeAt: index + 1,
    inFlight: null,
    paused: {
      at: new Date((opts.now ?? Date.now)()).toISOString(),
      message: `Paused before the request's time limit, with ${done} of ${args.steps.length} steps applied. ` +
        `Approve it again to continue from step ${index + 1}; it runs under the same approval.`,
    },
  })
}

/** Whether a stored run result is a run that has not finished and can continue. */
export function runResumeAt(result: unknown): number | null {
  const r = (result as RunResult | null)?.run
  return r && typeof r.resumeAt === 'number' && r.stoppedAt == null ? r.resumeAt : null
}
