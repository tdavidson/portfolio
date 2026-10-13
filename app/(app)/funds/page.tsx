import type { Metadata } from 'next'
import Link from 'next/link'
import { requireAccountingAccess } from './guard'
import { FirmOverview } from './firm-overview'
import { MancoOverview } from './manco-overview'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'

export const metadata: Metadata = { title: 'Financials' }

/**
 * The entity overview — the landing page for the whole accounting section.
 *
 * The firm on one page: its figures, what is waiting on whose books, and every entity grouped by
 * entity group (FirmOverview). The performance-only table that used to be this page is the Fund
 * performance landing now, /funds/performance. The subpages (capital accounts, statements,
 * journal, …) are reached from the sidebar subnav, so this page does NOT repeat them as a grid of
 * link cards — that was duplicative.
 *
 * FirmOverview owns its own empty state: with no entity at all, it explains how to onboard one
 * rather than showing a blank table. MancoOverview owns the opposite — it renders
 * nothing rather than an empty state, because a firm with no management company should not be
 * told about one on the page it sees most. (Per-vehicle setup lives on the Admin page,
 * /funds/<id>/status; the state of every entity's books is the firm-wide Admin page,
 * /funds/status, which every other section's firm-wide landing shares.)
 */
export default async function AccountingPage() {
  await requireAccountingAccess()

  return (
    // The overview owns its own layout, in the /dashboard shape: the header sits ABOVE the body,
    // so the title goes all the way to the top with the toggle inline at its right, and the Analyst
    // panel opens below it rather than level with it. AccountingChrome steps aside on this route.
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title="Financials">
        Every entity the firm keeps books for: what it holds, what is waiting on its books, and the
        firm&rsquo;s own operating entities below it. Quarter-end work is on the{' '}
        <Link href="/funds/close-checklist" className="underline underline-offset-4 hover:text-foreground">close checklist</Link>.
      </AccountingPageHeader>

      <AccountingBody>
        {/* The management companies are rows in the entities table too, but what a firm asks of its
            own operating entity — revenue against expenses, and runway — is a question of its own,
            so they keep their table under it. MancoOverview renders nothing at all where there is
            no management company. */}
        <div className="space-y-8">
          <FirmOverview />
          <MancoOverview />
        </div>
      </AccountingBody>
    </div>
  )
}
