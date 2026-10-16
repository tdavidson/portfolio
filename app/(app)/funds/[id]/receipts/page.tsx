import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { ReceiptsView } from '../../receipts/view'

export const metadata: Metadata = { title: 'Receipts' }

export default async function ReceiptsPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Receipts"
        description="Receipts behind the entries, and the quarterly invoices that bill partnership expenses to the funds."
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <ReceiptsView />
      </FundSubpageChrome>
    </div>
  )
}
