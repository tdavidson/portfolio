import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/crypto'
import { getOrCreateFundDek, getFundDek } from '@/lib/credentials/fund-dek'
import type { McpServerConfig } from '@/lib/ai/types'
import { getMcpServer } from './servers'
import { refreshTokens, McpOAuthError, type FetchLike, type TokenSet } from './oauth'
import { isReadOnlyTool, listMcpTools } from './tools'

/**
 * A member's own connection to an outside MCP server (table `mcp_connections`).
 *
 * Connections are PER USER, like Affinity keys: the outside service decides what that person may
 * see, and the assistant reaches it only with the asking member's own token.
 */

/** Refresh a little before expiry, so a token can't lapse between here and Anthropic's call. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000
/** How long a tool list is trusted before it is read again. */
const TOOLS_TTL_MS = 24 * 60 * 60 * 1000

export interface McpConnectionStatus {
  /** Whether an admin has turned this server on for the fund. */
  enabled: boolean
  connected: boolean
  readTools: number
  lastError: string | null
  connectedAt: string | null
  lastUsedAt: string | null
}

interface Row {
  id: string
  fund_id: string
  client_id: string
  client_secret_encrypted: string | null
  token_endpoint: string
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  expires_at: string | null
  read_tools: string[] | null
  tools_checked_at: string | null
  last_error: string | null
  created_at: string
  last_used_at: string | null
}

const ROW_COLUMNS = 'id, fund_id, client_id, client_secret_encrypted, token_endpoint, access_token_encrypted, refresh_token_encrypted, expires_at, read_tools, tools_checked_at, last_error, created_at, last_used_at'

/** Whether an admin has turned this server on for the fund (fund_settings.mcp_servers_enabled). */
export async function isMcpServerEnabled(admin: SupabaseClient, fundId: string, serverId: string): Promise<boolean> {
  const { data } = await (admin as any)
    .from('fund_settings')
    .select('mcp_servers_enabled')
    .eq('fund_id', fundId)
    .maybeSingle()
  const list = (data as any)?.mcp_servers_enabled
  return Array.isArray(list) && list.includes(serverId)
}

/** Turn a server on or off for the fund. Members' connections are kept, just unused while off. */
export async function setMcpServerEnabled(admin: SupabaseClient, fundId: string, serverId: string, enabled: boolean): Promise<void> {
  const { data } = await (admin as any)
    .from('fund_settings')
    .select('mcp_servers_enabled')
    .eq('fund_id', fundId)
    .maybeSingle()
  const current: string[] = Array.isArray((data as any)?.mcp_servers_enabled) ? (data as any).mcp_servers_enabled : []
  const next = enabled ? [...new Set([...current, serverId])] : current.filter(id => id !== serverId)
  const { error } = await (admin as any).from('fund_settings').update({ mcp_servers_enabled: next.sort() }).eq('fund_id', fundId)
  if (error) throw new Error(`Failed to save the setting: ${error.message}`)
}

async function loadRow(admin: SupabaseClient, userId: string, serverId: string): Promise<Row | null> {
  const { data } = await (admin as any)
    .from('mcp_connections')
    .select(ROW_COLUMNS)
    .eq('user_id', userId)
    .eq('server_id', serverId)
    .maybeSingle()
  return (data as Row | null) ?? null
}

/** The read-only tool names from a server's list. */
export async function readOnlyToolNames(url: string, accessToken: string, fetchImpl?: FetchLike): Promise<string[]> {
  const tools = await listMcpTools(url, accessToken, fetchImpl)
  return tools.filter(isReadOnlyTool).map(t => t.name).sort()
}

/** Store (or replace) a member's connection after a completed sign-in. */
export async function saveMcpConnection(admin: SupabaseClient, input: {
  userId: string
  fundId: string
  serverId: string
  clientId: string
  clientSecret: string | null
  tokenEndpoint: string
  tokens: TokenSet
  readTools: string[]
}): Promise<void> {
  const dek = await getOrCreateFundDek(admin, input.fundId)
  const now = new Date().toISOString()
  const { error } = await (admin as any)
    .from('mcp_connections')
    .upsert({
      user_id: input.userId,
      fund_id: input.fundId,
      server_id: input.serverId,
      client_id: input.clientId,
      client_secret_encrypted: input.clientSecret ? encrypt(input.clientSecret, dek) : null,
      token_endpoint: input.tokenEndpoint,
      access_token_encrypted: encrypt(input.tokens.accessToken, dek),
      refresh_token_encrypted: input.tokens.refreshToken ? encrypt(input.tokens.refreshToken, dek) : null,
      expires_at: input.tokens.expiresAt ? new Date(input.tokens.expiresAt).toISOString() : null,
      scope: input.tokens.scope,
      read_tools: input.readTools,
      tools_checked_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    }, { onConflict: 'user_id,server_id' })
  if (error) throw new Error(`Failed to save the connection: ${error.message}`)
}

export async function getMcpConnectionStatus(admin: SupabaseClient, fundId: string, userId: string, serverId: string): Promise<McpConnectionStatus> {
  const [enabled, row] = await Promise.all([isMcpServerEnabled(admin, fundId, serverId), loadRow(admin, userId, serverId)])
  return {
    enabled,
    connected: !!row,
    readTools: row?.read_tools?.length ?? 0,
    lastError: row?.last_error ?? null,
    connectedAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
  }
}

export async function deleteMcpConnection(admin: SupabaseClient, userId: string, serverId: string): Promise<void> {
  await (admin as any).from('mcp_connections').delete().eq('user_id', userId).eq('server_id', serverId)
}

async function markError(admin: SupabaseClient, rowId: string, message: string): Promise<void> {
  await (admin as any)
    .from('mcp_connections')
    .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq('id', rowId)
}

/**
 * The member's server config for a tool loop, with a fresh token and the read-only tool list.
 * Null when the server is off for the fund, they haven't connected, the token can't be refreshed, or the server has no read-only
 * tools: callers treat that as "not available for this member", not as an error.
 */
export async function getMcpServerForUser(
  admin: SupabaseClient,
  userId: string,
  serverId: string,
  opts: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<McpServerConfig | null> {
  const server = getMcpServer(serverId)
  if (!server) return null
  const row = await loadRow(admin, userId, serverId)
  if (!row) return null
  // Off for the fund means off for everyone, whatever they connected.
  if (!(await isMcpServerEnabled(admin, row.fund_id, serverId))) return null
  const dek = await getFundDek(admin, row.fund_id)
  if (!dek) return null

  const now = opts.now ?? Date.now()
  let accessToken: string
  let refreshToken: string | null
  let clientSecret: string | null
  try {
    accessToken = decrypt(row.access_token_encrypted, dek)
    refreshToken = row.refresh_token_encrypted ? decrypt(row.refresh_token_encrypted, dek) : null
    clientSecret = row.client_secret_encrypted ? decrypt(row.client_secret_encrypted, dek) : null
  } catch {
    // Encrypted under a DEK we can no longer reproduce. Treat as disconnected.
    return null
  }

  const updates: Record<string, unknown> = {}
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null
  if (expiresAt !== null && expiresAt - REFRESH_MARGIN_MS <= now) {
    if (!refreshToken) {
      await markError(admin, row.id, 'Your sign-in expired. Reconnect to keep using it.')
      return null
    }
    try {
      const tokens = await refreshTokens({
        tokenEndpoint: row.token_endpoint,
        client: { clientId: row.client_id, clientSecret },
        refreshToken,
        resource: server.url,
        fetchImpl: opts.fetchImpl,
        now,
      })
      accessToken = tokens.accessToken
      updates.access_token_encrypted = encrypt(tokens.accessToken, dek)
      updates.refresh_token_encrypted = tokens.refreshToken ? encrypt(tokens.refreshToken, dek) : null
      updates.expires_at = tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null
    } catch (err) {
      // Two requests can race to refresh a rotating token; the loser's refresh token is already
      // spent. If the winner saved a fresh token meanwhile, use that one.
      const latest = await loadRow(admin, userId, serverId)
      const latestExpiry = latest?.expires_at ? Date.parse(latest.expires_at) : null
      if (latest && latest.access_token_encrypted !== row.access_token_encrypted && (latestExpiry === null || latestExpiry - REFRESH_MARGIN_MS > now)) {
        try { accessToken = decrypt(latest.access_token_encrypted, dek) } catch { return null }
      } else {
        const reason = err instanceof McpOAuthError && err.code === 'invalid_grant'
          ? 'Your sign-in was revoked or expired. Reconnect to keep using it.'
          : 'Could not refresh your sign-in. Reconnect if this keeps happening.'
        await markError(admin, row.id, reason)
        return null
      }
    }
  }

  let readTools = row.read_tools ?? []
  const checkedAt = row.tools_checked_at ? Date.parse(row.tools_checked_at) : 0
  if (now - checkedAt > TOOLS_TTL_MS) {
    try {
      readTools = await readOnlyToolNames(server.url, accessToken, opts.fetchImpl)
      updates.read_tools = readTools
      updates.tools_checked_at = new Date(now).toISOString()
    } catch {
      // Keep the list we have; a slow or flaky tools/list mustn't take the assistant down.
    }
  }

  updates.last_used_at = new Date(now).toISOString()
  updates.last_error = null
  updates.updated_at = new Date(now).toISOString()
  await (admin as any).from('mcp_connections').update(updates).eq('id', row.id)

  if (readTools.length === 0) return null
  return { name: server.id, url: server.url, authorizationToken: accessToken, allowedTools: readTools }
}
