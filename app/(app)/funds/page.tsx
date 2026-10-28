import type { Metadata } from 'next'
import { requireAccountingAccess } from './guard'
import { EntityList } from './entity-list'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'

export const metadata: Metadata = { title: 'Financials' }

/**
 * The entity index — the landing page for the whole accounting section.
 *
 * Every entity the caller may see, grouped by entity group, each with links to its pages. It used
 * to be the firm on one page (every entity's figures and what was waiting on its books, then the
 * management companies' revenue and runway), which meant loading every entity's ledger and the
 * fund economics before the page could say anything — when what you come here for is picking an
 * entity. The figures are on each entity's own pages; the state of every entity's books is still
 * the firm-wide Admin page, /funds/status, and an entity group's figures its family page,
 * /funds/group/<id>.
 */
export default async function AccountingPage() {
  await requireAccountingAccess()

  return (
    // The overview owns its own layout, in the /dashboard shape: the header sits ABOVE the body,
    // so the title goes all the way to the top with the toggle inline at its right, and the Analyst
    // panel opens below it rather than level with it. AccountingChrome steps aside on this route.
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title="Financials">
        Every entity the firm keeps books for. Pick one to open its pages.
      </AccountingPageHeader>

      <AccountingBody>
        <EntityList />
      </AccountingBody>
    </div>
  )
}
