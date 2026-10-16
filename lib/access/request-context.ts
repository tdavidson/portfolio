import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAccessContext, type AccessContext } from './effective'

const requestAccess = Symbol('requestAccess')
type Gate = { fundId: string; userId: string; role: string; [requestAccess]?: { promise?: Promise<AccessContext> } }

/** Only HTTP gates created for one request opt into reuse. Plain contexts (including callers
 * outside HTTP) stay fresh on each call; they may legitimately outlive a single request. */
export function withRequestAccess<T extends Gate>(gate: T): T {
  Object.defineProperty(gate, requestAccess, { value: {} })
  return gate
}

/** Reuse access only on the server-created gate object for THIS request. Never persist a gate
 * or reuse it for another request. The proxy retains its independent check; a new request gets
 * a new gate and a fresh context, including revoked grants. Rejections remain fail-closed. */
export function loadGateAccess(admin: SupabaseClient, gate: Gate): Promise<AccessContext> {
  const cache = gate[requestAccess]
  if (!cache) return loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return cache.promise ??= loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
}
