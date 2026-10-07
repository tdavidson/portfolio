import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { PortfolioSheetView } from '@/components/portfolio-sheet'

export const metadata: Metadata = { title: 'Portfolio' }

// One entity's portfolio — the management view beside its schedule of investments, read from the
// same positions. `requireVehicleAccess` refuses an entity the viewer was not granted.
export default async function EntityPortfolioPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Portfolio"
        description="Every holding — companies, funds and digital assets — with its cost, value and latest news"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <PortfolioSheetView group={vehicle} />
      </FundSubpageChrome>
    </div>
  )
}
