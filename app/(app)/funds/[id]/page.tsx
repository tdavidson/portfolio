import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAccountingAccess, requireVehicleAccess } from '../guard'
import { FUND_SUBPAGE_SLUGS } from '@/components/fund-subpages'
import { sectionForSlug } from '@/lib/accounting/nav'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'
import { capitalActionFromParam, type CapitalAction } from '@/lib/accounting/capital-action'
import { FundDetailView } from './fund-detail-view'
import { MancoDetailView } from './manco-detail-view'
import { FirmVehiclesTable } from '@/components/accounting/firm-vehicles'
import { EntityList } from '../entity-list'
import { getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess } from '@/lib/access/page-gate'
import { loadFundDetailInitial } from '@/lib/accounting/fund-detail-initial'

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await props.params
  const section = FUND_SUBPAGE_SLUGS.has(id) ? sectionForSlug(id) : null
  return { title: section?.label ?? 'Entity' }
}

/**
 * Two pages share this route, because the URL segment after /funds/ is either an entity or a
 * section, and which one decides what you get:
 *
 *   /funds/<entity id>  — the entity's LEAD page.
 *   /funds/<section>    — the FIRM-WIDE landing for that section: every entity, one row each,
 *                         linking to /funds/<id>/<section>.
 *
 * The second is what the sidebar's Entities subnav points at whenever the URL is not already
 * inside an entity. It used to point at whichever vehicle the browser last had in context — the
 * firm-wide page is the honest default: it asks which entity you mean instead of guessing.
 *
 * The lead page follows the entity's KIND, because this is the one page where a management
 * company genuinely differs. Every other page they share is the same double-entry ledger and so
 * is literally the same page; but a manco has no TVPI, no NAV, no schedule of investments and no
 * partners, so a fund's lead page would be a screen of dashes. What a firm asks about its own
 * operating entity is how much cash there is, what came in and went out each quarter, where the
 * money goes, and what the funds owe it.
 *
 * `[id]` is the vehicle's stable `fund_vehicles.id` (a UUID), the same way companies and LPs are
 * addressed — routing on the id survives a rename and sidesteps names with slashes. The gate
 * resolves it to the name and hands the client both, because the accounting data still keys on
 * the portfolio_group string while the switcher/sidebar route on the id. A legacy vehicle with no
 * registry row is addressed by its name directly, so an un-migrated fund still works.
 */
export default async function EntityPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.params;

  // Portfolio construction is the Forecast page's Portfolio tab now.
  if (params.id === 'construction') redirect('/funds/forecast')
  if (FUND_SUBPAGE_SLUGS.has(params.id)) {
    // Only the capital accounts landing has a query to forward — see EntityIndex's `action`.
    const sp = await props.searchParams
    const action = params.id === 'capital-accounts' ? capitalActionFromParam(typeof sp.action === 'string' ? sp.action : null) : null
    return <FirmSectionPage slug={params.id} action={action} />
  }

  const { vehicle, vehicleId, kind, active, fundId } = await requireVehicleAccess(params.id)
  const isManco = isManagementCompany(kind) && !!vehicleId
  // Started, not awaited: the header renders now and the figures stream in the same response.
  const initial = isManco ? undefined : (async () => {
    const user = await getUser()
    const page = user ? await resolvePageAccess(user.id) : null
    return page ? loadFundDetailInitial(createAdminClient() as any, fundId, page.access, vehicle) : null
  })()

  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <Link href="/funds" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-3.5 w-3.5" />All entities
      </Link>
      {isManco
        ? <MancoDetailView vehicle={vehicle} vehicleId={vehicleId!} active={active} />
        : <FundDetailView vehicle={vehicle} vehicleId={vehicleId} initial={initial} />}
    </div>
  )
}

/**
 * The firm-wide landing for one section: the entity index (/funds), with each entity's name
 * leading to this section's page. It used to load every entity's books first — the drafts queue on
 * the journal's, every open bank row on the bank's, every entity's ledger for the picker cards on
 * the rest — when what you come to /funds/journal for is to pick whose journal. Rendered here
 * rather than redirected to /funds, so the sidebar's link costs no extra round trip and still
 * shows which section you are in.
 *
 * Admin is the exception: there the state of every entity's books IS the question, and it is
 * where an entity is added, so it keeps the full table.
 */
async function FirmSectionPage({ slug, action }: { slug: string; action: CapitalAction | null }) {
  await requireAccountingAccess()

  // Two slugs are not pages of their own any more: plain-text authoring is a tab on the journal,
  // and LP capital events are one of the producers on the capital accounts page.
  if (slug === 'text') redirect('/funds/journal')
  if (slug === 'lp-events') redirect('/funds/capital-accounts')

  const section = sectionForSlug(slug)
  if (!section) redirect('/funds')

  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title={section.label}>{section.desc}</AccountingPageHeader>
      <AccountingBody>
        {slug === 'status'
          ? <FirmVehiclesTable section={slug} showAdd />
          : <EntityList section={slug} action={action} />}
      </AccountingBody>
    </div>
  )
}
