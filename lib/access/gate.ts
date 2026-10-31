// The API gate. One call at the top of a route replaces the hand-rolled
// `getUser → fund_members → (forget to check role)` sequence that ~100 routes grew.
//
// Deliberately trivial to call, because the reason those routes skipped the check was never
// intent — it was that resolving the fund took five lines and gating took thought. Here, gating
// IS the resolve: you cannot get the fundId without stating what you need.
//
// See plans/plan-access-control.md.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ROUTE_DOMAINS, UNGATED_ROUTES, requiredLevel, type RouteLevel } from './route-domains'
import { DOMAIN_META, type Domain } from './domains'
import { hasAccess, loadAccessContext, type AccessContext } from './effective'
import type { FeatureKey } from '@/lib/types/features'

export interface GateResult {
  fundId: string
  userId: string
  role: string
  /** Resolved once; thread it rather than re-resolving for a second check. */
  access: AccessContext
}

/**
 * Assert the caller may do `need` in `domain`, and hand back their fund.
 *
 * Returns a NextResponse to return as-is on denial — the same shape the existing helpers use, so
 * call sites read `if (gate instanceof NextResponse) return gate`.
 */
export async function assertDomainAccess(
  admin: SupabaseClient,
  userId: string,
  domain: Domain,
  need: 'read' | 'propose' | 'write' | 'any',
  feature?: FeatureKey,
): Promise<GateResult | NextResponse> {
  const { data: membership, error } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[assertDomainAccess] DB error:', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const access = await loadAccessContext(admin, membership.fund_id, userId, membership.role)
  const result: GateResult = {
    fundId: membership.fund_id,
    userId,
    role: membership.role,
    access,
  }

  // 'any' — membership is the whole test. For a route serving the caller their own data, or one
  // that gates per domain internally.
  if (need === 'any') return result

  if (!hasAccess(access, domain, need, feature)) return denied(access, domain, need)
  return result
}

/**
 * The same gate, resolved from the registry by route key ('api/deals/[id]') and HTTP method — so
 * a route states its identity once and the required level follows from ROUTE_DOMAINS.
 */
export async function assertRouteAccess(
  admin: SupabaseClient,
  userId: string,
  routeKey: string,
  method: string,
): Promise<GateResult | NextResponse> {
  const entry = ROUTE_DOMAINS[routeKey]
  if (!entry) {
    // Unreachable in a passing build — route-domains.test.ts fails when a route is unmapped. If it
    // happens anyway, deny: an unmapped route is an unanswered question, not an open door.
    if (!(routeKey in UNGATED_ROUTES)) {
      console.error(`[assertRouteAccess] no access decision for ${routeKey} — denying`)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const level: RouteLevel = requiredLevel(entry, method)
  return assertDomainAccess(admin, userId, entry.domain, level, entry.feature)
}

/**
 * Why they were denied, in terms they can act on — without disclosing whether the fund even has
 * the area. A member told "GP economics is admin-only" learns the fund has GP economics; a member
 * told "not available" learns nothing. The distinction only matters for areas they can't see, so
 * the message stays coarse and the log carries the detail.
 */
function denied(access: AccessContext, domain: Domain, need: 'read' | 'propose' | 'write'): NextResponse {
  if (access.role === 'viewer' && need !== 'read') {
    return NextResponse.json(
      { error: 'This is a read-only demo. Changes are not allowed.' },
      { status: 403 },
    )
  }
  const label = DOMAIN_META[domain].label
  return NextResponse.json(
    { error: need !== 'read' ? `You do not have write access to ${label}.` : `You do not have access to ${label}.` },
    { status: 403 },
  )
}
