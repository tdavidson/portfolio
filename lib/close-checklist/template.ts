// The quarter-end close checklist, as pure logic: the task library, due dates counted back from the
// LP delivery date, the task that blocks the most downstream work, and the rules for "done" versus
// "tied out". No server imports — the page, the service and the tests all use it.
//
// Two columns, deliberately. `status` says the work is finished; `tieOut` says a second person has
// agreed its numbers to source. A completed task is not a verified number, and a checklist that
// folds the two together is how a close "finishes" with a capital account nobody checked.

export type FundKind = 'venture' | 'pe'
export type OwnerGroup = 'administrator' | 'portfolio_companies' | 'internal'
export type TaskStatus = 'not_started' | 'in_progress' | 'done' | 'not_applicable'
export type TieOutStatus = 'not_required' | 'pending' | 'tied_out' | 'exception'

export const OWNER_GROUPS: OwnerGroup[] = ['administrator', 'portfolio_companies', 'internal']
export const TASK_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'done', 'not_applicable']
export const TIE_OUT_STATUSES: TieOutStatus[] = ['not_required', 'pending', 'tied_out', 'exception']

export const OWNER_LABELS: Record<OwnerGroup, string> = {
  administrator: 'Fund administrator',
  portfolio_companies: 'Portfolio companies',
  internal: 'Internal team',
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  not_applicable: 'N/A',
}

export const TIE_OUT_LABELS: Record<TieOutStatus, string> = {
  not_required: '—',
  pending: 'Not yet',
  tied_out: 'Tied out',
  exception: 'Exception',
}

export interface ChecklistParams {
  fundKind: FundKind
  /** How many portfolio companies report. Null = not given. */
  portfolioCompanies: number | null
  /** A name, "outsourced", or null / "in-house" for a team that keeps its own books. */
  administrator: string | null
  /** The quarter-end being closed, YYYY-MM-DD. */
  periodEnd: string
  /** When the LP reporting package is due, YYYY-MM-DD. */
  lpDeliveryDate: string
}

interface LibraryTask {
  key: string
  title: string | ((p: ChecklistParams) => string)
  description: string
  owner: OwnerGroup
  /** Calendar days before LP delivery, before compression and the company-count adjustment. */
  daysBefore: number
  dependsOn: string[]
  /** Does this task produce a number someone must agree to source? */
  tieOut: boolean
  /** Only for these kinds of fund. Absent = every kind. */
  kinds?: FundKind[]
}

const companies = (p: ChecklistParams) =>
  p.portfolioCompanies && p.portfolioCompanies > 0 ? `all ${p.portfolioCompanies} portfolio companies` : 'every portfolio company'

/**
 * The library. Offsets assume a delivery about 45 days after quarter-end; a tighter calendar is
 * compressed proportionally (see `dueDates`). Dependencies are by key and must stay acyclic —
 * template.test.ts checks.
 */
export const TASK_LIBRARY: LibraryTask[] = [
  // ── Portfolio companies ────────────────────────────────────────────────────────────────────
  {
    key: 'pc_financials',
    title: p => `Collect quarterly financials and KPIs from ${companies(p)}`,
    description: 'Income statement, balance sheet, cash and runway, and the KPIs the fund tracks, for the quarter just ended.',
    owner: 'portfolio_companies', daysBefore: 40, dependsOn: [], tieOut: true,
  },
  {
    key: 'pc_cap_tables',
    title: 'Collect cap tables and closing documents for any new financing rounds',
    description: 'Every round, SAFE or note conversion in the quarter, with the price per share the marks will use.',
    owner: 'portfolio_companies', daysBefore: 40, dependsOn: [], tieOut: false,
  },
  {
    key: 'pc_covenants',
    title: 'Collect covenant compliance certificates and lender reports',
    description: 'Each company\'s compliance certificate and leverage calculation for the quarter.',
    owner: 'portfolio_companies', daysBefore: 38, dependsOn: [], tieOut: false, kinds: ['pe'],
  },
  // ── Administrator: the books up to the marks ───────────────────────────────────────────────
  {
    key: 'adm_bank_rec',
    title: 'Reconcile cash and bank accounts to the quarter-end statements',
    description: 'Every bank and custody account agreed to its statement; unmatched items cleared or explained.',
    owner: 'administrator', daysBefore: 35, dependsOn: [], tieOut: true,
  },
  {
    key: 'adm_capital_activity',
    title: 'Record capital calls, distributions and LP transfers for the quarter',
    description: 'Calls and distributions booked to each partner, receipts matched, transfers and secondaries reflected.',
    owner: 'administrator', daysBefore: 35, dependsOn: [], tieOut: true,
  },
  {
    key: 'adm_credit_facility',
    title: 'Reconcile the subscription line and credit facility balances and interest',
    description: 'Drawn balance, accrued interest and fees agreed to the lender statement.',
    owner: 'administrator', daysBefore: 33, dependsOn: [], tieOut: true, kinds: ['pe'],
  },
  {
    key: 'adm_fees_expenses',
    title: 'Calculate the management fee and accrue fund expenses',
    description: 'Fee on the right basis for the period (commitments or invested capital), offsets applied, expenses accrued.',
    owner: 'administrator', daysBefore: 30, dependsOn: ['adm_capital_activity'], tieOut: true,
  },
  // ── Internal: the marks ────────────────────────────────────────────────────────────────────
  {
    key: 'int_valuations',
    title: 'Prepare quarter-end valuations (new rounds, write-downs, 409As)',
    description: 'A mark for every position with its basis: latest priced round, write-down, or cost.',
    owner: 'internal', daysBefore: 30, dependsOn: ['pc_financials', 'pc_cap_tables'], tieOut: true, kinds: ['venture'],
  },
  {
    key: 'int_valuations',
    title: 'Prepare fair value models for each portfolio company (comparables, DCF)',
    description: 'A model per company on the quarter\'s financials, with comparables refreshed and covenant headroom noted.',
    owner: 'internal', daysBefore: 30, dependsOn: ['pc_financials', 'pc_cap_tables', 'pc_covenants'], tieOut: true, kinds: ['pe'],
  },
  {
    key: 'int_valuation_approval',
    title: 'Valuation committee approves the marks',
    description: 'Minutes recording each mark approved, and any changed from the proposal.',
    owner: 'internal', daysBefore: 25, dependsOn: ['int_valuations'], tieOut: false,
  },
  // ── Administrator: from the marks to the statements ────────────────────────────────────────
  {
    key: 'adm_book_valuations',
    title: 'Book unrealized gains and losses from the approved marks',
    description: 'The schedule of investments at the approved fair values, with the change booked to the ledger.',
    owner: 'administrator', daysBefore: 22, dependsOn: ['int_valuation_approval'], tieOut: true,
  },
  {
    key: 'adm_allocations',
    title: 'Run partner allocations and the carry waterfall',
    description: 'Income, expenses and gains allocated to each partner; carried interest accrued under the LPA terms.',
    owner: 'administrator', daysBefore: 19,
    dependsOn: ['adm_book_valuations', 'adm_fees_expenses', 'adm_bank_rec', 'adm_credit_facility'], tieOut: true,
  },
  {
    key: 'adm_close_period',
    title: 'Close the quarter in the books',
    description: 'Lock the period so nothing posts into it after the statements are drawn.',
    owner: 'administrator', daysBefore: 17, dependsOn: ['adm_allocations'], tieOut: false,
  },
  {
    key: 'adm_financial_statements',
    title: 'Prepare financial statements and the schedule of investments',
    description: 'Balance sheet, operations, changes in partners\' capital, cash flows and the schedule of investments.',
    owner: 'administrator', daysBefore: 14, dependsOn: ['adm_close_period'], tieOut: true,
  },
  {
    key: 'adm_capital_statements',
    title: 'Prepare LP capital account statements',
    description: 'One statement per partner, summing to partners\' capital on the balance sheet.',
    owner: 'administrator', daysBefore: 12, dependsOn: ['adm_close_period'], tieOut: true,
  },
  // ── Internal: review and delivery ──────────────────────────────────────────────────────────
  {
    key: 'int_lp_letter',
    title: 'Draft the quarterly LP letter and portfolio company updates',
    description: 'The quarter\'s narrative, each company\'s update, and the fund\'s performance figures.',
    owner: 'internal', daysBefore: 12, dependsOn: ['pc_financials', 'int_valuation_approval'], tieOut: true,
  },
  {
    key: 'int_review',
    title: 'Review the financial statements and capital statements',
    description: 'CFO or GP review: statements agree to the trial balance, capital statements sum to partners\' capital.',
    owner: 'internal', daysBefore: 8, dependsOn: ['adm_financial_statements', 'adm_capital_statements'], tieOut: false,
  },
  {
    key: 'int_signoff',
    title: 'Final sign-off on the LP reporting package',
    description: 'The GP approves the package as it will go out.',
    owner: 'internal', daysBefore: 3, dependsOn: ['int_review', 'int_lp_letter'], tieOut: false,
  },
  {
    key: 'int_deliver',
    title: 'Publish the LP reports and notify LPs',
    description: 'Statements and the letter published to the LP portal, and LPs notified.',
    owner: 'internal', daysBefore: 0, dependsOn: ['int_signoff'], tieOut: false,
  },
]

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`)
const toIso = (d: Date) => d.toISOString().slice(0, 10)
export const addDays = (iso: string, n: number) => toIso(new Date(toDate(iso).getTime() + n * DAY))
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY)

/** The business day on or before a date: a Saturday or Sunday rolls back to Friday. No holidays. */
export function businessDayOnOrBefore(iso: string): string {
  const dow = toDate(iso).getUTCDay()
  return dow === 6 ? addDays(iso, -1) : dow === 0 ? addDays(iso, -2) : iso
}

/** The business day on or after a date. */
export function businessDayOnOrAfter(iso: string): string {
  const dow = toDate(iso).getUTCDay()
  return dow === 6 ? addDays(iso, 2) : dow === 0 ? addDays(iso, 1) : iso
}

/** The latest calendar quarter-end strictly before a date. */
export function quarterEndBefore(iso: string): string {
  const d = toDate(iso)
  const y = d.getUTCFullYear()
  const q = Math.floor(d.getUTCMonth() / 3)
  // The quarter-end before the quarter `iso` falls in — day 0 of its first month.
  const prev = toIso(new Date(Date.UTC(y, q * 3, 0)))
  return prev
}

/**
 * The due date for a task `daysBefore` the delivery date: rolled back to a business day, and never
 * on or before the quarter-end itself (no close task can be done before the quarter ends).
 */
export function dueDateFor(lpDeliveryDate: string, periodEnd: string, daysBefore: number): string {
  const due = businessDayOnOrBefore(addDays(lpDeliveryDate, -Math.max(0, daysBefore)))
  const earliest = businessDayOnOrAfter(addDays(periodEnd, 1))
  return due < earliest ? earliest : due
}

/** Extra lead time for collecting from many companies: a day per ten beyond ten, at most ten. */
export function companyLeadDays(n: number | null): number {
  if (!n || n <= 10) return 0
  return Math.min(10, Math.ceil((n - 10) / 10))
}

// ---------------------------------------------------------------------------------------------
// Building a checklist
// ---------------------------------------------------------------------------------------------

export interface GeneratedTask {
  key: string
  title: string
  description: string
  owner: OwnerGroup
  assignee: string | null
  daysBeforeDelivery: number
  dueDate: string
  dependsOn: string[]
  sortOrder: number
  tieOut: TieOutStatus
}

export interface GeneratedChecklist {
  title: string
  tasks: GeneratedTask[]
  warnings: string[]
}

/** How the administrator argument reads: an outside firm (named or not), or the fund's own team. */
export function administratorOf(raw: string | null | undefined): { outsourced: boolean; name: string | null } {
  const s = (raw ?? '').trim()
  if (!s || /^(in[- ]?house|internal|none|self|n\/?a)$/i.test(s)) return { outsourced: false, name: null }
  if (/^(outsourced|external|third[- ]party)$/i.test(s)) return { outsourced: true, name: null }
  return { outsourced: true, name: s.slice(0, 120) }
}

export function quarterLabel(periodEnd: string): string {
  const d = toDate(periodEnd)
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
}

/** Problems with the parameters, or null. */
export function paramProblem(p: ChecklistParams): string | null {
  if (p.fundKind !== 'venture' && p.fundKind !== 'pe') return 'fund_kind must be "venture" or "pe"'
  if (!isIsoDate(p.lpDeliveryDate)) return 'lp_delivery_date must be a date (YYYY-MM-DD)'
  if (!isIsoDate(p.periodEnd)) return 'period_end must be a date (YYYY-MM-DD)'
  if (p.lpDeliveryDate <= p.periodEnd) return `The LP delivery date (${p.lpDeliveryDate}) must be after the quarter-end (${p.periodEnd})`
  if (daysBetween(p.periodEnd, p.lpDeliveryDate) > 365) return 'The LP delivery date is more than a year after the quarter-end'
  if (p.portfolioCompanies != null && (!Number.isInteger(p.portfolioCompanies) || p.portfolioCompanies < 0 || p.portfolioCompanies > 10000)) {
    return 'portfolio_companies must be a whole number'
  }
  return null
}

/**
 * Build the checklist for a fund. Due dates are counted back from the LP delivery date. When the
 * window between quarter-end and delivery is shorter than the library assumes, every offset is
 * compressed in proportion so the order of the work survives, and a warning says so.
 */
export function buildChecklist(p: ChecklistParams): GeneratedChecklist {
  const problem = paramProblem(p)
  if (problem) throw new Error(problem)
  const admin = administratorOf(p.administrator)
  const lead = companyLeadDays(p.portfolioCompanies)
  const library = TASK_LIBRARY.filter(t => !t.kinds || t.kinds.includes(p.fundKind))
  const keys = new Set(library.map(t => t.key))

  const raw = library.map(t => ({ t, days: t.daysBefore + (t.owner === 'portfolio_companies' ? lead : 0) }))
  const span = Math.max(...raw.map(r => r.days))
  // The last day work can be due is the delivery date; the first is the day after quarter-end.
  const window = daysBetween(p.periodEnd, p.lpDeliveryDate) - 1
  const factor = window < span ? Math.max(0, window) / span : 1
  const warnings: string[] = []
  if (factor < 1) {
    warnings.push(
      `LP delivery is ${window + 1} days after quarter-end, shorter than the ${span + 1} days this checklist assumes. ` +
      'Every due date has been compressed in proportion; check the collection and valuation dates are realistic.',
    )
  }

  const tasks: GeneratedTask[] = raw.map(({ t, days }, i) => {
    const daysBeforeDelivery = Math.round(days * factor)
    let owner = t.owner
    let assignee: string | null = null
    if (t.owner === 'administrator') {
      if (admin.outsourced) assignee = admin.name ?? 'Fund administrator'
      else { owner = 'internal'; assignee = 'Fund accounting (in-house)' }
    }
    if (t.owner === 'portfolio_companies') assignee = 'Each company\'s CFO or finance lead'
    return {
      key: t.key,
      title: typeof t.title === 'function' ? t.title(p) : t.title,
      description: t.description,
      owner,
      assignee,
      daysBeforeDelivery,
      dueDate: dueDateFor(p.lpDeliveryDate, p.periodEnd, daysBeforeDelivery),
      dependsOn: t.dependsOn.filter(k => keys.has(k)),
      sortOrder: (i + 1) * 10,
      tieOut: t.tieOut ? 'pending' : 'not_required',
    }
  })
  if (!admin.outsourced) {
    warnings.push('No outside administrator, so the administrator\'s tasks are grouped under the internal team.')
  }

  const kind = p.fundKind === 'pe' ? 'PE' : 'Venture'
  return { title: `${quarterLabel(p.periodEnd)} close (${kind})`, tasks, warnings }
}

// ---------------------------------------------------------------------------------------------
// The dependency graph
// ---------------------------------------------------------------------------------------------

export interface GraphTask {
  key: string
  dependsOn: string[]
  status?: TaskStatus
  dueDate?: string
  sortOrder?: number
}

const isClosed = (s: TaskStatus | undefined) => s === 'done' || s === 'not_applicable'

/** A dependency cycle among the tasks, as the keys around it, or null. */
export function findCycle(tasks: Pick<GraphTask, 'key' | 'dependsOn'>[]): string[] | null {
  const deps = new Map(tasks.map(t => [t.key, t.dependsOn]))
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k]
    state.set(k, 1)
    stack.push(k)
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(k, 2)
    return null
  }
  for (const t of tasks) {
    const c = visit(t.key)
    if (c) return c
  }
  return null
}

/**
 * For each task, how many tasks depend on it, directly or through others. With `openOnly`, closed
 * tasks (done, N/A) neither block nor count: what is left of the close, not what it was.
 */
export function downstreamCounts(tasks: GraphTask[], opts: { openOnly?: boolean } = {}): Map<string, number> {
  const live = opts.openOnly ? tasks.filter(t => !isClosed(t.status)) : tasks
  const liveKeys = new Set(live.map(t => t.key))
  const dependents = new Map<string, string[]>()
  for (const t of live) {
    for (const d of t.dependsOn) {
      if (!liveKeys.has(d)) continue
      dependents.set(d, [...(dependents.get(d) ?? []), t.key])
    }
  }
  const out = new Map<string, number>()
  for (const t of live) {
    const seen = new Set<string>()
    const queue = [...(dependents.get(t.key) ?? [])]
    while (queue.length) {
      const k = queue.pop()!
      if (seen.has(k) || k === t.key) continue
      seen.add(k)
      queue.push(...(dependents.get(k) ?? []))
    }
    out.set(t.key, seen.size)
  }
  return out
}

/**
 * The one task that blocks the most downstream work. Ties go to the earlier due date, then the
 * earlier task. With `openOnly`, the task holding up the most of what remains; null when nothing
 * open blocks anything.
 */
export function criticalTask<T extends GraphTask>(tasks: T[], opts: { openOnly?: boolean } = {}): { task: T; downstream: number } | null {
  const counts = downstreamCounts(tasks, opts)
  let best: { task: T; downstream: number } | null = null
  for (const t of tasks) {
    const n = counts.get(t.key)
    if (n == null || n === 0) continue
    if (
      !best || n > best.downstream ||
      (n === best.downstream && (t.dueDate ?? '') < (best.task.dueDate ?? '')) ||
      (n === best.downstream && (t.dueDate ?? '') === (best.task.dueDate ?? '') && (t.sortOrder ?? 0) < (best.task.sortOrder ?? 0))
    ) best = { task: t, downstream: n }
  }
  return best
}

/** The open tasks a task is waiting on. */
export function blockedBy(task: GraphTask, all: GraphTask[]): string[] {
  const byKey = new Map(all.map(t => [t.key, t]))
  return task.dependsOn.filter(k => {
    const d = byKey.get(k)
    return d && !isClosed(d.status)
  })
}

// ---------------------------------------------------------------------------------------------
// Done versus tied out
// ---------------------------------------------------------------------------------------------

export interface TaskState {
  status: TaskStatus
  tieOut: TieOutStatus
  completedBy: string | null
}

export interface TaskChange {
  status?: TaskStatus
  tieOut?: TieOutStatus
  note?: string | null
}

export interface Actor {
  userId: string | null
  isAdmin: boolean
}

export type TieOutDecision =
  | { ok: true; next: { status: TaskStatus; tieOut: TieOutStatus }; resetTieOut: boolean; selfTieOut: boolean }
  | { ok: false; error: string }

/**
 * Apply a change to one task's two columns, enforcing:
 *   - a number is tied out only once its task is done;
 *   - the person who completed a task does not tie it out (an admin may, with a note saying why);
 *   - an exception needs a note;
 *   - reopening a done task un-ties its numbers — they are no longer the numbers that were checked.
 */
export function decideTaskChange(current: TaskState, change: TaskChange, actor: Actor): TieOutDecision {
  const status = change.status ?? current.status
  let tieOut = change.tieOut ?? current.tieOut
  const note = (change.note ?? '').trim()
  let resetTieOut = false

  if (change.status && change.status !== 'done' && current.status === 'done' && current.tieOut === 'tied_out' && !change.tieOut) {
    tieOut = 'pending'
    resetTieOut = true
  }

  let selfTieOut = false
  if (change.tieOut && change.tieOut !== current.tieOut) {
    if (current.tieOut === 'not_required' && change.tieOut !== 'pending') {
      return { ok: false, error: 'This task has no numbers to tie out. Set tie_out to "pending" first if it now needs one.' }
    }
    if (change.tieOut === 'tied_out' || change.tieOut === 'exception') {
      if (status !== 'done') return { ok: false, error: 'Only a done task can be tied out. Mark it done first.' }
      const completer = change.status === 'done' && current.status !== 'done' ? actor.userId : current.completedBy
      if (completer && actor.userId && completer === actor.userId) {
        if (!actor.isAdmin) {
          return { ok: false, error: 'You completed this task, so someone else has to tie it out.' }
        }
        if (!note) return { ok: false, error: 'You completed this task. An admin can tie out their own work only with a note saying why.' }
        selfTieOut = true
      }
    }
    if (change.tieOut === 'exception' && !note) {
      return { ok: false, error: 'Say what does not tie out: an exception needs a note.' }
    }
  }
  return { ok: true, next: { status, tieOut }, resetTieOut, selfTieOut }
}

// ---------------------------------------------------------------------------------------------
// Describing a batch of task changes — for the person approving a staged tie-out
// ---------------------------------------------------------------------------------------------

/** Does a batch of task updates set any tie-out? Those stage for approval from chat. */
export function touchesTieOut(updates: unknown): boolean {
  return Array.isArray(updates) && updates.some(u => u && typeof u === 'object' && (u as Record<string, unknown>).tie_out != null)
}

/** One line per task update, in words. */
export function describeTaskUpdates(updates: unknown): string[] {
  if (!Array.isArray(updates)) return []
  return updates.slice(0, 50).map(u => {
    const r = (u ?? {}) as Record<string, unknown>
    const parts: string[] = []
    if (typeof r.status === 'string' && r.status in STATUS_LABELS) parts.push(`mark ${STATUS_LABELS[r.status as TaskStatus].toLowerCase()}`)
    if (typeof r.tie_out === 'string' && r.tie_out in TIE_OUT_LABELS) {
      parts.push(r.tie_out === 'tied_out' ? 'tie out its numbers' : r.tie_out === 'exception' ? 'record a tie-out exception' : `set tie-out to ${String(r.tie_out).replace('_', ' ')}`)
    }
    if (typeof r.assignee === 'string') parts.push(`assign to ${r.assignee.slice(0, 60)}`)
    if (r.due_date !== undefined) parts.push(r.due_date ? `due ${String(r.due_date).slice(0, 10)}` : 'due date back on the delivery count')
    if (typeof r.note === 'string' && r.note.trim()) parts.push(`note "${r.note.trim().slice(0, 80)}"`)
    return `${String(r.task ?? 'a task').slice(0, 80)}: ${parts.join(', ') || 'edit'}`
  })
}
