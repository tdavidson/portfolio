import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { outcomeResponse } from '@/lib/service-outcome'
import {
  inviteInputFrom, inviteLp, listPortalAccounts, setPortalAccountStatus, unlinkPortalAccount,
} from '@/lib/lps/portal-access'

/**
 * Admin-only LP invites and portal accounts.
 *
 *   GET  → every LP account linked to an investor in this fund: who is invited, active or
 *          disabled, when they last signed in, and when they were last emailed an invite.
 *   POST { lp_investor_id, email, display_name? }
 *        → create (or reuse) an lp_account for the email, link it to the investor, and email the
 *          invite. The response says whether an email actually went out (`emailed`) and why not
 *          when it didn't — an invite that silently failed used to read as "Invited".
 *   PATCH { lp_account_id, status: 'active' | 'disabled' }
 *        → disable an LP (they and their authorized users lose the portal at the next request;
 *          they stop receiving LP emails) or re-enable one.
 *   DELETE ?id=<lp_account_links.id> → unlink an account from an investor.
 *
 * Writes go through the service-role admin client with manual fund scoping; the lp_investor is
 * verified to belong to the admin's fund before any linking. The logic lives in
 * lib/lps/portal-access.ts, shared with the lp_portal_* agent tools.
 */

type AdminCtx =
  | { error: NextResponse; admin?: undefined; user?: undefined; fundId?: undefined }
  | { error?: undefined; admin: ReturnType<typeof createAdminClient>; user: { id: string }; fundId: string }

async function adminCtx(): Promise<AdminCtx> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  if (writeCheck.role !== 'admin') return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  return { admin, user, fundId: writeCheck.fundId as string }
}

export async function GET(): Promise<NextResponse> {
  const ctx = await adminCtx()
  if (ctx.error) return ctx.error
  return outcomeResponse(await listPortalAccounts(ctx.admin, ctx.fundId), invites => ({ invites }))
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await adminCtx()
  if (ctx.error) return ctx.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await inviteLp(ctx.admin, { fundId: ctx.fundId, userId: ctx.user.id }, inviteInputFrom(body)))
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const ctx = await adminCtx()
  if (ctx.error) return ctx.error
  const body = await req.json().catch(() => ({}))
  const lpAccountId = typeof body.lp_account_id === 'string' ? body.lp_account_id : ''
  return outcomeResponse(await setPortalAccountStatus(ctx.admin, ctx.fundId, lpAccountId, body.status))
}

// DELETE ?id=<lp_account_links.id> → revoke a direct LP-investor link for this fund.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ctx = await adminCtx()
  if (ctx.error) return ctx.error
  const id = new URL(req.url).searchParams.get('id') ?? ''
  return outcomeResponse(await unlinkPortalAccount(ctx.admin, ctx.fundId, id))
}
