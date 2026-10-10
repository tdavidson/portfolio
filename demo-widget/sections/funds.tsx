import { Suspense, type ReactNode } from 'react'
import Link from 'next/link'
import { FundOverview } from '@/app/(app)/funds/fund-overview'
import { MancoOverview } from '@/app/(app)/funds/manco-overview'
import { FundDetailView } from '@/app/(app)/funds/[id]/fund-detail-view'
import { MancoDetailView } from '@/app/(app)/funds/[id]/manco-detail-view'
import { BankView } from '@/app/(app)/funds/bank/view'
import { CapitalAccountsView } from '@/app/(app)/funds/capital-accounts/view'
import { LpStatementView } from '@/app/(app)/funds/capital-accounts/[lpEntityId]/view'
import { ConstructionView } from '@/app/(app)/funds/construction/view'
import { ForecastView } from '@/app/(app)/funds/forecast/view'
import { JournalPageView } from '@/app/(app)/funds/journal/page-view'
import { LedgerView } from '@/app/(app)/funds/ledger/view'
import { MigrateView } from '@/app/(app)/funds/migrate/view'
import { OpeningBalancesView } from '@/app/(app)/funds/opening-balances/view'
import { SnapshotCutover } from '@/app/(app)/funds/opening-balances/snapshot-cutover'
import { PeriodsView } from '@/app/(app)/funds/periods/view'
import { ScheduleOfInvestmentsView } from '@/app/(app)/funds/schedule-of-investments/view'
import { StatementsView } from '@/app/(app)/funds/statements/view'
import { StatusView } from '@/app/(app)/funds/status/view'
import { TaxView } from '@/app/(app)/funds/tax/view'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'
import { FundSubpageChrome, FundScopeSync } from '@/components/fund-subpage-chrome'
import { FundSwitcher } from '@/components/accounting-vehicle'
import { FirmVehiclesTable } from '@/components/accounting/firm-vehicles'
import { FUND_SUBPAGE_SLUGS } from '@/components/fund-subpages'
import { sectionForSlug } from '@/lib/accounting/nav'
import { capitalActionFromParam } from '@/lib/accounting/capital-action'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { NoData, resolveVehicle, type RouteRender, type Vehicle } from '../route-helpers'

/**
 * The Entities section: the app's chrome around the app's views, with the vehicle resolved from
 * the snapshot exactly as app/(app)/funds/guard.ts resolves it from the database.
 */
const SUBPAGES: Record<string, { title: string; description: string; view: ReactNode }> = {
  'bank': { title: 'Bank transactions', description: 'Import bank transactions and post to the journal', view: <BankView /> },
  'capital-accounts': { title: 'Capital accounts', description: 'Limited partner roll-forward per period', view: <Suspense fallback={null}><CapitalAccountsView /></Suspense> },
  'journal': { title: 'Journal', description: 'Every entry, to view, unpost or edit — or author entries as plain text and post them in one go.', view: <JournalPageView /> },
  'ledger': { title: 'General ledger', description: 'One account at a time: the balance carried in, every posting, and the running balance.', view: <Suspense fallback={null}><LedgerView /></Suspense> },
  'migrate': { title: 'Migrate from QuickBooks', description: 'Import the general ledger, map the accounts, and tie every period out to QuickBooks', view: null },
  'opening-balances': { title: 'Opening balances', description: 'Take over at a cutover date: enter each LP’s capital balance from their latest statement. Books one opening entry — no history to reconstruct.', view: <><div className="mb-8"><SnapshotCutover /></div><OpeningBalancesView /></> },
  'periods': { title: 'Period close', description: 'Allocate income and expenses to each partner and close the period', view: <PeriodsView /> },
  'schedule-of-investments': { title: 'Schedule of investments', description: 'Each investment at cost and fair value', view: <ScheduleOfInvestmentsView /> },
  'statements': { title: 'Financial statements', description: 'Consolidated operations, cash flows, and changes in partners capital', view: <StatementsView /> },
  'status': { title: 'Admin', description: 'Current status and open issues', view: <StatusView /> },
  'tax': { title: 'Tax', description: "The year's book-to-tax adjustments, adjusting entries, K-1 package, partner tax forms, and the tax package for the preparer.", view: <TaxView /> },
}

function Overview() {
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title="Entities">
        Performance per investment vehicle, derived from fund accounting or LP capital accounts,
        and the firm&rsquo;s own operating entities below it.
      </AccountingPageHeader>
      <AccountingBody>
        <div className="space-y-8">
          <FundOverview />
          <MancoOverview />
        </div>
      </AccountingBody>
    </div>
  )
}

function FundsSection({ slug, query }: { slug: string; query: URLSearchParams }) {
  const section = sectionForSlug(slug)
  if (!section) return <NoData href={`/funds/${slug}`} />
  const action = slug === 'capital-accounts' ? capitalActionFromParam(query.get('action')) : null
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title={section.label}>{section.desc}</AccountingPageHeader>
      <AccountingBody>
        <FirmVehiclesTable section={slug} showAdd={slug === 'status'} action={action} />
      </AccountingBody>
    </div>
  )
}

function EntityLead({ v }: { v: Vehicle }) {
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <Link href="/funds" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4">All entities</Link>
      {isManagementCompany(v.kind) && v.vehicleId
        ? <MancoDetailView vehicle={v.vehicle} vehicleId={v.vehicleId} active={v.active} />
        : <FundDetailView vehicle={v.vehicle} vehicleId={v.vehicleId} />}
    </div>
  )
}

/** app/(app)/funds/[id]/capital-accounts/[lpEntityId]: one LP's capital statement. */
function LpStatement({ v, entityId, lpEntityId, query }: { v: Vehicle; entityId: string; lpEntityId: string; query: URLSearchParams }) {
  const fromLps = query.get('from') === 'lps'
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundScopeSync vehicle={v.vehicle} vehicleId={v.vehicleId} />
      <Link href={fromLps ? '/lps/capital' : `/funds/${entityId}/capital-accounts`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4">
        {fromLps ? 'LP capital accounts' : 'Capital accounts'}
      </Link>
      <AccountingPageHeader title="LP capital statement" actions={<FundSwitcher />} />
      <AccountingBody>
        <LpStatementView lpEntityId={lpEntityId} />
      </AccountingBody>
    </div>
  )
}

function EntitySubpage({ v, slug }: { v: Vehicle; slug: string }) {
  if (slug === 'construction') return <ConstructionView vehicle={v.vehicle} vehicleId={v.vehicleId} />
  // The page renders the view bare, as the app does (app/(app)/funds/[id]/forecast/page.tsx).
  if (slug === 'forecast') return <ForecastView vehicle={v.vehicle} vehicleId={v.vehicleId} />
  const page = SUBPAGES[slug]
  if (!page) return <NoData href={`/funds/${v.vehicleId ?? v.vehicle}/${slug}`} />
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome title={page.title} description={page.description} vehicle={v.vehicle} vehicleId={v.vehicleId}>
        {slug === 'migrate' ? <MigrateView key={v.vehicleId ?? v.vehicle} group={v.vehicle} /> : page.view}
      </FundSubpageChrome>
    </div>
  )
}

export const renders: Record<string, RouteRender> = {
  '/funds': () => <Overview />,
  // /funds/<section> is the firm-wide landing for that section; /funds/<entity id> the entity.
  '/funds/:x': ctx => FUND_SUBPAGE_SLUGS.has(ctx.params.x)
    ? <FundsSection slug={ctx.params.x} query={ctx.query} />
    : <EntityLead v={resolveVehicle(ctx.snapshot, ctx.params.x)} />,
  '/funds/:id/:slug': ctx => <EntitySubpage v={resolveVehicle(ctx.snapshot, ctx.params.id)} slug={ctx.params.slug} />,
  '/funds/:id/capital-accounts/:lpEntityId': ctx => (
    <LpStatement v={resolveVehicle(ctx.snapshot, ctx.params.id)} entityId={ctx.params.id} lpEntityId={ctx.params.lpEntityId} query={ctx.query} />
  ),
}
