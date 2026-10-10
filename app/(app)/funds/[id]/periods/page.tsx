import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { PeriodsView } from '../../periods/view'

export const metadata: Metadata = { title: 'Close' }

export default async function PeriodsPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Close"
        description="Allocate income and expenses to each partner and close the period"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <PeriodsView />
      </FundSubpageChrome>
    </div>
  )
}
