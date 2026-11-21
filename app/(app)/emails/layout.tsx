import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'

export const metadata: Metadata = { title: 'Inbound' }

// The Inbound list is a client page, so its data is gated by the /api/emails routes. This sends a
// member who cannot open the mailbox (an admin set Inbound to "Admins only", or they have no
// portfolio grant) to the dashboard instead of an empty page full of refused requests.
export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  if (!user) redirect('/auth')
  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'portfolio', 'inbound')) redirect('/dashboard')
  return children
}
