// Handlers for the fund records tools (record-tools-manifest.ts). Thin: lib/records decides who may
// file and read, the same code the /api/records route calls.

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { fileRecord, listRecords, readRecord, type RecordActor } from '@/lib/records'
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
    return { record, next: 'Filed. Tell the person it is on the fund\'s record and can be found with list_records.' }
  },
  list_records: async (ctx, input) => ({
    records: unwrap(await listRecords(ctx.admin, await actor(ctx), {
      area: input?.area, entity: input?.entity, subjectType: input?.subject_type, subjectId: input?.subject_id, query: input?.query, limit: input?.limit,
    })),
  }),
  read_record: async (ctx, input) => ({ record: unwrap(await readRecord(ctx.admin, await actor(ctx), input?.id)) }),
}
