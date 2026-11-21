import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { ReviewView } from '../../review/view'

export const metadata: Metadata = { title: 'Statement review' }

/**
 * Statement review for an entity: the tie-out checks on an administrator's quarterly package and
 * their findings. Shows per-LP capital, so it is gated on lp_capital and the lp_tracking switch,
 * like every route behind it; the entity gate checks the entity's own grant as well.
 */
export default async function ReviewPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { domain: 'lp_capital', feature: 'lp_tracking' })
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Statement review"
        description="Check the quarter's statements before you rely on them: what ties out, and what to ask the administrator."
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <ReviewView />
      </FundSubpageChrome>
    </div>
  )
}
