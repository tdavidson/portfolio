import { CompanyPageView } from '@/app/(app)/companies/[id]/page-view'
import { CompanyUpdatesPageView } from '@/app/(app)/company-updates/page-view'
import ImportPage from '@/app/(app)/import/page'
import InvestmentsPage from '@/app/(app)/investments/page'
import RequestsPage from '@/app/(app)/requests/page'
import { InteractionsContent } from '@/app/(app)/interactions/interactions-content'
import LettersPage from '@/app/(app)/letters/page'
import LetterEditorPage from '@/app/(app)/letters/[id]/page'
import NewLetterPage from '@/app/(app)/letters/new/page'
import NotesPage from '@/app/(app)/notes/page'
import CompliancePage from '@/app/(app)/compliance/page'
import ComplianceLinksPage from '@/app/(app)/compliance/links/page'
import { withData, type RouteRender } from '../route-helpers'

/** The Portfolio section's pages, beyond the dashboard itself (which ships in the core). */
export const renders: Record<string, RouteRender> = {
  '/companies/:id': withData(d => <CompanyPageView {...(d as any)} />),
  '/company-updates': withData(d => <CompanyUpdatesPageView {...(d as any)} />),
  '/import': () => <ImportPage />,
  '/investments': () => <InvestmentsPage />,
  '/requests': () => <RequestsPage />,
  '/interactions': withData(d => <InteractionsContent {...(d as any)} />),
  '/letters': () => <LettersPage />,
  '/letters/new': () => <NewLetterPage />,
  '/letters/:id': () => <LetterEditorPage />,
  '/notes': () => <NotesPage />,
  '/compliance': () => <CompliancePage />,
  '/compliance/links': () => <ComplianceLinksPage />,
}
