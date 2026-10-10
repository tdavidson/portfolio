import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { loadInteractionsPage } from './load'
import { InteractionsContent } from './interactions-content'

export const metadata: Metadata = { title: 'Interactions' }

export default async function InteractionsPage(props: { searchParams: Promise<{ company_id?: string | string[] }> }) {
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')

  // A SERVER COMPONENT FETCHES ITS OWN DATA, so the middleware never sees it — being in the
  // registry does nothing for this page. Interactions are the `relationships` domain: candid
  // notes on who knows whom, and the reason that domain was split out of `portfolio`. Without
  // this gate a member denied relationships still got 100 of them server-rendered.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'relationships', 'interactions')) redirect('/dashboard')

  const admin = createAdminClient()
  const { company_id } = await props.searchParams
  const data = await loadInteractionsPage({ supabase, admin, user, page }, typeof company_id === 'string' ? company_id : null)
  return <InteractionsContent {...data} />
}
