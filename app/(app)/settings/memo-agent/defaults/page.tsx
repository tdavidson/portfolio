import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { DefaultsEditor } from './editor'

export const metadata: Metadata = { title: 'Diligence defaults' }

export default async function DefaultsPage() {
  const supabase = await createClient()
  const user = await getUser()
  if (!user) redirect('/auth')

  const admin = createAdminClient()
  // These pages configure the diligence agent and render its schemas server-side, so the domain
  // has to be checked here — the middleware only sees the API calls the editors make later.
  // Member-level, not admin-only: the fund decides who gets diligence, and the grant decides who
  // gets to tune it.
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'diligence')) redirect('/dashboard')

  return <DefaultsEditor />
}
