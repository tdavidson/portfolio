import { createAdminClient } from '@/lib/supabase/admin'
import { runAnalyst } from '@/lib/ai/analyst/orchestrator'
import { AnalystRequestError, type AnalystProgressEvent } from '@/lib/ai/analyst/types'
import { chatDependencies, prepareChatRequest } from '@/lib/api-v1/chat-request'
import { V1PrincipalError } from '@/lib/api-v1/principal'
import { requestId, v1Error } from '@/lib/api-v1/response'
import { createEventStream, sseHeaders } from '@/lib/api-v1/stream'

/**
 * Streaming chat (Phase 5), as Server-Sent Events.
 *
 * COARSE EVENTS. There is no `message.delta` here: the provider abstraction resolves a whole
 * result from every method, so no incremental text exists to forward without reshaping
 * `AIProvider` and every caller of it. What IS available — and is where nearly all the waiting
 * actually happens — is tool progress, because the orchestrator supplies the tool executor. So a
 * client sees the run start, sees each lookup begin and finish, and then receives the complete
 * answer. `lib/api-v1/stream.ts` documents how a later version adds deltas without breaking this.
 *
 * A DROPPED CONNECTION CANNOT REPEAT A WRITE, and not because of anything here: chat only ever
 * STAGES an action. Applying one is a separate authenticated call through the pending-action
 * service, which claims the row before executing and replays a completed approval under the same
 * `Idempotency-Key`. That property must not be traded away by ever executing from this route.
 *
 * Errors BEFORE the stream opens are ordinary v1 JSON envelopes with a real status code — an
 * unauthenticated caller should get 401, not a 200 whose body says 401. Once the stream is open the
 * status is already sent, so a failure becomes a terminal `error` event instead.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const id = requestId()
  const admin = createAdminClient()

  let prepared
  try {
    prepared = await prepareChatRequest(admin, req)
  } catch (error) {
    if (error instanceof V1PrincipalError || error instanceof AnalystRequestError) {
      const headers = error instanceof AnalystRequestError && error.retryAfter
        ? { 'Retry-After': String(error.retryAfter) }
        : undefined
      return v1Error(error.code, error.message, error.status, id, headers)
    }
    console.error(`[api-v1] ${id} POST /chat/stream failed before streaming`, error)
    return v1Error('INTERNAL_ERROR', 'The request could not be completed.', 500, id)
  }

  const { principal, request } = prepared
  const events = createEventStream(id)

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The client may have gone away mid-run. Writing to a closed controller throws, and that
      // must not turn into a failed Analyst run — the work is already paid for and its result is
      // persisted regardless of whether anyone is listening.
      let open = true
      const send = (type: Parameters<typeof events.encode>[0], data?: Record<string, unknown>) => {
        if (!open) return
        try {
          controller.enqueue(events.encode(type, data))
        } catch {
          open = false
        }
      }

      events.setConversationId(request.conversationId ?? null)
      send('conversation.started', { blocksVersion: events.blocksVersion })

      try {
        const result = await runAnalyst(
          principal,
          {
            ...request,
            onProgress: (event: AnalystProgressEvent) => {
              // Name and label only. See AnalystProgressEvent for why arguments and results stay
              // on the server. Model rounds are the web panel's; this API's event set is a contract.
              if (event.kind === 'model.started') return
              send(event.kind, event.kind === 'tool.completed'
                ? { tool: event.tool, label: event.label, isError: event.isError }
                : { tool: event.tool, label: event.label })
            },
          },
          chatDependencies(admin, principal),
        )

        events.setConversationId(result.conversationId)

        // Blocks individually, so a client can render the first table before the last one exists.
        for (const block of result.blocks) {
          send('block.completed', { block })
        }

        // A staged action is the one thing in a run that asks the user for a decision, so it gets
        // its own event rather than being buried in the terminal payload. The id and the preview
        // are what an approval card needs; approving is a separate authenticated call.
        for (const action of result.stagedActions) {
          send('approval.required', {
            id: action.id,
            actionType: action.actionType,
            preview: action.preview,
          })
        }

        // Terminal, and authoritative: a client that saw only this event has the whole answer.
        send('message.completed', {
          reply: result.reply,
          conversationId: result.conversationId,
          scope: result.scope,
          vehicle: result.vehicle,
          blocks: result.blocks,
          proposals: result.proposals,
          toolCalls: result.toolCalls,
          stagedActions: result.stagedActions.map(action => ({
            id: action.id,
            actionType: action.actionType,
            preview: action.preview,
          })),
          usage: result.usage,
        })
      } catch (error) {
        const known = error instanceof AnalystRequestError || error instanceof V1PrincipalError
        if (!known) console.error(`[api-v1] ${id} POST /chat/stream failed mid-stream`, error)
        send('error', {
          code: known ? (error as AnalystRequestError).code : 'INTERNAL_ERROR',
          message: known ? (error as Error).message : 'The request could not be completed.',
        })
      } finally {
        if (open) controller.close()
      }
    },
  })

  return new Response(body, { status: 200, headers: sseHeaders(id) })
}
