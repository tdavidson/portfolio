import type { SupabaseClient } from '@supabase/supabase-js'
import { bearerToken } from '@/lib/accounting/api-keys'
import { loadAccessContext } from '@/lib/access/effective'
import type { AnalystPrincipal } from '@/lib/ai/analyst/types'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { resolveAccessToken } from '@/lib/oauth/store'

export interface V1Principal extends AnalystPrincipal {
  clientId: string
  scopes: string[]
}

export class V1PrincipalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

/** OAuth is the only credential accepted at the native/external v1 boundary. */
export async function resolveV1Principal(
  admin: SupabaseClient,
  req: Request,
): Promise<V1Principal> {
  const token = bearerToken(req)
  if (!token?.startsWith('mcp_at_')) {
    throw new V1PrincipalError('A valid OAuth access token is required.', 401, 'INVALID_TOKEN')
  }

  // SEC-009: the native boundary, not the MCP one. A token a client obtained for the advertised
  // MCP resource used to authenticate here just as well; conversations and pending-action
  // approvals live behind this one, so the two are not interchangeable.
  const resolved = await resolveAccessToken(admin, token, 'v1')
  if (!resolved) {
    throw new V1PrincipalError('A valid OAuth access token is required.', 401, 'INVALID_TOKEN')
  }

  const { data: membership, error } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('fund_id', resolved.fundId)
    .eq('user_id', resolved.userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!membership) {
    throw new V1PrincipalError('A valid OAuth access token is required.', 401, 'INVALID_TOKEN')
  }

  if (!(await agentApiEnabled(admin, resolved.fundId))) {
    throw new V1PrincipalError('External application access is disabled for this fund.', 403, 'EXTERNAL_ACCESS_DISABLED')
  }

  const scopes = resolved.scope.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
  if (!scopes.includes('read')) {
    throw new V1PrincipalError('A valid OAuth access token is required.', 401, 'INVALID_TOKEN')
  }

  const access = await loadAccessContext(admin, resolved.fundId, resolved.userId, membership.role)
  return {
    userId: resolved.userId,
    fundId: resolved.fundId,
    role: membership.role,
    access,
    // Server-set, from the credential that was actually presented. Phase 8's demo exchange will
    // mint 'demo' here; nothing a client sends can reach this field.
    credentialKind: 'oauth',
    clientId: resolved.clientId,
    // `v1:`, not the `oauth:` the MCP door uses: a chat may approve its own change (it acts on its
    // person's yes in the conversation), but a program calling /api/v1 has no conversation, so it is
    // refused like a script's key (selfApprovalRefused in lib/pending-actions/service.ts). The
    // service still counts `v1:<client>` and `oauth:<client>` as one credential, so a change staged
    // over MCP cannot be self-approved over /api/v1 either.
    credentialId: `v1:${resolved.clientId}`,
    scopes,
  }
}

export function requireV1Write(principal: V1Principal): void {
  if (!principal.scopes.includes('write')) {
    throw new V1PrincipalError('This OAuth credential is read-only.', 403, 'WRITE_SCOPE_REQUIRED')
  }
}

