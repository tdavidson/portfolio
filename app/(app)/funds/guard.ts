import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import type { FeatureKey } from '@/lib/types/features'
import { canSeeVehicle } from '@/lib/access/scope'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Server-side gate for the Entities section. The sidebar visibility flag is cosmetic — hidden
 * features are still reachable by URL — so every page in the section enforces access here.
 * Resolves the caller's fund or redirects away.
 *
 * It asks the ONE resolver, and that is the whole point. This used to admit `admin|viewer` by role
 * and never look at the `accounting` grant, which made the grant a lie in one direction: a fund
 * that set Fund accounting to "Members" and granted someone write watched every accounting API
 * serve them while every accounting PAGE redirected them to the dashboard. That is the exact
 * contradiction tests/route-gates-honour-grants.test.ts was written to end on the route side —
 * "a second, coarser, contradictory policy is not defence in depth."
 *
 * What the resolver answers, and why each case is right:
 *   - admin, accounting on   → write. Unchanged.
 *   - admin, accounting off  → NONE, and now redirected. Previously the pages rendered and every
 *                              API on them 403'd, because the middleware already resolved this way.
 *   - viewer (the read-only demo) → read, so the demo still SHOWS the books. Writes are refused
 *                              downstream by assertAdminAccess, which rejects viewer.
 *   - member with the grant  → admitted, which is what granting it meant.
 *   - member without         → redirected, as before.
 *
 * This is the gate for pages that are not about ONE entity — the landing, and the firm-wide
 * landing for each section. A page that names an entity uses `requireVehicleAccess` below, which
 * asks this question and then one more.
 */
export async function requireAccountingAccess(): Promise<{ fundId: string; role: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'accounting')) redirect('/dashboard')

  return { fundId: page.fundId, role: page.role }
}

/**
 * THE GATE FOR A PAGE ABOUT ONE ENTITY — which grant it needs is decided by the ENTITY, not by
 * the page.
 *
 * Every other page gate in this app answers "may this caller open this page?", and the answer is
 * the same whichever row the page then renders. The entity pages are the one place that isn't
 * true. A management company keeps its books in the same `journal_entries`, `journal_postings`
 * and `chart_of_accounts` rows as every fund, separated only by `vehicle_id`, so
 * `/funds/<the manco>/journal` is — to a gate that only reads the path — the same page as
 * `/funds/<Fund II>/journal`. One resolves `accounting`, sees a grant, and renders the firm's
 * payroll.
 *
 * So this is the page twin of `assertVehicleDomain` (lib/accounting/vehicle-domain.ts), and it is
 * deliberately the same shape: the check lives INSIDE the call every entity page already has to
 * make to find out which vehicle it is showing, so a new page under `/funds/[id]` cannot render
 * an entity without having asked. That is why it resolves the vehicle rather than taking one, and
 * why it returns the kind instead of a bare name.
 *
 * The rule, in full:
 *   - Any entity page needs `accounting`. These are the accounting views and they call
 *     `/api/accounting/*`, which the middleware gates on it; admitting someone without it would
 *     render a page whose every request 403s.
 *   - A management company needs `management_company` AS WELL. The conjunction errs safe:
 *     `accounting` alone can never reach a manco, which is the whole reason the domain was split.
 *
 * PAGE_DOMAINS records these pages as `accounting` because that is the minimum to open one —
 * the registry maps one domain per page, and the extra half of a page that straddles two is
 * gated here, in the page's own path. See lib/access/page-domains.ts.
 */
export async function requireVehicleAccess(
  rawParam: string,
  opts: { feature?: FeatureKey } = {},
): Promise<{ fundId: string; role: string; vehicle: string; vehicleId: string | null; kind: string | null; active: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth')

  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'accounting', opts.feature)) redirect('/dashboard')

  const resolved = await resolveVehicleParam(page.fundId, rawParam)

  // The firm's own operating entity. Its ledger carries salaries, which appear nowhere in a
  // fund's trial balance — so the grant that opens the funds' books does not open this one. Sent
  // back to the section they can see rather than off to the dashboard: they hold `accounting`,
  // so the entity list and every fund in it are theirs; it is this one entity that is not.
  if (isManagementCompany(resolved.kind) && !canViewPage(page, 'management_company')) redirect('/funds')

  // One of THEIR entities? An admin sees every entity; a member only those granted
  // (fund_member_vehicles). A legacy entity with no registry row cannot be granted, so only a caller
  // who sees everything reaches it. Sent to the entity list, which shows only theirs.
  if (!canSeeVehicle(page.access, resolved.vehicleId)) redirect('/funds')

  return { fundId: page.fundId, role: page.role, ...resolved }
}

/**
 * Resolve a `/funds/[id]` route param to an entity. `[id]` is normally the stable
 * `fund_vehicles` UUID; a legacy vehicle with no registry row is addressed by its name
 * directly (the ledger keys on the name either way). Returns the name the views scope on,
 * the id (null for legacy) the switcher/sidebar route on, and the kind the pages branch on.
 *
 * Not exported: resolving an entity and deciding whether the caller may have it are one step,
 * and `requireVehicleAccess` is that step. A caller who could resolve without checking would be
 * the hole this file exists to close.
 */
async function resolveVehicleParam(
  fundId: string,
  rawParam: string,
): Promise<{ vehicle: string; vehicleId: string | null; kind: string | null; active: boolean }> {
  const raw = decodeURIComponent(rawParam)
  // Legacy vehicles are addressed by NAME, and `fund_vehicles.id` is a uuid column — PostgREST
  // answers a non-uuid filter with an error rather than an empty result, so the shape is checked
  // before the query rather than the result after it.
  if (!UUID.test(raw)) return { vehicle: raw, vehicleId: null, kind: null, active: true }

  const { data: veh } = await (createAdminClient() as any)
    .from('fund_vehicles')
    .select('name, kind, active')
    .eq('fund_id', fundId)
    .eq('id', raw)
    .maybeSingle()

  if (veh) return { vehicle: veh.name as string, vehicleId: raw, kind: (veh.kind as string) ?? null, active: !!veh.active }

  // A uuid that is not a vehicle in this fund. Treated as a name, exactly as before — the detail
  // view reports "not found" for it, which is the right answer either way.
  return { vehicle: raw, vehicleId: null, kind: null, active: true }
}
