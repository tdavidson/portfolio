import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { outcomeResponse } from '@/lib/service-outcome'
import {
  addAuthorizedUser, fundInvestorIds as loadFundInvestorIds, inviteInputFrom, listAuthorizedUsers, removeAuthorizedUser,
} from '@/lib/lps/portal-access'

/**
 * Admin-only authorized-user management (Phase 4 of LP reporting).
 *
 * An authorized user (e.g. an LP's advisor) gets delegated, read-only portal
 * access to a specific investor's data, acting for that investor's primary LP.
 * resolveLpAccess() and get_my_lp_investor_ids() already union the delegated
 * path, so creating the lp_authorized_users row is all that's needed for access.
 *
 *   GET    → authorized users across this fund's investors.
 *   POST   { lp_investor_id, email, display_name? } → grant + invite.
 *   DELETE ?id=... → revoke a delegation row.
 *
 * The logic lives in lib/lps/portal-access.ts, shared with the lp_authorized_user* agent tools.
 */

async function adminCtx() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  if (writeCheck.role !== 'admin') return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }

  // The fund's investor ids scope every authorized-user query (the delegation
  // table has no fund_id; investors are the tenant boundary).
  const fundInvestorIds = await loadFundInvestorIds(admin, writeCheck.fundId)
  return { admin, user, fundId: writeCheck.fundId as string, fundInvestorIds }
}

export async function GET() {
  const ctx = await adminCtx()
  if ('error' in ctx) return ctx.error
  return outcomeResponse(await listAuthorizedUsers(ctx.admin, ctx.fundId, ctx.fundInvestorIds), rows => ({ authorized_users: rows }))
}

export async function POST(req: NextRequest) {
  const ctx = await adminCtx()
  if ('error' in ctx) return ctx.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await addAuthorizedUser(ctx.admin, { fundId: ctx.fundId, userId: ctx.user.id }, inviteInputFrom(body), ctx.fundInvestorIds))
}

export async function DELETE(req: NextRequest) {
  const ctx = await adminCtx()
  if ('error' in ctx) return ctx.error
  const id = new URL(req.url).searchParams.get('id') ?? ''
  return outcomeResponse(await removeAuthorizedUser(ctx.admin, ctx.fundId, id, ctx.fundInvestorIds))
}
