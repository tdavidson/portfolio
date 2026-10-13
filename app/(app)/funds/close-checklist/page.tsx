import type { Metadata } from 'next'
import { requireAccountingAccess } from '../guard'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'
import { CloseChecklistView } from './view'

export const metadata: Metadata = { title: 'Close checklist' }

/**
 * The quarter-end close checklist: the same checklist chat builds and works (close_checklist_*),
 * as a page. Renders no fund data on the server — the checklist arrives through
 * /api/accounting/close-checklists, which the middleware gates — so the gate here is the section's.
 */
export default async function CloseChecklistPage() {
  await requireAccountingAccess()
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title="Close checklist">
        The quarter-end close, by owner, with due dates counted back from LP delivery. &ldquo;Tied out&rdquo; is
        separate from done: a finished task is not a verified number.
      </AccountingPageHeader>
      <AccountingBody>
        <CloseChecklistView />
      </AccountingBody>
    </div>
  )
}
