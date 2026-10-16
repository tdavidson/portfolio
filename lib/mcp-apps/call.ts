// One `tools/call`, whichever way it was named: directly, or through `call_tool` (./gateway.ts).
// Lives here rather than in the route so both are provably the same path, and so the tests can
// see that they are.

import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import { getTool, resolveVehicleForTool, type AgentToolContext } from '@/lib/accounting/agent-tools'
import { idempotencyKeyOf, runAgentTool } from '@/lib/agent/dispatch'
import { CALL_TOOL, closeMatches, isGatewayTool, searchTools, SEARCH_TOOLS } from './gateway'
import { authorizeMcpTool, getMcpTool, isPendingTool, toolResult } from './server'
import { activeFund, LIST_FUNDS, matchFund, setActiveFund, USE_FUND } from '@/lib/agent/master-admin'

export type McpCallContext = Omit<AgentToolContext, 'portfolioGroup'>

export interface McpCall {
  name: unknown
  args: Record<string, unknown>
  /** The request's `params._meta`: carries `idempotencyKey` for a write. */
  meta?: Record<string, unknown>
  ctx: McpCallContext
  auth: ResolvedKey
  access: AccessContext
}

/** A tool result, or a JSON-RPC error for a call naming no tool at all. */
export type McpCallOutcome = { result: unknown } | { error: { code: number; message: string } }

const refusal = (text: string) => ({ result: { content: [{ type: 'text', text }], isError: true } })

export async function callMcpTool(call: McpCall): Promise<McpCallOutcome> {
  if (!call.auth.pool) return callOne(call)
  if (call.name === LIST_FUNDS || call.name === USE_FUND) return callMasterAdminTool(call)
  // Pooled: every result says which fund it came from, so a model working across funds can't lose
  // track of where it is, and neither can the person reading along.
  const outcome = await callOne(call)
  if ('result' in outcome) {
    const r = outcome.result as { content?: unknown[] }
    if (Array.isArray(r?.content)) {
      return { result: { ...r, content: [{ type: 'text', text: `Fund: ${activeFund(call.auth.pool).fundName}` }, ...r.content] } }
    }
  }
  return outcome
}

/**
 * list_funds / use_fund, for a connection in a master admin pool (lib/agent/master-admin.ts).
 * Switching only moves which pool fund later calls resolve to (api-keys.ts resolveAgentAuth); the
 * fund's own switch for agent access and the acting admin's grants still apply there.
 */
async function callMasterAdminTool(call: McpCall): Promise<McpCallOutcome> {
  const pool = call.auth.pool!
  const text = (t: string) => ({ result: { content: [{ type: 'text', text: t }] } })
  if (call.name === LIST_FUNDS) {
    return text(JSON.stringify({
      active: activeFund(pool).fundName,
      funds: pool.funds.map(f => ({ name: f.fundName, id: f.fundId, actingAs: f.email, active: f.fundId === pool.activeFundId })),
    }))
  }
  const target = matchFund(pool, call.args.fund)
  if (typeof target === 'string') return refusal(target)
  await setActiveFund(call.ctx.admin, pool, target.fundId)
  return text(`Now working in ${target.fundName}, acting as ${target.email}. Every tool call from here on reads and writes ${target.fundName}.`)
}

async function callOne(call: McpCall): Promise<McpCallOutcome> {
  const { name, args, meta, ctx, auth, access } = call
  if (name === SEARCH_TOOLS) return { result: { content: [{ type: 'text', text: JSON.stringify(searchTools(args, auth, access)) }] } }
  if (name === CALL_TOOL) return callThroughGateway(call)

  const tool = getMcpTool(name)
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } }
  const denied = authorizeMcpTool(tool, auth, access, args)
  if (denied) return refusal(denied)
  try {
    // Approval tools: authorized per action by the pending-actions service.
    if (isPendingTool(tool)) return { result: toolResult(tool, await tool.run({ admin: ctx.admin, auth, access, origin: ctx.origin }, args)) }
    // The shared registry goes through the one dispatcher, which stages, audits and dedupes
    // writes (lib/agent/dispatch.ts). A retry may name its call with _meta.idempotencyKey.
    const agentTool = getTool(tool.name)
    if (agentTool) {
      const result = await runAgentTool({
        admin: ctx.admin, tool: agentTool, input: args, auth, access, channel: 'mcp', origin: ctx.origin,
        idempotencyKey: idempotencyKeyOf(meta?.idempotencyKey),
      })
      return { result: toolResult(tool, result) }
    }
    const portfolioGroup = await resolveVehicleForTool(tool, ctx.admin, ctx.fundId, args.vehicle as string | undefined, access)
    return { result: toolResult(tool, await tool.handler({ ...ctx, portfolioGroup }, args)) }
  } catch (e) {
    return refusal((e as Error).message)
  }
}

/**
 * `call_tool { name, arguments }`: the named tool, through the path above with nothing skipped.
 * The request's `_meta` passes through, so an idempotency key still dedupes the write.
 */
async function callThroughGateway(call: McpCall): Promise<McpCallOutcome> {
  const target = call.args?.name
  if (typeof target !== 'string' || !target) return refusal('call_tool needs "name": the tool to run.')
  if (isGatewayTool(target)) return refusal(`Call ${target} directly, not through call_tool.`)
  if (call.auth.pool && (target === LIST_FUNDS || target === USE_FUND)) {
    return callMasterAdminTool({ ...call, name: target, args: (call.args.arguments ?? {}) as Record<string, unknown> })
  }
  const raw = call.args.arguments ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return refusal('call_tool "arguments" must be an object.')

  // An unknown name is an error the model can act on, not a protocol error: say what is close.
  // A tool that exists but is not this caller's is refused by authorizeMcpTool below, word for
  // word as a direct call is.
  if (!getMcpTool(target)) {
    const close = closeMatches(target, call.access)
    return refusal(
      `Unknown tool: ${target}.` +
      (close.length ? ` Did you mean: ${close.join(', ')}?` : '') +
      ' search_tools lists the tools you may use.'
    )
  }
  return callMcpTool({ ...call, name: target, args: raw as Record<string, unknown> })
}
