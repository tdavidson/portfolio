// Pure metadata for the CLOSE CHECKLIST agent tools: build a quarter-end close checklist, read it,
// and work it — status, the separate "tied out" column, owners and dates. NO server imports.
// Handlers live in close-tools.ts and call lib/close-checklist/service.ts, the same service as the
// web routes under /api/accounting/close-checklists.
//
// Fund-scoped (a checklist may name one entity, but most cover the fund), gated on accounting.
// Building a checklist and moving its tasks apply directly from chat: they plan work and change no
// books or figures (see WORK_TRACKING in dispatch.ts). A tie-out is an attestation that a number
// was checked, so a call that sets one is staged for a person to approve, like any other write.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const CHECKLIST = {
  type: 'string',
  description: 'The checklist: its id, its quarter-end date (YYYY-MM-DD), or "latest" (default).',
}

export const CLOSE_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'close_checklist_create',
    description:
      'Build a quarter-end close checklist that fits the fund: tasks grouped by owner (administrator, portfolio companies, internal), ' +
      'each with a due date counted back from the LP delivery date, the dependencies between them, the one task that blocks the most ' +
      'downstream work (criticalTask), and a separate "Tied out" column so a completed task is not confused with a verified number. ' +
      'Saved in the app, so the team works it on the Close checklist page or here. Present the result as one table per owner group ' +
      'with columns Task, Assignee, Due, Status, Tied out; name the critical task and say why it matters.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        fund_kind: { type: 'string', enum: ['venture', 'pe'], description: 'venture (default) or pe (private equity / buyout).' },
        portfolio_companies: { type: 'number', description: 'How many portfolio companies report each quarter.' },
        administrator: { type: 'string', description: 'The fund administrator\'s name, "outsourced", or "in-house" if the team keeps its own books.' },
        lp_delivery_date: { type: 'string', description: 'When LP reporting is due, YYYY-MM-DD.' },
        period_end: { type: 'string', description: 'Optional: the quarter-end being closed, YYYY-MM-DD. Default: the last quarter-end before the delivery date.' },
        entity: { type: 'string', description: 'Optional: one fund or SPV, by name. Omit for the whole fund.' },
        title: { type: 'string', description: 'Optional: a title. Default "Q3 2026 close (Venture)".' },
      },
      required: ['lp_delivery_date'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_checklist',
    description:
      'A close checklist with every task by owner group: due date, status, the "Tied out" column (with who tied it out), what each ' +
      'task is waiting on, which are overdue, the critical task in the plan and the open task holding up the most work now ' +
      '(currentBlocker), and a summary — including done tasks whose numbers nobody has tied out yet.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: { type: 'object', properties: { checklist: CHECKLIST }, additionalProperties: false },
  },
  {
    name: 'close_checklist_list',
    description: 'List the fund\'s close checklists, newest quarter first.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { include_archived: { type: 'boolean', description: 'Include archived checklists.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'close_checklist_update_tasks',
    description:
      'Work a close checklist: mark tasks in_progress, done or not_applicable; tie out a done task\'s numbers (tie_out: tied_out, or ' +
      'exception with a note saying what does not agree); reassign; move a due date (null puts it back on the count from the delivery ' +
      'date); add notes. Several tasks in one call. Rules the app enforces: only a done task can be tied out, the person who completed ' +
      'a task cannot tie it out (an admin may, with a note), and reopening a tied-out task un-ties it.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        checklist: CHECKLIST,
        updates: {
          type: 'array',
          description: 'One entry per task.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The task id, its key (e.g. adm_bank_rec), or its title.' },
              status: { type: 'string', enum: ['not_started', 'in_progress', 'done', 'not_applicable'] },
              tie_out: { type: 'string', enum: ['not_required', 'pending', 'tied_out', 'exception'] },
              note: { type: 'string', description: 'Why: required for an exception, or for an admin tying out their own work.' },
              assignee: { type: 'string' },
              due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to count it back from the delivery date again.' },
              notes: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['task'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_checklist_add_task',
    description: 'Add a task of the fund\'s own to a close checklist, with its owner group, due date (or days before delivery) and what it waits on.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        checklist: CHECKLIST,
        title: { type: 'string' },
        owner: { type: 'string', enum: ['administrator', 'portfolio_companies', 'internal'] },
        assignee: { type: 'string' },
        days_before_delivery: { type: 'number', description: 'Due this many days before LP delivery (moves with the delivery date).' },
        due_date: { type: 'string', description: 'Or a fixed date, YYYY-MM-DD.' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Tasks it waits on (ids, keys or titles).' },
        needs_tie_out: { type: 'boolean', description: 'Does it produce a number someone must tie out? Default true.' },
        description: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_checklist_update',
    description:
      'Change a close checklist: move the LP delivery date (every task without its own date moves with it), rename it, or set its ' +
      'status (open, delivered, archived).',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: {
        checklist: CHECKLIST,
        lp_delivery_date: { type: 'string', description: 'YYYY-MM-DD' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['open', 'delivered', 'archived'] },
      },
      additionalProperties: false,
    },
  },
]
