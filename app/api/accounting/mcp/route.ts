import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAgentAuth, authorizeToolUse, loadCredentialAccess, type ResolvedKey } from '@/lib/accounting/api-keys'
import { AGENT_TOOLS, getTool, resolveVehicleForTool, accessDomainFor, accessDomainForCall, accessFeatureFor, type AgentToolContext } from '@/lib/accounting/agent-tools'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { rateLimit } from '@/lib/rate-limit'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { wwwAuthenticate } from '@/lib/oauth/metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Minimal MCP server over Streamable HTTP (stateless JSON mode). Exposes the
// ledger + portfolio tool registry so any MCP client can drive the books.
// Implements initialize, tools/list, tools/call.
//
// AUTH — two accepted credentials, one security model:
//   * `lk_…`      static fund API key (CLI / headless clients)
//   * `mcp_at_…`  OAuth access token (the claude.ai connector, via /oauth/authorize)
// Both resolve to the same ResolvedKey, so fund scoping and write authorization
// are identical either way. See lib/accounting/api-keys.ts:resolveAgentAuth.
//
// The 401 carries a `WWW-Authenticate` header pointing at our protected-resource
// metadata. That header is what lets an OAuth client discover how to authenticate
// from a bare 401 — without it, a connector that hasn't been told where to look
// has nowhere to start.

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'reporting-ledger', version: '0.1.0' }

interface RpcRequest { jsonrpc: string; id?: string | number | null; method: string; params?: any }

function ok(id: any, result: any) {
  return { jsonrpc: '2.0', id, result }
}
function err(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

type BaseCtx = Omit<AgentToolContext, 'portfolioGroup'>

async function handle(rpc: RpcRequest, ctx: BaseCtx, auth: ResolvedKey, access: AccessContext): Promise<any | null> {
  switch (rpc.method) {
    case 'initialize':
      return ok(rpc.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
    case 'ping':
      return ok(rpc.id, {})
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null // notification — no response
    case 'tools/list':
      // Filtered by what the credential's owner may actually reach, so an agent is never shown a
      // tool it would be refused — and the tool list itself stops being a map of the fund's
      // contents to someone who can't read them.
      return ok(rpc.id, {
        tools: AGENT_TOOLS
          .filter(t => hasAccess(access, accessDomainFor(t), t.scope, accessFeatureFor(t)))
          .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const name = rpc.params?.name
      const tool = getTool(name)
      if (!tool) return err(rpc.id, -32602, `Unknown tool: ${name}`)
      const args = rpc.params?.arguments ?? {}
      // The CALL's domain, not just the tool's: `allocation` is ordinary accounting until its
      // action is 'carry'.
      const denied = authorizeToolUse(tool.scope, auth, access, accessDomainForCall(tool, args), accessFeatureFor(tool))
      if (denied) return ok(rpc.id, { content: [{ type: 'text', text: denied }], isError: true })
      try {
        const portfolioGroup = await resolveVehicleForTool(tool, ctx.admin, ctx.fundId, args.vehicle, access)
        const result = await tool.handler({ ...ctx, portfolioGroup }, args)
        return ok(rpc.id, { content: [{ type: 'text', text: JSON.stringify(result) }] })
      } catch (e) {
        return ok(rpc.id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    }
    default:
      return err(rpc.id, -32601, `Method not found: ${rpc.method}`)
  }
}

/** A JSON-RPC batch may not be used to amplify past the rate limit. */
const MAX_BATCH = 20

export async function POST(req: NextRequest) {
  const admin = createAdminClient()
  const auth = await resolveAgentAuth(admin, req)
  if (!auth) {
    return NextResponse.json(
      err(null, -32001, 'Unauthorized — present a fund API key or an OAuth access token as a Bearer token'),
      { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate(req) } }
    )
  }

  // The fund's master switch for the whole agent surface. Checked per request, not
  // baked into the credential, so an admin turning it off immediately kills keys
  // and tokens that were already issued.
  if (!(await agentApiEnabled(admin, auth.fundId))) {
    return NextResponse.json(
      err(null, -32003, 'Agent access is disabled for this fund. An admin can enable it in Settings → Agent access.'),
      { status: 403 }
    )
  }

  // The owner's grants, re-read live — a credential can never exceed the person who authorized it,
  // and revoking their grant narrows every key and token they hold on the next call.
  const access = await loadCredentialAccess(admin, auth)
  const ctx: BaseCtx = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json(err(null, -32700, 'Parse error'), { status: 400 })

  // Support JSON-RPC batches.
  if (Array.isArray(body)) {
    // A batch is N tool calls in one HTTP request. Unbounded, and fanned out with Promise.all,
    // it was an amplification primitive: 10,000 `post_entry` calls executing concurrently
    // against the database from a single request — and, because the REST agent's rate limiter
    // was never called here, entirely unmetered.
    if (body.length > MAX_BATCH) {
      return NextResponse.json(
        err(null, -32600, `Batch too large: ${body.length} calls. The limit is ${MAX_BATCH}.`),
        { status: 400 }
      )
    }

    // Meter EVERY call in the batch, not the request. Otherwise the limit is trivially
    // side-stepped by packing calls into batches.
    const limited = await meter(auth, body, body.length)
    if (limited) return limited

    // Sequential, not Promise.all — these are ledger writes.
    const responses = []
    for (const rpc of body) {
      const r = await handle(rpc, ctx, auth, access)
      if (r) responses.push(r)
    }
    return responses.length ? NextResponse.json(responses) : new NextResponse(null, { status: 202 })
  }

  const limited = await meter(auth, [body], 1)
  if (limited) return limited

  const response = await handle(body, ctx, auth, access)
  if (response === null) return new NextResponse(null, { status: 202 })
  return NextResponse.json(response)
}

/**
 * The same rate limit the REST agent route enforces.
 *
 * This endpoint dispatches the IDENTICAL tool registry with identical write authority, and had
 * no limiter at all — so a leaked write key simply posted here instead of /api/agent
 * and got unbounded ledger writes, period closes and AI-credit burn.
 *
 * `cost` counts each call in a batch, so batching cannot be used to amplify past the limit.
 */
async function meter(
  auth: { fundId: string },
  calls: any[],
  cost: number
): Promise<NextResponse | null> {
  const isWrite = calls.some(c => {
    if (c?.method !== 'tools/call') return false
    const tool = getTool(c?.params?.name)
    return tool?.scope === 'write'
  })

  for (let i = 0; i < cost; i++) {
    const limited = await rateLimit({
      key: `accounting-agent:${isWrite ? 'w' : 'r'}:${auth.fundId}`,
      limit: isWrite ? 60 : 300,
      windowSeconds: 60,
    })
    if (limited) {
      return NextResponse.json(
        err(null, -32000, 'Rate limit exceeded. Slow down.'),
        { status: 429 }
      )
    }
  }
  return null
}

export async function GET() {
  // Streamable-HTTP SSE stream is not implemented; this server is stateless JSON.
  return NextResponse.json({ error: 'Use POST with JSON-RPC. This MCP server runs in stateless JSON mode.' }, { status: 405 })
}
