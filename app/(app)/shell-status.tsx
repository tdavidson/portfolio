import { ShellStatusUpdate } from '@/components/shell-status'
import { createClient } from '@/lib/supabase/server'
import { getNotesBadge, getPendingRequests, getUpdateAvailable } from '@/lib/cache/layout'
import type { PageAccess } from '@/lib/access/page-gate'

/** Counts always use the caller's RLS client: both domain and entity restrictions apply. */
export async function ShellBadges({ page, userId }: { page: PageAccess; userId: string }) {
  const client = await createClient()
  const [reviews, emails, approvals, notesBadge, settingsBadge] = await Promise.all([
    client.from('parsing_reviews').select('id', { count: 'exact', head: true })
      .eq('fund_id', page.fundId).is('resolution', null),
    client.from('inbound_emails').select('id', { count: 'exact', head: true })
      .eq('fund_id', page.fundId).eq('processing_status', 'needs_review'),
    client.from('pending_actions').select('id', { count: 'exact', head: true })
      .eq('fund_id', page.fundId).eq('status', 'pending'),
    getNotesBadge(userId),
    page.isAdmin ? getPendingRequests(page.fundId) : Promise.resolve(0),
  ])
  return <ShellStatusUpdate status={{
    reviewBadge: (reviews.count ?? 0) + (emails.count ?? 0),
    approvalsBadge: approvals.count ?? 0,
    notesBadge,
    settingsBadge,
  }} />
}

/** A slow release lookup never delays badges or the application content. */
export async function ShellUpdate() {
  return <ShellStatusUpdate status={{ updateAvailable: await getUpdateAvailable() }} />
}
