'use client'

import { useEffect } from 'react'
import { useVehicle, FundSwitcher, VehicleScope } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'

/**
 * Pins the section's vehicle context to the URL and renders nothing. The fund pages route
 * on the vehicle id, but the views read the vehicle from context (and the Analyst scopes to
 * it), so every fund page syncs the URL's vehicle into the context on mount.
 */
export function FundScopeSync({ vehicle, vehicleId }: { vehicle: string; vehicleId: string | null }) {
  const { setVehicle } = useVehicle()
  useEffect(() => { setVehicle(vehicle, vehicleId) }, [vehicle, vehicleId, setVehicle])
  return null
}

/**
 * The shared chrome for a fund subpage (/funds/[id]/journal, …). It:
 *  - pins the section's vehicle context to the URL (so the views, which read the vehicle
 *    from context, and the Analyst scope to the fund the URL names),
 *  - renders the shared accounting header (AccountingPageHeader) with the fund switcher in
 *    its action group, so it lays out on a phone the way every other page does,
 *  - wraps the page body in <AccountingBody>, so the Analyst panel slides in UNDERNEATH the
 *    header rather than squeezing it,
 *  - scopes the body to the URL's vehicle from the first render (VehicleScope), so the view's
 *    first request is for this fund rather than whatever was selected before.
 */
export function FundSubpageChrome({
  title, description, vehicle, vehicleId, children,
}: {
  title: string
  description?: string
  vehicle: string
  vehicleId: string | null
  children: React.ReactNode
}) {
  return (
    <VehicleScope vehicle={vehicle} vehicleId={vehicleId}>
      <FundScopeSync vehicle={vehicle} vehicleId={vehicleId} />
      <AccountingPageHeader title={title} actions={<FundSwitcher />}>{description}</AccountingPageHeader>
      <AccountingBody>{children}</AccountingBody>
    </VehicleScope>
  )
}
