// Pulling an admin-reported vehicle's figures from its fund administrator's MCP server.
//
// Any fund administrator can be one: the deployment lists their servers (FUND_ADMIN_MCP_SERVERS,
// lib/mcp-client/servers.ts), each member connects their own account, and a vehicle names the server
// its figures come from. Every pull runs with the ASKING member's own connection, so nobody reads
// what they couldn't open at the administrator themselves.
//
// Administrators' servers don't share one set of tools, so the app's own pull (the in-app button)
// needs an adapter that knows a server's tools: Carta's is built in. For a server without one, the
// assistant does the pull: it reads the administrator with that server's own tools, in the member's
// own chat, and passes the figures to stage_admin_figures. Either way the figures arrive in the same
// shape and get the same checks.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { McpServerConfig } from '@/lib/ai/types'
import { getMcpServerForUser } from '@/lib/mcp-client/connections'
import { getMcpServer, type McpServerDefinition } from '@/lib/mcp-client/servers'
import type { FetchLike } from '@/lib/mcp-client/oauth'
import { cartaAdapter } from './carta'

export type AdminPullResult =
  | { ok: true; input: unknown; raw: unknown }
  | { ok: false; error: string }

export interface AdminPullAdapter {
  /** Who the figures come from, as a reader would name it. */
  name: string
  /** What the vehicle's fund reference is at this administrator, for the setup form. */
  fundRefHint: string
  /** What's wrong with a fund reference, or null when it will do. */
  checkFundRef: (ref: string) => string | null
  pull: (conn: McpServerConfig, fundRef: string, asOf: string, opts?: { fetchImpl?: FetchLike }) => Promise<AdminPullResult>
}

/** The built-in pulls, by the `adapter` a configured server names. */
export const ADMIN_PULL_ADAPTERS: Record<string, AdminPullAdapter> = {
  carta: cartaAdapter,
}

/** The manual sources: figures a person or an assistant gives, with no server behind them. */
export const MANUAL_SOURCES = ['csv', 'other'] as const

export function adapterFor(server: McpServerDefinition | null): AdminPullAdapter | null {
  return server?.adapter ? ADMIN_PULL_ADAPTERS[server.adapter] ?? null : null
}

/** A fund administrator's server by id, or null when the id isn't one this deployment lists. */
export function fundAdminServer(id: string | null | undefined): McpServerDefinition | null {
  const server = id ? getMcpServer(id) : null
  return server?.kind === 'fund_admin' ? server : null
}

export type AdminPull =
  | AdminPullResult
  /** The administrator has a server but no built-in pull: the assistant pulls it, or a CSV is uploaded. */
  | { ok: false; error: string; viaAssistant: true; serverName: string }

/** Pull one date's figures from the vehicle's administrator with this member's own connection. */
export async function pullFromAdmin(
  admin: SupabaseClient, userId: string, provider: string | null, fundRef: string | null, asOf: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AdminPull> {
  const server = fundAdminServer(provider)
  if (!server) return { ok: false, error: "This vehicle's administrator has no MCP server here. Upload its CSV instead." }
  const adapter = adapterFor(server)
  if (!adapter) {
    return {
      ok: false, viaAssistant: true, serverName: server.name,
      error: `The app has no built-in pull for ${server.name}. Ask the assistant to pull it (it reads ${server.name} with your own connection and stages the figures), or upload a CSV.`,
    }
  }
  const refProblem = adapter.checkFundRef(fundRef ?? '')
  if (refProblem) return { ok: false, error: refProblem }
  const conn = await getMcpServerForUser(admin, userId, server.id, opts)
  if (!conn) return { ok: false, error: `Connect your ${server.name} account in Settings → Connectors first (an admin turns ${server.name} on for the fund).` }
  const pulled = await adapter.pull(conn, fundRef as string, asOf, opts)
  if (!pulled.ok) return pulled
  return { ok: true, input: { ...(pulled.input as object), source: server.name }, raw: pulled.raw }
}
