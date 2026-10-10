import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'

/**
 * A K-1 package structurally contains the carry.
 *
 * The K-1 routes are registered under `lp_capital` — correctly: their payload is per-partner
 * figures. But one of the partners is the GP entity, and the GP entity's K-1 IS the carried
 * interest by another name: `k1-load.ts` reads each partner's `carriedInterest` off the same
 * roll-forward that `capital-accounts` withholds from callers without `gp_economics`, the
 * allocation moves it onto the recipient's lines, and `section1061Recharacterized` (box 20AH) is
 * by definition the carry recipient's recharacterised gain. Serving that under `lp_capital` alone
 * would hand a member holding only the partner register the fund's carry economics — the exact
 * carve-out `gp_economics` exists to keep.
 *
 * Gated whole rather than redacted. `capital-accounts` drops one line for callers without the
 * grant and the row still reads; a K-1 package with the GP's row removed does not foot, and one
 * with box 20AH removed misstates the recipient's gain. "We tried gating those payloads field by
 * field. It doesn't hold" — DOMAIN_META.lp_capital says so about the ledger, and it is true of a
 * K-1 package for the same reason. So: preparing or reading K-1s requires being allowed to see
 * the carry, because K-1s contain it. Same shape as `/api/accounting/statements` gating the
 * partners' capital section in-handler (CLAUDE.md, "the registry maps ONE domain per route").
 *
 * Returns the 403 to send, or null to proceed.
 */
/**
 * May this caller read K-1s — per-partner figures (`lp_capital`) that contain the carry
 * (`gp_economics`)? The K-1 routes get the first from the registry and check the second in the
 * handler; a route registered under another domain (the tax package, under `accounting`) that
 * bundles a K-1 has to check both, or a member with the ledger and carry but not the partner
 * register reads every partner's K-1 through it.
 */
export async function canReadK1s(
  admin: SupabaseClient,
  gate: { fundId: string; role: string },
  userId: string,
): Promise<boolean> {
  const access = await loadAccessContext(admin, gate.fundId, userId, gate.role)
  return hasAccess(access, 'gp_economics', 'read') && hasAccess(access, 'lp_capital', 'read')
}

export async function refuseWithoutCarryAccess(
  admin: SupabaseClient,
  gate: { fundId: string; role: string },
  userId: string,
): Promise<NextResponse | null> {
  const access = await loadAccessContext(admin, gate.fundId, userId, gate.role)
  if (hasAccess(access, 'gp_economics', 'read')) return null
  return NextResponse.json(
    { error: 'K-1 packages include the carried-interest allocation, which requires GP economics access.' },
    { status: 403 },
  )
}
