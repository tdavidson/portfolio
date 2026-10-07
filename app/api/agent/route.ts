import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFundFromApiKey, authorizeToolUse, loadCredentialAccess } from '@/lib/accounting/api-keys'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { AGENT_TOOLS, getTool, resolveVehicleForTool, accessDomainFor, accessDomainForCall, accessFeatureFor } from '@/lib/accounting/agent-tools'
import { hasAccess } from '@/lib/access/effective'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
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
      .filter(t => hasAccess(access, accessDomainFor(t), t.scope, accessFeatureFor(t)))
      .map(t => ({ name: t.name, description: t.description, scope: t.scope, inputSchema: t.inputSchema })),
  })
}

export async function POST(req: NextRequest) {
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
    const portfolioGroup = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle, access)
    const result = await tool.handler({ admin, fundId: auth.fundId, portfolioGroup, userId: auth.userId, access }, input)
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    // Don't leak internals to an API-key caller — log the detail, return the message only.
    console.error('[accounting-agent]', body?.tool, e)
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
