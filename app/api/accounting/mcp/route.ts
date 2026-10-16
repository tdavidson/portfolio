import { NextRequest, NextResponse } from 'next/server'
import { describePrompt, promptsFor, PromptArgumentError, renderPrompt } from '@/lib/agent/getting-started'
import { canReadFor } from '@/lib/mcp-apps/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAgentAuth, loadCredentialAccess, type ResolvedKey } from '@/lib/accounting/api-keys'
import { withChangeSource } from '@/lib/audit/source'
import type { AccessContext } from '@/lib/access/effective'
import { getMcpTool, listResources, negotiateProtocolVersion, readResource } from '@/lib/mcp-apps/server'
import { callMcpTool, type McpCallContext } from '@/lib/mcp-apps/call'
import { gatewayTargetName, listedTools, toolListVersion } from '@/lib/mcp-apps/gateway'
import { rateLimit } from '@/lib/rate-limit'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { issuerFor, wwwAuthenticate } from '@/lib/oauth/metadata'
import { iconUrl, type IconSize } from '@/lib/pwa'

export const runtime = 'nodejs'
// A submitted company update runs the extraction pipeline in the call (submit_company_update), as
// an emailed one does in /api/inbound-email. And a send with PDF attachments, or approving a capital
// call, waits on a Chromium-bundled route to render them (lib/agent/self-request.ts), whose own
// limit is 300: this one must outlast it, or the work completes after the chat was told it failed.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Minimal MCP server over Streamable HTTP (stateless JSON mode). Exposes the
// ledger + portfolio tool registry so any MCP client can drive the books, and the
// dashboard tools with the `ui://` view a host draws them in (lib/mcp-apps/server.ts).
// Implements initialize, tools/list, tools/call, resources/list, resources/read.
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

const SERVER_INFO = { name: 'reporting-ledger', version: '0.2.0' }

/**
 * Who this server is, with the icon a host may show for it (MCP 2025-11-25 `Implementation.icons`).
 * The icon is the fund's square app mark, the same one its home-screen app uses (lib/pwa.ts) —
 * not the logo, which is a wordmark and unreadable in a square. Absolute URLs on the address the
 * host reached: an icon is fetched by the host, which has no idea what a relative path is from.
 * Clients that predate the field ignore it.
 */
function serverInfo(origin: string | undefined) {
  if (!origin) return SERVER_INFO
  const icon = (size: IconSize) => ({ src: `${origin}${iconUrl(size)}`, mimeType: 'image/png', sizes: [`${size}x${size}`] })
  return { ...SERVER_INFO, title: 'Portfolio', websiteUrl: origin, icons: [icon(192), icon(512)] }
}

/**
 * Server instructions (MCP `InitializeResult.instructions`): read by the host's model before any
 * tool description. Tool descriptions alone were not enough for "help" — a model answered it from
 * its own idea of the server instead of opening the home dashboard, so the home page a member sees
 * depended on how they phrased the question.
 */
const SERVER_INSTRUCTIONS =
  'When the user asks for help, asks what you can do or what they can ask, says "hi", "start", ' +
  '"get started", "home" or "menu", or seems unsure what to ask, call show_home and present its ' +
  'overview. Do not describe these tools from memory: show_home lists only what this member may ' +
  'open, filtered to their own entities and access. ' +
  'Changes you make for the user may come back staged ({ staged: true, pendingActionId, approveUrl }) instead of applied: ' +
  'nothing has changed yet. Tell the user what the change is and give them the approveUrl: a person approves it in the app. ' +
  'You cannot approve a change you staged (approve_action refuses it); call reject_action if they decline. ' +
  'When a fix needs more than one change, stage them together with stage_run (a title, a rationale, the ordered steps ' +
  'and the balances that should hold afterwards) so the person reviews and approves it once. ' +
  'When an admin asks to set up the fund (or the fund is new), call setup_status, ask only for what is missing, ' +
  'confirm the plan, and apply it with one setup_fund call. ' +
  "When the user shares a portfolio company's update (a letter, deck or KPI sheet), pass it to submit_company_update " +
  'with the company named, rather than recording each figure yourself. ' +
  'Your tool list may be cached from when this conversation began. If a tool you expect is missing, or one ' +
  'you were told to call is not in your list, call search_tools to find it, then run it with call_tool.'

/** The instructions, with the version of the tool list this caller was served at initialize. */
function serverInstructions(version: string) {
  return `${SERVER_INSTRUCTIONS} This connection's tool list is version ${version}; search_tools reports the current one.`
}

interface RpcRequest { jsonrpc: string; id?: string | number | null; method: string; params?: any }

function ok(id: any, result: any) {
  return { jsonrpc: '2.0', id, result }
}
function err(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

type BaseCtx = McpCallContext

async function handle(rpc: RpcRequest, ctx: BaseCtx, auth: ResolvedKey, access: AccessContext): Promise<any | null> {
  switch (rpc.method) {
    case 'initialize':
      return ok(rpc.id, {
        protocolVersion: negotiateProtocolVersion(rpc.params?.protocolVersion),
        // Prompts are the templates a host lists in its prompt menu (lib/agent/getting-started.ts).
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: serverInfo(ctx.origin),
        instructions: serverInstructions(toolListVersion(access)),
        _meta: { toolListVersion: toolListVersion(access) },
      })
    case 'ping':
      return ok(rpc.id, {})
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null // notification — no response
    case 'tools/list':
      // Filtered by what the credential's owner may actually reach, so an agent is never shown a
      // tool it would be refused — and the tool list itself stops being a map of the fund's
      // contents to someone who can't read them.
      // search_tools and call_tool come last, on every list: a host caches the list per
      // conversation, and they are how a cached list reaches a tool added since (gateway.ts).
      return ok(rpc.id, { tools: listedTools(access), _meta: { toolListVersion: toolListVersion(access) } })
    case 'tools/call': {
      // The same function serves call_tool, so a call through the gateway cannot skip a check.
      const outcome = await callMcpTool({
        name: rpc.params?.name, args: rpc.params?.arguments ?? {}, meta: rpc.params?._meta, ctx, auth, access,
      })
      return 'error' in outcome ? err(rpc.id, outcome.error.code, outcome.error.message) : ok(rpc.id, outcome.result)
    }
    // The dashboard view. It is the same static document for every caller and carries no fund
    // data (the figures arrive with each tool result), so it needs no grant beyond the credential
    // this request already presented.
    // Prompt templates: ready-made requests ("Quarter-end review", "Draft a forecast") a host lists
    // for the member to pick. Filtered like tools, so nobody is offered a template for an area
    // they cannot read; a template carries no data, only words.
    case 'prompts/list':
      return ok(rpc.id, { prompts: promptsFor(canReadFor(access)).map(describePrompt) })
    case 'prompts/get': {
      const template = promptsFor(canReadFor(access)).find(p => p.name === rpc.params?.name)
      if (!template) return err(rpc.id, -32602, `Unknown prompt: ${rpc.params?.name}`)
      try {
        return ok(rpc.id, renderPrompt(template, rpc.params?.arguments))
      } catch (e) {
        if (e instanceof PromptArgumentError) return err(rpc.id, -32602, e.message)
        throw e
      }
    }
    case 'resources/list':
      return ok(rpc.id, listResources())
    case 'resources/templates/list':
      return ok(rpc.id, { resourceTemplates: [] })
    case 'resources/read': {
      const resource = readResource(rpc.params?.uri)
      return resource ? ok(rpc.id, resource) : err(rpc.id, -32002, `Resource not found: ${rpc.params?.uri}`)
    }
    default:
      return err(rpc.id, -32601, `Method not found: ${rpc.method}`)
  }
}

/** A JSON-RPC batch may not be used to amplify past the rate limit. */
const MAX_BATCH = 20

/**
 * Every change recorded while serving this request is attributed to MCP (lib/audit/source.ts),
 * including those recorded deep in shared code the web pages also call.
 */
export async function POST(req: NextRequest) {
  return withChangeSource('mcp', () => handlePost(req))
}

async function handlePost(req: NextRequest) {
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
  const ctx: BaseCtx = { admin, fundId: auth.fundId, userId: auth.userId, access, origin: issuerFor(req) }
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
    // Through call_tool, the tool it names: a write by any route is metered as a write.
    const tool = getMcpTool(gatewayTargetName(c?.params))
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
