import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { ForecastView } from '../../forecast/view'

export const metadata: Metadata = { title: 'Forecast' }

/**
 * Forecast — monthly budgets, rolling forecasts and their actuals, per vehicle
 * (plans/plan-budget-forecast.md).
 *
 * The page renders no fund data on the server: the view reads everything through
 * /api/accounting/forecast/*, which the middleware gates on accounting + budgeting and the service
 * re-checks (management_company too, for a manco). The guard here is the page's own gate.
 */
export default async function ForecastPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { feature: 'budgeting' })
  return <ForecastView vehicle={vehicle} vehicleId={vehicleId} />
}
