import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEmailPage } from './load'
import { EmailPageView } from './page-view'

export const metadata: Metadata = { title: 'Email' }

export default async function EmailDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')
  const admin = createAdminClient()

  // A SERVER COMPONENT FETCHES ITS OWN DATA, so the middleware never sees it — this page's entry
  // in ROUTE_DOMAINS governs `api/emails/[id]`, not the page. Below, RLS ("Fund members can read
  // emails") scopes the row to the fund and stops there, so without this gate any member with the
  // UUID got the whole message server-rendered — raw_payload included — whatever their grant said.
  // That is the "hidden but still reachable by URL" hole the access model exists to close.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'portfolio', 'inbound')) redirect('/dashboard')

  const data = await loadEmailPage({ supabase, admin, user, page }, params)
  if (!data) notFound()
  return <EmailPageView {...data} />
}
