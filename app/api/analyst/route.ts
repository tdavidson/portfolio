import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimit } from '@/lib/rate-limit'
import { runAnalyst } from '@/lib/ai/analyst/orchestrator'
import { resolveAnalystPrincipal } from '@/lib/ai/analyst/request-context'
import {
  AnalystRequestError,
  type AnalystDocument,
  type AnalystDomain,
  type AnalystProgressEvent,
} from '@/lib/ai/analyst/types'
import { AI_EFFORTS, type AIEffort, type ChatMessage } from '@/lib/ai/types'

interface LegacyAnalystBody {
  messages?: ChatMessage[]
  companyId?: string
  dealId?: string
  vehicle?: string
  document?: AnalystDocument
  domain?: AnalystDomain
  model?: { id: string; provider: string }
  effort?: AIEffort
  conversationId?: string
  /**
   * Stream progress as newline-delimited JSON: `{type:'progress', event}` per step as it starts and
   * finishes, then one `{type:'result', data}` (the same body the plain response returns) or
   * `{type:'error', error, status}`. The panel uses it to show what the Analyst is doing and for
   * how long, instead of a static "Thinking…".
   */
  stream?: boolean
}

/** Cookie-authenticated web adapter over the shared, transport-neutral Analyst service. */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `ai-analyst:${user.id}`, limit: 30, windowSeconds: 300 })
  if (limited) return limited

  let body: LegacyAnalystBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: 'messages array is required' }, { status: 400 })
  }

  const admin = createAdminClient()

  const run = async (onProgress?: (event: AnalystProgressEvent) => void) => {
    const principal = await resolveAnalystPrincipal(admin, user.id)
    if (!principal) throw new AnalystRequestError('No fund found', 404, 'NO_FUND')
    const result = await runAnalyst(principal, {
      messages: body.messages!,
      conversationId: body.conversationId,
      signal: req.signal,
      onProgress,
      scope: {
        companyId: body.companyId,
        dealId: body.dealId,
        vehicle: body.vehicle,
        domain: body.domain,
      },
      model: body.model,
      effort: AI_EFFORTS.includes(body.effort as AIEffort) ? body.effort : undefined,
      document: body.document,
    }, {
      admin,
      isRateLimited: async spec => !!(await rateLimit(spec)),
    })
    // Preserve the web contract while extending it with safely ignorable versioned blocks.
    return {
      reply: result.reply,
      // Which model actually answered (Auto resolves server-side), for the transcript's meta line.
      model: result.usage ? { id: result.usage.model, provider: result.usage.provider } : null,
      conversationId: result.conversationId,
      proposals: result.proposals,
      vehicle: result.vehicle,
      scope: result.scope,
      toolCalls: result.toolCalls,
      stagedActions: result.stagedActions.map(action => ({
        id: action.id,
        actionType: action.actionType,
        preview: action.preview,
      })),
      blocks: result.blocks,
    }
  }

  const failure = (error: unknown): { status: number; error: string; retryAfter?: number } => {
    if (error instanceof AnalystRequestError) return { status: error.status, error: error.message, retryAfter: error.retryAfter }
    console.error('[analyst] request failed:', error)
    return { status: 500, error: 'Analyst request failed. Check your API key in Settings.' }
  }

  if (body.stream) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // The run is paid for and persisted whether or not anyone is still listening, so a closed
        // connection must not turn into a failed run.
        let open = true
        const send = (line: Record<string, unknown>) => {
          if (!open) return
          try { controller.enqueue(encoder.encode(JSON.stringify(line) + '\n')) } catch { open = false }
        }
        send({ type: 'started' })
        try {
          // Name and label only — tool arguments and results stay on the server.
          const data = await run(event => send({ type: 'progress', event }))
          send({ type: 'result', data })
        } catch (error) {
          if (!req.signal?.aborted) send({ type: 'error', ...failure(error) })
        } finally {
          if (open) controller.close()
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
    })
  }

  try {
    return NextResponse.json(await run())
  } catch (error) {
    if (req.signal?.aborted) return new NextResponse(null, { status: 499 })
    const f = failure(error)
    const headers = f.retryAfter ? { 'Retry-After': String(f.retryAfter) } : undefined
    return NextResponse.json({ error: f.error }, { status: f.status, headers })
  }
}
