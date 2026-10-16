import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { LpCapitalView } from './view'
import { createAdminClient } from '@/lib/supabase/admin'
import { listVehiclesWithId } from '@/lib/accounting/load'
import { canSeeVehicle } from '@/lib/access/scope'

export const metadata: Metadata = { title: 'LP capital accounts' }

/**
 * LP capital accounts, in the LPs section — the canonical home for them.
 *
 * Gated on `lp_tracking`, NOT on accounting: this works whether or not the fund keeps books.
 * (`lp_tracking` is a feature-visibility domain, not the retired entity-wide accounting mode.)
 * The accounts are resolved per partner and date from whatever evidence supports them — posted
 * postings, or the pasted / manually-entered dated positions edited on this same page, or both
 * with the overlap excluded. Either way it is the same capital-account statement; a vehicle with
 * only reported observations simply has fewer lines behind each figure.
 */
export default async function LpCapitalPage() {
  const user = await getUser()
  if (!user) redirect('/auth')

  // Both axes, resolved by the same function the APIs on this page go through: the fund's
  // lp_tracking switch, and this user's lp_capital grant. Checking only the switch would render
  // a page whose every request 403s.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'lp_capital', 'lp_tracking')) redirect('/dashboard')

  // Resolve the picker before hydration, using this request's already-checked access. The
  // browser can start loading capital immediately instead of waiting for another gated API.
  const vehicles = (await listVehiclesWithId(createAdminClient(), page.fundId))
    .filter(vehicle => canSeeVehicle(page.access, vehicle.id))
    .map(({ id, name }) => ({ id, name }))

  return (
    <div className="px-4 md:pl-8 md:pr-4 pt-4 md:pt-6 pb-8 w-full">
      {/* The LP statement (and its PDF) lives under /funds, which is gated on accounting — link to
          it only for a member who can open it, rather than a link that bounces to the dashboard. */}
      <LpCapitalView isAdmin={page.isAdmin} canOpenStatement={canViewPage(page, 'accounting')} initialVehicles={vehicles} />
    </div>
  )
}
