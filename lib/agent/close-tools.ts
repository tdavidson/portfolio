import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import {
  addTask, createChecklist, getChecklist, listChecklists, updateChecklist, updateTasks, CloseChecklistError,
  type CloseChecklistContext,
} from '@/lib/close-checklist/service'

// The close checklist tools: thin over lib/close-checklist/service.ts, which the web routes call too.

function svc(ctx: AgentToolContext): CloseChecklistContext {
  return { admin: ctx.admin, fundId: ctx.fundId, userId: ctx.userId, access: ctx.access }
}

/** A service refusal reads as the tool's error, with the service's own wording. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof CloseChecklistError) throw new Error(e.message)
    throw e
  }
}

export const CLOSE_HANDLERS: Record<string, AgentToolHandler> = {
  close_checklist_create: async (ctx, input) => run(() => createChecklist(svc(ctx), {
    fundKind: input?.fund_kind,
    portfolioCompanies: input?.portfolio_companies,
    administrator: input?.administrator,
    lpDeliveryDate: input?.lp_delivery_date,
    periodEnd: input?.period_end,
    entity: input?.entity,
    title: input?.title,
  })),

  close_checklist: async (ctx, input) => run(() => getChecklist(svc(ctx), input?.checklist)),

  close_checklist_list: async (ctx, input) => run(() => listChecklists(svc(ctx), { includeArchived: input?.include_archived === true })),

  close_checklist_update_tasks: async (ctx, input) => run(() => updateTasks(svc(ctx), input?.checklist, input?.updates)),

  close_checklist_add_task: async (ctx, input) => run(() => addTask(svc(ctx), input?.checklist, input ?? {})),

  close_checklist_update: async (ctx, input) => run(() => updateChecklist(svc(ctx), input?.checklist, {
    lpDeliveryDate: input?.lp_delivery_date,
    title: input?.title,
    status: input?.status,
  })),
}
