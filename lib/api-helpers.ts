import { withRequestAccess } from '@/lib/access/request-context'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VehicleGate } from '@/lib/accounting/vehicle-domain'

/**
 * What every gate helper here hands back: the caller's tenant, their role, WHO they are, and the
 * level the route asked for by choosing this helper rather than another.
 *
 * The last two fields exist for one reason. Fund accounting is the only area where the grant a
 * request needs depends on the ROW rather than the route — a management company's ledger sits in
 * the same tables as a fund's — so `resolveGroupOr400` has to re-resolve access once it knows
 * which vehicle is being served, and it can only do that if the gate told it who is asking and how
 * much they asked for. Carrying both on the gate means no call site has to remember to pass them,
 * and no future route can quietly get it wrong. See lib/accounting/vehicle-domain.ts.
 */
export type FundGate = VehicleGate

/**
 * Resolve the caller's fund WITHOUT any role gate — the single-fund-per-user lookup that ~100
 * routes currently hand-roll inline as `getUser → fund_members.select('fund_id')`. Use this
 * instead of copying that sequence: it keeps the tenancy resolution (the security boundary in
 * this app) in one place, and never leaks a DB error to the client. Add an explicit role check
 * after it when the route needs one, or prefer assertReadAccess / assertWriteAccess / assertAdminAccess.
 */
export async function resolveFund(
  admin: SupabaseClient,
  userId: string
): Promise<FundGate | NextResponse> {
  const { data: membership, error } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.error('[resolveFund] DB error:', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  return withRequestAccess<FundGate>({ fundId: membership.fund_id, role: membership.role, userId, need: 'read' })
}

/**
 * Resolve the caller's fund for a WRITE, refusing the read-only demo.
 *
 * The viewer block is the one role rule that survives in-route, because it isn't a stand-in for
 * anything: the demo fund must never be mutated, whatever grants it holds. `effectiveAccess` caps
 * a viewer at `read` for the same reason, so the middleware refuses these too — this is the cheap
 * belt to that braces.
 *
 * WHAT this caller may write is decided by their per-domain grant at the boundary, not here.
 */
export async function assertWriteAccess(
  admin: SupabaseClient,
  userId: string
): Promise<FundGate | NextResponse> {
  const { data: membership, error } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[assertWriteAccess] DB error:', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  if (!membership)
    return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  if (membership.role === 'viewer')
    return NextResponse.json(
      { error: 'This is a read-only demo. Changes are not allowed.' },
      { status: 403 }
    )

  return withRequestAccess<FundGate>({ fundId: membership.fund_id, role: membership.role, userId, need: 'write' })
}

/**
 * Resolve the caller's fund for a READ. No role gate — the domain gate is the policy.
 *
 * IT USED TO BLOCK PLAIN MEMBERS (admin|viewer only). That check was a stand-in for "accounting is
 * admin-only", written when there was no way to say so properly. There is now: the fund-level
 * feature switch plus the caller's per-domain grant, resolved in one place
 * (lib/access/effective.ts) and enforced on EVERY /api request by the middleware — which knows
 * this route's domain, as this helper never could.
 *
 * Keeping the old check made nothing safer; it made the grants a LIE. An admin could set Fund
 * accounting to "Members", grant someone read, and watch every route 403 them anyway — while that
 * same person read the books through the Analyst and MCP, which had already moved to the real
 * resolver. A second, coarser, contradictory policy is not defence in depth. It is a bug that
 * only ever fires on the people you meant to let in.
 *
 * Retired only AFTER the domain gate's own leaks were closed — see plans/plan-access-control.md →
 * Sequencing. Ordering mattered: removing this while the replacement still leaked would have left
 * a window where neither policy was correct.
 */
export async function assertReadAccess(
  admin: SupabaseClient,
  userId: string
): Promise<FundGate | NextResponse> {
  return resolveFund(admin, userId)
}

/**
 * Admin-only gate. Resolves the caller's fund and requires the `admin` role.
 *
 * FOR THE `admin` DOMAIN ONLY — settings, keys, members, integrations. Everywhere else the
 * question "may this person do this?" is answered by their grant in the route's domain, not by
 * their role, and using this helper there would veto the grant (see {@link assertReadAccess}).
 * If you're reaching for this on an accounting/LP/diligence route, you want
 * {@link assertWriteAccess} — the middleware has already checked the domain.
 */
export async function assertAdminAccess(
  admin: SupabaseClient,
  userId: string
): Promise<FundGate | NextResponse> {
  const { data: membership, error } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[assertAdminAccess] DB error:', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  if (membership.role !== 'admin')
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  return withRequestAccess<FundGate>({ fundId: membership.fund_id, role: membership.role, userId, need: 'write' })
}

/**
 * LP-side mirror of {@link assertWriteAccess}, for /portal API routes.
 *
 * Resolves the caller's active LP account and the set of lp_investor_ids they
 * may see — direct links plus links delegated to them as an authorized user —
 * or a 403 if they have no active LP access. NEVER consults `fund_members`; the
 * GP and LP access graphs are kept strictly separate so a GP membership can
 * never widen LP visibility (and vice-versa). Portal routes must scope every
 * query to the returned `investorIds`.
 */
export async function resolveLpAccess(
  admin: SupabaseClient,
  userId: string
): Promise<{ lpAccountId: string; investorIds: string[] } | NextResponse> {
  const { data: account, error } = await admin
    .from('lp_accounts')
    .select('id, status')
    .eq('auth_user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[resolveLpAccess] DB error:', error.message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!account || account.status !== 'active') {
    return NextResponse.json({ error: 'No LP access' }, { status: 403 })
  }

  const [{ data: links }, { data: delegated }] = await Promise.all([
    admin.from('lp_account_links').select('lp_investor_id').eq('lp_account_id', account.id),
    // Embed the principal account's status: a delegation grants access only
    // while the principal LP it acts for is still active. Disabling the LP must
    // also cut their authorized users.
    admin
      .from('lp_authorized_users')
      .select('lp_investor_id, lp_accounts!lp_authorized_users_principal_lp_account_id_fkey(status)')
      .eq('authorized_user_account_id', account.id),
  ])

  const investorIds = Array.from(new Set([
    ...((links ?? []) as { lp_investor_id: string }[]).map(l => l.lp_investor_id),
    ...((delegated ?? []) as any[])
      .filter(d => d.lp_accounts?.status === 'active')
      .map(d => d.lp_investor_id as string),
  ]))

  return { lpAccountId: account.id as string, investorIds }
}
