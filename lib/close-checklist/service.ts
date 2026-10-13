// Close checklist service — the one implementation behind the web routes, the API and the MCP tools
// (close_checklist_*), so a checklist built in chat is the checklist on the page.
//
// Every entry point checks `accounting` at the level the operation needs and, for a checklist that
// belongs to one entity, that the caller can see that entity. A fund-wide checklist (no entity) is
// visible to callers who see every entity — the same rule `canSeeVehicle` applies to anything
// without a vehicle. Transports only authenticate and translate `CloseChecklistError`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { resolveVehicleWithAccess, VehicleAccessError } from '@/lib/accounting/http-vehicle'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { recordAudit } from '@/lib/audit/events'
import {
  OWNER_GROUPS, OWNER_LABELS, STATUS_LABELS, TASK_STATUSES, TIE_OUT_LABELS, TIE_OUT_STATUSES,
  blockedBy, buildChecklist, criticalTask, decideTaskChange, dueDateFor, findCycle, isIsoDate, paramProblem,
  quarterEndBefore, type ChecklistParams, type FundKind, type OwnerGroup, type TaskStatus, type TieOutStatus,
} from './template'

export interface CloseChecklistContext {
  admin: SupabaseClient
  fundId: string
  userId: string | null
  access: AccessContext
}

export class CloseChecklistError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message)
  }
}

const T_LISTS = 'close_checklists'
const T_TASKS = 'close_checklist_tasks'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 2000
const MAX_UPDATES = 100

interface ChecklistRow {
  id: string
  fund_id: string
  vehicle_id: string | null
  title: string
  period_end: string
  lp_delivery_date: string
  fund_kind: FundKind
  portfolio_company_count: number | null
  administrator: string | null
  status: 'open' | 'delivered' | 'archived'
  created_by: string | null
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  checklist_id: string
  key: string
  title: string
  description: string | null
  owner_group: OwnerGroup
  assignee: string | null
  days_before_delivery: number
  due_date: string
  due_date_overridden: boolean
  depends_on: string[]
  sort_order: number
  status: TaskStatus
  completed_by: string | null
  completed_at: string | null
  tie_out_status: TieOutStatus
  tied_out_by: string | null
  tied_out_at: string | null
  tie_out_note: string | null
  notes: string | null
}

function authorize(ctx: CloseChecklistContext, need: 'read' | 'write') {
  if (!hasAccess(ctx.access, 'accounting', need)) {
    throw new CloseChecklistError(
      need === 'write' ? 'Changing a close checklist needs write access to Fund accounting.' : 'Close checklists need access to Fund accounting.',
      403,
    )
  }
}

const text = (v: unknown, max = MAX_TEXT): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

/** The entity a request names, among the caller's own — or null for the whole fund. */
async function resolveEntity(ctx: CloseChecklistContext, requested: unknown, need: 'read' | 'write'): Promise<{ id: string | null; name: string | null }> {
  const name = text(requested, 200)
  if (!name) {
    if (!ctx.access.vehicles.all) {
      throw new CloseChecklistError('Name the entity (fund or SPV): you can see only some of this fund\'s entities, so a fund-wide checklist is not yours to open.', 403)
    }
    return { id: null, name: null }
  }
  try {
    const resolved = await resolveVehicleWithAccess(ctx.admin, ctx.access, name, need)
    const id = await vehicleIdByName(ctx.admin, ctx.fundId, resolved.name)
    if (!id) throw new CloseChecklistError(`Unknown entity "${name}"`, 404)
    return { id, name: resolved.name }
  } catch (e) {
    if (e instanceof VehicleAccessError) throw new CloseChecklistError(e.message, 403)
    if (e instanceof VehicleResolutionError) throw new CloseChecklistError(e.message, 400)
    throw e
  }
}

async function loadChecklistRow(ctx: CloseChecklistContext, ref: unknown): Promise<ChecklistRow> {
  const r = text(ref, 200)
  let q = (ctx.admin as any).from(T_LISTS).select('*').eq('fund_id', ctx.fundId)
  if (!r || r === 'latest') {
    q = q.neq('status', 'archived').order('period_end', { ascending: false }).order('created_at', { ascending: false })
  } else if (UUID.test(r)) {
    q = q.eq('id', r)
  } else if (isIsoDate(r)) {
    q = q.eq('period_end', r)
  } else {
    throw new CloseChecklistError('checklist must be a checklist id, a quarter-end date (YYYY-MM-DD) or "latest"')
  }
  const { data, error } = await q.limit(20)
  if (error) throw new Error(`Close checklists could not be read: ${error.message}`)
  const visible = ((data ?? []) as ChecklistRow[]).filter(c => canSeeVehicle(ctx.access, c.vehicle_id))
  if (visible.length === 0) throw new CloseChecklistError(r && r !== 'latest' ? `No close checklist "${r}"` : 'There is no close checklist yet. Create one first.', 404)
  return visible[0]
}

async function loadTasks(ctx: CloseChecklistContext, checklistId: string): Promise<TaskRow[]> {
  const { data, error } = await (ctx.admin as any).from(T_TASKS).select('*')
    .eq('fund_id', ctx.fundId).eq('checklist_id', checklistId).order('sort_order').order('created_at')
  if (error) throw new Error(`Close checklist tasks could not be read: ${error.message}`)
  return (data ?? []) as TaskRow[]
}

async function memberNames(ctx: CloseChecklistContext, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)))
  if (unique.length === 0) return new Map()
  const { data } = await (ctx.admin as any).from('fund_members').select('user_id, display_name')
    .eq('fund_id', ctx.fundId).in('user_id', unique)
  return new Map(((data ?? []) as { user_id: string; display_name: string | null }[]).map(m => [m.user_id, m.display_name ?? 'A team member']))
}

// ---------------------------------------------------------------------------------------------
// The view: what chat, the API and the page all render
// ---------------------------------------------------------------------------------------------

export interface ChecklistTaskView {
  id: string
  key: string
  title: string
  description: string | null
  owner: OwnerGroup
  assignee: string | null
  dueDate: string
  daysBeforeDelivery: number
  dueDateOverridden: boolean
  status: TaskStatus
  statusLabel: string
  completedBy: string | null
  completedAt: string | null
  /** The "Tied out" column. */
  tieOut: TieOutStatus
  tieOutLabel: string
  tiedOutBy: string | null
  tiedOutAt: string | null
  tieOutNote: string | null
  notes: string | null
  dependsOn: string[]
  blockedBy: string[]
  overdue: boolean
  isCritical: boolean
}

export interface ChecklistView {
  checklist: {
    id: string
    title: string
    entity: string | null
    periodEnd: string
    lpDeliveryDate: string
    fundKind: FundKind
    portfolioCompanies: number | null
    administrator: string | null
    status: ChecklistRow['status']
  }
  /** The task blocking the most downstream work in the plan as built. */
  criticalTask: { id: string; key: string; title: string; owner: OwnerGroup; dueDate: string; downstream: number } | null
  /** The open task now holding up the most of what is left; null once nothing open blocks anything. */
  currentBlocker: { id: string; key: string; title: string; owner: OwnerGroup; dueDate: string; downstream: number } | null
  summary: {
    tasks: number
    done: number
    open: number
    overdue: number
    needTieOut: number
    tiedOut: number
    exceptions: number
    /** Done but not yet tied out: finished work whose numbers nobody has checked. */
    doneNotTiedOut: number
  }
  groups: { owner: OwnerGroup; label: string; tasks: ChecklistTaskView[] }[]
  columns: string
  warnings?: string[]
}

const COLUMNS_NOTE =
  'Status says the work is finished. "Tied out" is separate: a second person has agreed the task\'s numbers to source. ' +
  'A done task is not a verified number; "Not yet" means done or not, nobody has checked it.'

export async function checklistView(ctx: CloseChecklistContext, row: ChecklistRow, today = new Date().toISOString().slice(0, 10)): Promise<ChecklistView> {
  const tasks = await loadTasks(ctx, row.id)
  const [names, entity] = await Promise.all([
    memberNames(ctx, tasks.flatMap(t => [t.completed_by, t.tied_out_by])),
    row.vehicle_id ? vehicleNameById(ctx.admin, ctx.fundId, row.vehicle_id).catch(() => null) : Promise.resolve(null),
  ])
  const graph = tasks.map(t => ({ key: t.key, dependsOn: t.depends_on ?? [], status: t.status, dueDate: t.due_date, sortOrder: t.sort_order, id: t.id, title: t.title, owner: t.owner_group }))
  const plan = criticalTask(graph)
  const now = criticalTask(graph, { openOnly: true })
  const pick = (c: typeof plan) => c ? { id: c.task.id, key: c.task.key, title: c.task.title, owner: c.task.owner, dueDate: c.task.dueDate!, downstream: c.downstream } : null
  const titleOf = new Map(tasks.map(t => [t.key, t.title]))

  const views: ChecklistTaskView[] = tasks.map(t => {
    const open = t.status !== 'done' && t.status !== 'not_applicable'
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      description: t.description,
      owner: t.owner_group,
      assignee: t.assignee,
      dueDate: t.due_date,
      daysBeforeDelivery: t.days_before_delivery,
      dueDateOverridden: t.due_date_overridden,
      status: t.status,
      statusLabel: STATUS_LABELS[t.status],
      completedBy: t.completed_by ? names.get(t.completed_by) ?? 'A team member' : null,
      completedAt: t.completed_at,
      tieOut: t.tie_out_status,
      tieOutLabel: TIE_OUT_LABELS[t.tie_out_status],
      tiedOutBy: t.tied_out_by ? names.get(t.tied_out_by) ?? 'A team member' : null,
      tiedOutAt: t.tied_out_at,
      tieOutNote: t.tie_out_note,
      notes: t.notes,
      dependsOn: (t.depends_on ?? []).map(k => titleOf.get(k) ?? k),
      blockedBy: blockedBy({ key: t.key, dependsOn: t.depends_on ?? [], status: t.status }, graph).map(k => titleOf.get(k) ?? k),
      overdue: open && t.due_date < today,
      isCritical: plan?.task.key === t.key,
    }
  })

  const needTieOut = views.filter(v => v.tieOut !== 'not_required')
  return {
    checklist: {
      id: row.id,
      title: row.title,
      entity,
      periodEnd: row.period_end,
      lpDeliveryDate: row.lp_delivery_date,
      fundKind: row.fund_kind,
      portfolioCompanies: row.portfolio_company_count,
      administrator: row.administrator,
      status: row.status,
    },
    criticalTask: pick(plan),
    currentBlocker: pick(now),
    summary: {
      tasks: views.length,
      done: views.filter(v => v.status === 'done' || v.status === 'not_applicable').length,
      open: views.filter(v => v.status !== 'done' && v.status !== 'not_applicable').length,
      overdue: views.filter(v => v.overdue).length,
      needTieOut: needTieOut.length,
      tiedOut: needTieOut.filter(v => v.tieOut === 'tied_out').length,
      exceptions: needTieOut.filter(v => v.tieOut === 'exception').length,
      doneNotTiedOut: needTieOut.filter(v => v.status === 'done' && v.tieOut === 'pending').length,
    },
    groups: OWNER_GROUPS
      .map(owner => ({ owner, label: OWNER_LABELS[owner], tasks: views.filter(v => v.owner === owner) }))
      .filter(g => g.tasks.length > 0),
    columns: COLUMNS_NOTE,
  }
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export interface CreateChecklistInput {
  fundKind?: unknown
  portfolioCompanies?: unknown
  administrator?: unknown
  lpDeliveryDate?: unknown
  periodEnd?: unknown
  entity?: unknown
  title?: unknown
}

function parseParams(input: CreateChecklistInput): ChecklistParams {
  const lpDeliveryDate = text(input.lpDeliveryDate, 10)
  if (!lpDeliveryDate || !isIsoDate(lpDeliveryDate)) throw new CloseChecklistError('lp_delivery_date is required (YYYY-MM-DD)')
  const periodEnd = text(input.periodEnd, 10) ?? quarterEndBefore(lpDeliveryDate)
  const kindRaw = (text(input.fundKind, 20) ?? 'venture').toLowerCase().replace(/[^a-z]/g, '')
  const fundKind: FundKind = kindRaw === 'pe' || kindRaw === 'privateequity' || kindRaw === 'buyout' ? 'pe' : kindRaw === 'venture' || kindRaw === 'vc' ? 'venture' : (null as any)
  if (!fundKind) throw new CloseChecklistError('fund_kind must be "venture" or "pe"')
  const n = input.portfolioCompanies
  const portfolioCompanies = n == null || n === '' ? null : Number(n)
  const params: ChecklistParams = { fundKind, portfolioCompanies, administrator: text(input.administrator, 120), periodEnd, lpDeliveryDate }
  const problem = paramProblem(params)
  if (problem) throw new CloseChecklistError(problem)
  return params
}

export async function createChecklist(ctx: CloseChecklistContext, input: CreateChecklistInput): Promise<ChecklistView & { created: true }> {
  authorize(ctx, 'write')
  const params = parseParams(input)
  const entity = await resolveEntity(ctx, input.entity, 'write')
  const built = buildChecklist(params)

  let existing = (ctx.admin as any).from(T_LISTS).select('id').eq('fund_id', ctx.fundId).eq('period_end', params.periodEnd)
  existing = entity.id ? existing.eq('vehicle_id', entity.id) : existing.is('vehicle_id', null)
  const { data: found } = await existing.maybeSingle()
  if (found) {
    throw new CloseChecklistError(
      `There is already a close checklist for ${params.periodEnd}${entity.name ? ` (${entity.name})` : ''} (${found.id}). Open it with close_checklist, or change its LP delivery date.`,
      409,
    )
  }

  const title = text(input.title, 200) ?? (entity.name ? `${entity.name} — ${built.title}` : built.title)
  const { data: list, error } = await (ctx.admin as any).from(T_LISTS).insert({
    fund_id: ctx.fundId,
    vehicle_id: entity.id,
    title,
    period_end: params.periodEnd,
    lp_delivery_date: params.lpDeliveryDate,
    fund_kind: params.fundKind,
    portfolio_company_count: params.portfolioCompanies,
    administrator: params.administrator,
    status: 'open',
    created_by: ctx.userId,
    created_at: new Date().toISOString(),
  }).select('*').single()
  if (error) {
    if (error.code === '23505') throw new CloseChecklistError(`There is already a close checklist for ${params.periodEnd}.`, 409)
    throw new Error(`The close checklist could not be saved: ${error.message}`)
  }

  const { error: taskError } = await (ctx.admin as any).from(T_TASKS).insert(built.tasks.map(t => ({
    checklist_id: list.id,
    fund_id: ctx.fundId,
    key: t.key,
    title: t.title,
    description: t.description,
    owner_group: t.owner,
    assignee: t.assignee,
    days_before_delivery: t.daysBeforeDelivery,
    due_date: t.dueDate,
    depends_on: t.dependsOn,
    sort_order: t.sortOrder,
    status: 'not_started',
    due_date_overridden: false,
    tie_out_status: t.tieOut,
  })))
  if (taskError) {
    await (ctx.admin as any).from(T_LISTS).delete().eq('id', list.id).eq('fund_id', ctx.fundId)
    throw new Error(`The close checklist's tasks could not be saved: ${taskError.message}`)
  }

  await recordAudit(ctx.admin, {
    fundId: ctx.fundId, vehicleId: entity.id, actorId: ctx.userId, action: 'close_checklist.create',
    subjectType: 'close_checklist', subjectId: list.id,
    details: { periodEnd: params.periodEnd, lpDeliveryDate: params.lpDeliveryDate, fundKind: params.fundKind, tasks: built.tasks.length },
  })
  const view = await checklistView(ctx, list as ChecklistRow)
  return { ...view, ...(built.warnings.length ? { warnings: built.warnings } : {}), created: true }
}

export async function getChecklist(ctx: CloseChecklistContext, ref: unknown): Promise<ChecklistView> {
  authorize(ctx, 'read')
  return checklistView(ctx, await loadChecklistRow(ctx, ref))
}

export interface ChecklistSummaryRow {
  id: string
  title: string
  entity: string | null
  periodEnd: string
  lpDeliveryDate: string
  status: ChecklistRow['status']
}

export async function listChecklists(ctx: CloseChecklistContext, opts: { includeArchived?: boolean } = {}): Promise<{ checklists: ChecklistSummaryRow[] }> {
  authorize(ctx, 'read')
  let q = (ctx.admin as any).from(T_LISTS).select('*').eq('fund_id', ctx.fundId).order('period_end', { ascending: false }).limit(100)
  if (!opts.includeArchived) q = q.neq('status', 'archived')
  const { data, error } = await q
  if (error) throw new Error(`Close checklists could not be read: ${error.message}`)
  const rows = ((data ?? []) as ChecklistRow[]).filter(c => canSeeVehicle(ctx.access, c.vehicle_id))
  const names = await Promise.all(rows.map(r => r.vehicle_id ? vehicleNameById(ctx.admin, ctx.fundId, r.vehicle_id).catch(() => null) : null))
  return {
    checklists: rows.map((r, i) => ({
      id: r.id, title: r.title, entity: names[i], periodEnd: r.period_end, lpDeliveryDate: r.lp_delivery_date, status: r.status,
    })),
  }
}

export interface UpdateChecklistInput {
  lpDeliveryDate?: unknown
  status?: unknown
  title?: unknown
}

/** Change the LP delivery date (every task without its own date moves with it), the title or the status. */
export async function updateChecklist(ctx: CloseChecklistContext, ref: unknown, input: UpdateChecklistInput): Promise<ChecklistView & { moved?: number }> {
  authorize(ctx, 'write')
  const row = await loadChecklistRow(ctx, ref)
  const patch: Record<string, unknown> = {}
  let moved = 0
  const title = text(input.title, 200)
  if (title) patch.title = title
  if (input.status != null) {
    if (!['open', 'delivered', 'archived'].includes(String(input.status))) throw new CloseChecklistError('status must be open, delivered or archived')
    patch.status = String(input.status)
  }
  if (input.lpDeliveryDate != null) {
    const d = text(input.lpDeliveryDate, 10)
    if (!d || !isIsoDate(d)) throw new CloseChecklistError('lp_delivery_date must be a date (YYYY-MM-DD)')
    if (d <= row.period_end) throw new CloseChecklistError(`The LP delivery date must be after the quarter-end (${row.period_end})`)
    patch.lp_delivery_date = d
    const tasks = await loadTasks(ctx, row.id)
    for (const t of tasks.filter(t => !t.due_date_overridden)) {
      const due = dueDateFor(d, row.period_end, t.days_before_delivery)
      if (due === t.due_date) continue
      const { error } = await (ctx.admin as any).from(T_TASKS).update({ due_date: due }).eq('id', t.id).eq('fund_id', ctx.fundId)
      if (error) throw new Error(`A task's due date could not be moved: ${error.message}`)
      moved++
    }
  }
  if (Object.keys(patch).length === 0) throw new CloseChecklistError('Nothing to change: pass lp_delivery_date, status or title.')
  const { data, error } = await (ctx.admin as any).from(T_LISTS).update(patch).eq('id', row.id).eq('fund_id', ctx.fundId).select('*').single()
  if (error) throw new Error(`The close checklist could not be updated: ${error.message}`)
  await recordAudit(ctx.admin, {
    fundId: ctx.fundId, vehicleId: row.vehicle_id, actorId: ctx.userId, action: 'close_checklist.update',
    subjectType: 'close_checklist', subjectId: row.id, details: { ...patch, tasksMoved: moved },
  })
  return { ...(await checklistView(ctx, data as ChecklistRow)), ...(patch.lp_delivery_date ? { moved } : {}) }
}

export interface TaskUpdateInput {
  task?: unknown
  status?: unknown
  tie_out?: unknown
  note?: unknown
  assignee?: unknown
  due_date?: unknown
  notes?: unknown
  title?: unknown
}

function findTask(tasks: TaskRow[], ref: unknown): TaskRow {
  const r = text(ref, 300)
  if (!r) throw new CloseChecklistError('Each update names its task: the task id, its key, or its exact title.')
  const lower = r.toLowerCase()
  const hit = tasks.find(t => t.id === r) ?? tasks.find(t => t.key === r) ?? tasks.find(t => t.title.toLowerCase() === lower)
  if (hit) return hit
  const partial = tasks.filter(t => t.title.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  throw new CloseChecklistError(partial.length > 1
    ? `"${r}" matches ${partial.length} tasks: ${partial.map(t => t.key).join(', ')}. Use the key.`
    : `No task "${r}" on this checklist.`, 404)
}

/**
 * Update tasks: status, the tie-out, assignee, due date, notes. All are validated before any is
 * written, so a bad line refuses the batch rather than leaving half of it applied.
 */
export async function updateTasks(ctx: CloseChecklistContext, ref: unknown, updates: unknown): Promise<ChecklistView & { updated: string[] }> {
  authorize(ctx, 'write')
  if (!Array.isArray(updates) || updates.length === 0) throw new CloseChecklistError('updates must be a non-empty list')
  if (updates.length > MAX_UPDATES) throw new CloseChecklistError(`At most ${MAX_UPDATES} updates at a time`)
  const row = await loadChecklistRow(ctx, ref)
  if (row.status === 'archived') throw new CloseChecklistError('This checklist is archived. Reopen it (status "open") to change it.', 409)
  const tasks = await loadTasks(ctx, row.id)
  const actor = { userId: ctx.userId, isAdmin: ctx.access.role === 'admin' }
  const now = new Date().toISOString()

  const planned: { task: TaskRow; patch: Record<string, unknown>; audit: Record<string, unknown>; tieOutChanged: boolean }[] = []
  const touched = new Set<string>()
  for (const raw of updates as TaskUpdateInput[]) {
    if (!raw || typeof raw !== 'object') throw new CloseChecklistError('Each update is an object naming its task')
    const task = findTask(tasks, raw.task)
    if (touched.has(task.id)) throw new CloseChecklistError(`"${task.title}" is updated twice in one call; combine the changes.`)
    touched.add(task.id)
    const patch: Record<string, unknown> = {}
    const audit: Record<string, unknown> = { task: task.key }

    if (raw.status != null && !TASK_STATUSES.includes(raw.status as TaskStatus)) {
      throw new CloseChecklistError(`status must be one of ${TASK_STATUSES.join(', ')}`)
    }
    if (raw.tie_out != null && !TIE_OUT_STATUSES.includes(raw.tie_out as TieOutStatus)) {
      throw new CloseChecklistError(`tie_out must be one of ${TIE_OUT_STATUSES.join(', ')}`)
    }
    const note = text(raw.note)
    const decision = decideTaskChange(
      { status: task.status, tieOut: task.tie_out_status, completedBy: task.completed_by },
      { status: raw.status as TaskStatus | undefined, tieOut: raw.tie_out as TieOutStatus | undefined, note },
      actor,
    )
    if (!decision.ok) throw new CloseChecklistError(`${task.title}: ${decision.error}`, 409)
    const { next } = decision
    if (next.status !== task.status) {
      patch.status = next.status
      audit.status = { from: task.status, to: next.status }
      if (next.status === 'done') { patch.completed_by = ctx.userId; patch.completed_at = now }
      else if (task.status === 'done') { patch.completed_by = null; patch.completed_at = null }
    }
    const tieOutChanged = next.tieOut !== task.tie_out_status
    if (tieOutChanged) {
      patch.tie_out_status = next.tieOut
      audit.tieOut = { from: task.tie_out_status, to: next.tieOut }
      if (next.tieOut === 'tied_out' || next.tieOut === 'exception') {
        patch.tied_out_by = ctx.userId; patch.tied_out_at = now; patch.tie_out_note = note
      } else {
        patch.tied_out_by = null; patch.tied_out_at = null; patch.tie_out_note = null
      }
      if (decision.resetTieOut) audit.tieOutReset = 'The task was reopened, so its numbers are no longer the ones that were tied out.'
      if (decision.selfTieOut) audit.selfTieOut = true
      if (note) audit.note = note
    }
    if (raw.assignee !== undefined) { patch.assignee = text(raw.assignee, 200); audit.assignee = patch.assignee }
    if (raw.notes !== undefined) { patch.notes = text(raw.notes); audit.notes = true }
    if (raw.title !== undefined) {
      const t = text(raw.title, 300)
      if (!t) throw new CloseChecklistError('A task title cannot be empty')
      patch.title = t; audit.title = t
    }
    if (raw.due_date !== undefined) {
      if (raw.due_date === null || raw.due_date === '') {
        patch.due_date = dueDateFor(row.lp_delivery_date, row.period_end, task.days_before_delivery)
        patch.due_date_overridden = false
      } else {
        const d = text(raw.due_date, 10)
        if (!d || !isIsoDate(d)) throw new CloseChecklistError('due_date must be a date (YYYY-MM-DD), or null to count it back from the delivery date again')
        patch.due_date = d
        patch.due_date_overridden = true
      }
      audit.dueDate = patch.due_date
    }
    if (Object.keys(patch).length === 0) throw new CloseChecklistError(`Nothing to change on "${task.title}"`)
    planned.push({ task, patch, audit, tieOutChanged })
  }

  for (const p of planned) {
    const { error } = await (ctx.admin as any).from(T_TASKS).update(p.patch).eq('id', p.task.id).eq('fund_id', ctx.fundId)
    if (error) throw new Error(`"${p.task.title}" could not be updated: ${error.message}`)
  }
  await recordAudit(ctx.admin, {
    fundId: ctx.fundId, vehicleId: row.vehicle_id, actorId: ctx.userId,
    action: planned.some(p => p.tieOutChanged) ? 'close_checklist.tie_out' : 'close_checklist.task_update',
    subjectType: 'close_checklist', subjectId: row.id, details: { changes: planned.map(p => p.audit) },
  })
  return { ...(await checklistView(ctx, row)), updated: planned.map(p => p.task.key) }
}

export interface AddTaskInput {
  title?: unknown
  owner?: unknown
  assignee?: unknown
  days_before_delivery?: unknown
  due_date?: unknown
  depends_on?: unknown
  needs_tie_out?: unknown
  description?: unknown
}

/** Add a task of the fund's own to a checklist. */
export async function addTask(ctx: CloseChecklistContext, ref: unknown, input: AddTaskInput): Promise<ChecklistView & { added: string }> {
  authorize(ctx, 'write')
  const row = await loadChecklistRow(ctx, ref)
  if (row.status === 'archived') throw new CloseChecklistError('This checklist is archived. Reopen it (status "open") to change it.', 409)
  const title = text(input.title, 300)
  if (!title) throw new CloseChecklistError('title is required')
  const owner = String(input.owner ?? 'internal') as OwnerGroup
  if (!OWNER_GROUPS.includes(owner)) throw new CloseChecklistError(`owner must be one of ${OWNER_GROUPS.join(', ')}`)
  const tasks = await loadTasks(ctx, row.id)
  const dependsOn = Array.isArray(input.depends_on) ? input.depends_on.map(d => findTask(tasks, d).key) : []

  let daysBefore: number
  let dueDate: string
  let overridden = false
  const explicitDue = text(input.due_date, 10)
  if (explicitDue) {
    if (!isIsoDate(explicitDue)) throw new CloseChecklistError('due_date must be a date (YYYY-MM-DD)')
    dueDate = explicitDue
    daysBefore = Math.max(0, Math.round((Date.parse(row.lp_delivery_date) - Date.parse(explicitDue)) / 86_400_000))
    overridden = true
  } else {
    const n = Number(input.days_before_delivery ?? 0)
    if (!Number.isInteger(n) || n < 0 || n > 365) throw new CloseChecklistError('days_before_delivery must be a whole number of days, 0 to 365')
    daysBefore = n
    dueDate = dueDateFor(row.lp_delivery_date, row.period_end, n)
  }

  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'task'
  let key = `custom_${base}`
  for (let i = 2; tasks.some(t => t.key === key); i++) key = `custom_${base}_${i}`
  const cycle = findCycle([...tasks.map(t => ({ key: t.key, dependsOn: t.depends_on ?? [] })), { key, dependsOn }])
  if (cycle) throw new CloseChecklistError(`That would make a loop: ${cycle.join(' → ')}`)

  const { error } = await (ctx.admin as any).from(T_TASKS).insert({
    checklist_id: row.id,
    fund_id: ctx.fundId,
    key,
    title,
    description: text(input.description),
    owner_group: owner,
    assignee: text(input.assignee, 200),
    days_before_delivery: daysBefore,
    due_date: dueDate,
    due_date_overridden: overridden,
    depends_on: dependsOn,
    sort_order: Math.max(0, ...tasks.map(t => t.sort_order)) + 10,
    status: 'not_started',
    tie_out_status: input.needs_tie_out === false ? 'not_required' : 'pending',
  })
  if (error) throw new Error(`The task could not be added: ${error.message}`)
  await recordAudit(ctx.admin, {
    fundId: ctx.fundId, vehicleId: row.vehicle_id, actorId: ctx.userId, action: 'close_checklist.task_update',
    subjectType: 'close_checklist', subjectId: row.id, details: { added: key, title, owner, dueDate, dependsOn },
  })
  return { ...(await checklistView(ctx, row)), added: key }
}
