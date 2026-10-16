import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireVehicleAccess } from '../../../guard'
import { FundScopeSync } from '@/components/fund-subpage-chrome'
import { FundSwitcher, VehicleScope } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { LpStatementView } from '../../../capital-accounts/[lpEntityId]/view'

export const metadata: Metadata = { title: 'LP capital statement' }

export default async function LpStatementPage(
  props: {
    params: Promise<{ id: string; lpEntityId: string }>
    searchParams: Promise<{ from?: string }>
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  // Return to wherever the LP was opened from: the LP capital-accounts page marks its links
  // with `?from=lps`; everything else (the Funds capital-accounts table) uses the default.
  const fromLps = searchParams?.from === 'lps'
  const backHref = fromLps ? '/lps/capital' : `/funds/${params.id}/capital-accounts`
  const backLabel = fromLps ? 'LP capital accounts' : 'Capital accounts'
  return (
    <VehicleScope vehicle={vehicle} vehicleId={vehicleId}>
      <div className="pt-4 md:pt-8 pb-8 w-full">
        <FundScopeSync vehicle={vehicle} vehicleId={vehicleId} />
        <Link href={backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-3.5 w-3.5" />{backLabel}
        </Link>
        <AccountingPageHeader title="LP capital statement" actions={<FundSwitcher />} />
        <AccountingBody>
          <LpStatementView lpEntityId={params.lpEntityId} vehicleId={vehicleId} />
        </AccountingBody>
      </div>
    </VehicleScope>
  )
}
