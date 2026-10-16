import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { ForecastView, type ForecastTab } from '../../forecast/view'
import { VehicleScope } from '@/components/accounting-vehicle'

export const metadata: Metadata = { title: 'Forecast' }

/**
 * Forecast — one plan per scenario, in two tabs (plans/plan-unified-plan.md §5): Portfolio (the
 * plan's portfolio construction) and Fund forecast (monthly P&L, cash, capital management and net
 * returns). A management company gets the fund forecast alone.
 *
 * The page renders no fund data on the server: the view reads everything through
 * /api/accounting/forecast/* and /api/accounting/construction, which the middleware gates on
 * accounting and the services re-check (management_company too, for a manco). The guard here is
 * the page's own gate.
 */
export default async function ForecastPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.params
  const sp = await props.searchParams
  const { vehicle, vehicleId, kind } = await requireVehicleAccess(params.id)
  // Scoped above the view, not just its body: ForecastView loads through useLedgerFetch itself.
  return (
    <VehicleScope vehicle={vehicle} vehicleId={vehicleId}>
      <ForecastView vehicle={vehicle} vehicleId={vehicleId} kind={kind} initialTab={tabParam(sp.tab)} />
    </VehicleScope>
  )
}

/** ?tab=… — the four tabs, and the old Portfolio / Fund forecast names. */
function tabParam(raw: string | string[] | undefined): ForecastTab | undefined {
  const t = typeof raw === 'string' ? raw : undefined
  if (t === 'portfolio') return 'investments'
  if (t === 'fund') return 'financials'
  if (t === 'returns') return 'charts'
  return t === 'charts' || t === 'investments' || t === 'capital' || t === 'financials' ? t : undefined
}
