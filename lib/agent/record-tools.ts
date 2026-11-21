// Handlers for the Audit tools (record-tools-manifest.ts). Thin: lib/records decides who may
// file and read, the same code the /api/records route calls.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { fileRecord, readRecord, type RecordActor } from '@/lib/records'
import { readAuditLog, setAuditVisibility } from '@/lib/audit-log'
import { unwrap } from '@/lib/service-outcome'

async function actor(ctx: AgentToolContext, withEmail = false): Promise<RecordActor> {
  let email: string | null = null
  if (withEmail && ctx.userId) {
    const { data } = await ctx.admin.auth.admin.getUserById(ctx.userId)
    email = data?.user?.email ?? null
  }
  return { access: ctx.access, userId: ctx.userId, email }
}

export const RECORD_HANDLERS: Record<string, AgentToolHandler> = {
  file_to_record: async (ctx, input) => {
    const record = unwrap(await fileRecord(ctx.admin, await actor(ctx, true), input))
    return { record, next: 'Filed. Tell the person it is in the fund\'s Audit log, which audit_log reads.' }
  },
  audit_log: async (ctx, input) => unwrap(await readAuditLog(ctx.admin, ctx.access, {
    firm: input?.firm, since: input?.since, until: input?.until, limit: input?.limit,
  })),
  audit_settings: async (ctx, input) => ({
    ...unwrap(await setAuditVisibility(ctx.admin, ctx.access, input?.visibility)),
    next: 'Done. The Audit page and audit_log follow the new setting from the next request.',
  }),
  read_record: async (ctx, input) => ({ record: unwrap(await readRecord(ctx.admin, await actor(ctx), input?.id)) }),
}
