import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { computeSetupProgress, loadSetupFacts } from '@/lib/onboarding/progress'
import { GettingStartedView } from './view'

export const metadata: Metadata = { title: 'Getting started' }

/**
 * The setup checklist for a new fund, computed from the fund's own data.
 *
 * Gated on `portfolio` — the always-on domain every fund runs — before anything is read. What the
 * page then shows is filtered again per step by the same resolver (lib/onboarding/progress.ts):
 * the loader does not even query a domain the viewer cannot read, and a step linking to a page
 * they could not open is left out rather than shown locked. Admin-only steps (products, AI key,
 * inbound email, adding an entity) appear only for admins.
 */
export default async function GettingStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const user = await getUser()
  if (!user) redirect('/auth')

  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'portfolio')) redirect('/start')

  const sp = await searchParams
  const entity = typeof sp.entity === 'string' ? sp.entity : null

  const admin = createAdminClient()
  const facts = await loadSetupFacts(admin, page.fundId, page.access, { vehicleId: entity })
  const progress = computeSetupProgress(facts)

  return (
    <GettingStartedView
      progress={progress}
      vehicles={facts.vehicles}
      isAdmin={page.isAdmin}
    />
  )
}
