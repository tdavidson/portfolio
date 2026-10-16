import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFundFromApiKey, authorizeToolUse, loadCredentialAccess } from '@/lib/accounting/api-keys'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { issuerFor } from '@/lib/oauth/metadata'
import { AGENT_TOOLS, getTool, accessDomainFor, accessDomainForCall, accessFeatureFor } from '@/lib/accounting/agent-tools'
import { AgentCallError, idempotencyKeyOf, runAgentTool } from '@/lib/agent/dispatch'
import { withChangeSource } from '@/lib/audit/source'
import { isGatewayTool } from '@/lib/mcp-apps/gateway-names'
import { hasAccess } from '@/lib/access/effective'
import { isToolOffered } from '@/lib/agent/destructive'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
// A submitted company update runs the extraction pipeline in the call (submit_company_update), as
// an emailed one does in /api/inbound-email. And a send with PDF attachments, or approving a capital
// call, waits on a Chromium-bundled route to render them (lib/agent/self-request.ts), whose own
// limit is 300: this one must outlast it, or the work completes after the chat was told it failed.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Plain REST agent endpoint (for non-MCP agents / simple HTTP), same tool
// registry as the MCP server. Auth via a fund API key Bearer token.
//   GET  → tool manifest (names, descriptions, input schemas)
//   POST { tool, input } → run one tool
//
// Lives at /api/agent, alongside /api/mcp. It was originally /api/accounting/agent,
// from when the tool registry exposed only ledger tools; it has since grown a whole
// portfolio domain (companies, investments, LP positions, fund performance), so
// `/funds/` was a misnomer for a good third of what it does. Unlike the MCP
// endpoint — which kept its old path working for already-issued keys and configs —
// this one moved outright: nothing was pointed at it yet.

export async function GET(req: NextRequest) {
  const admin = createAdminClient()
  const auth = await resolveFundFromApiKey(admin, req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized — provide a fund API key as a Bearer token' }, { status: 401 })

  // The fund's master switch for the agent surface. Checked per request rather
  // than baked into the key, so turning it off immediately disarms keys that were
  // already issued.
  if (!(await agentApiEnabled(admin, auth.fundId))) {
    return NextResponse.json(
      { error: 'Agent access is disabled for this fund. An admin can enable it in Settings → Agent access.' },
      { status: 403 }
    )
  }
  // Filtered to what this credential's owner may actually reach — the same rule tools/call
  // enforces, so the list never advertises a tool that would be refused.
  const access = await loadCredentialAccess(admin, auth)
  return NextResponse.json({
    tools: AGENT_TOOLS
      // Destructive tools only where the deployment turned them on (lib/agent/destructive.ts).
      .filter(t => isToolOffered(t) && hasAccess(access, accessDomainFor(t), t.scope, accessFeatureFor(t)))
      .map(t => ({ name: t.name, description: t.description, scope: t.scope, inputSchema: t.inputSchema })),
  })
}

/** Every change recorded while serving this request is attributed to the API (lib/audit/source.ts). */
export async function POST(req: NextRequest) {
  return withChangeSource('api', () => handlePost(req))
}

async function handlePost(req: NextRequest) {
  const admin = createAdminClient()
  const auth = await resolveFundFromApiKey(admin, req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized — provide a fund API key as a Bearer token' }, { status: 401 })

  // The fund's master switch for the agent surface. Checked per request rather
  // than baked into the key, so turning it off immediately disarms keys that were
  // already issued.
  if (!(await agentApiEnabled(admin, auth.fundId))) {
    return NextResponse.json(
      { error: 'Agent access is disabled for this fund. An admin can enable it in Settings → Agent access.' },
      { status: 403 }
    )
  }

  const body = await req.json().catch(() => ({}))
  // search_tools and call_tool are MCP-only (lib/mcp-apps/gateway.ts): they exist because chat
  // hosts cache the MCP tool list. Here GET is read fresh and POST takes any tool by name, so
  // there is nothing for them to work around, and no second route to keep in step with this one.
  if (isGatewayTool(body?.tool)) {
    return NextResponse.json({
      error: `${body.tool} is an MCP tool and is not needed here: GET /api/agent lists every tool you may use, and POST { tool, input } runs any of them by name.`,
    }, { status: 400 })
  }
  const tool = getTool(body?.tool)
  if (!tool) return NextResponse.json({ error: `Unknown tool: ${body?.tool}` }, { status: 400 })
  // The owner's grants, re-read live: a credential can never exceed the person who authorized it.
  // `accessDomainForCall` rather than the tool's own domain — an `allocation` call is ordinary
  // accounting until its action is 'carry'.
  const access = await loadCredentialAccess(admin, auth)
  const denied = authorizeToolUse(tool.scope, auth, access, accessDomainForCall(tool, body?.input ?? {}), accessFeatureFor(tool))
  if (denied) return NextResponse.json({ error: denied }, { status: 403 })

  // RATE LIMIT. This endpoint can post directly to the ledger and close periods, with no human
  // in the loop — strictly more powerful than the in-app assistant sitting beside it, which is
  // draft-only. It had no rate limit at all, so a leaked key allowed unbounded automated
  // posting. Writes are held far tighter than reads.
  const isWrite = tool.scope === 'write'
  const limited = await rateLimit({
    key: `accounting-agent:${isWrite ? 'w' : 'r'}:${auth.fundId}`,
    limit: isWrite ? 60 : 300,
    windowSeconds: 60,
  })
  if (limited) return limited

  try {
    const input = body?.input ?? {}
    // The one dispatcher: audits every write with this key as its credential, and replays a retry
    // that repeats its Idempotency-Key (lib/agent/dispatch.ts). API keys are not staged.
    const result = await runAgentTool({
      admin, tool, input, auth, access, channel: 'api', origin: issuerFor(req),
      idempotencyKey: idempotencyKeyOf(req.headers.get('idempotency-key')),
    })
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    // Don't leak internals to an API-key caller — log the detail, return the message only.
    console.error('[accounting-agent]', body?.tool, e)
    // A permission refusal is a 403, as the same operation is from the web.
    if (e instanceof AgentCallError && (e.code === 'ADMIN_ONLY' || e.code === 'DESTRUCTIVE_DISABLED')) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 })
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
