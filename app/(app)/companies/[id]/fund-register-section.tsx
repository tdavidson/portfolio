// app/(app)/companies/[id]/fund-register-section.tsx
'use client'

import { FundHoldingDetail } from '@/components/fund-holding-detail'
import type { HoldingEntity } from '@/lib/portfolio/holding-entities'
import { initialEntity } from './holding-panels'

/**
 * A fund holding's register on its own page: terms, calls and distributions received, NAV
 * statements. The register is kept per (holding, entity), so a fund two of the viewer's entities
 * committed to shows one entity at a time — it opens on the one a link named (`?entity=`) when the
 * viewer has it, and FundHoldingDetail's own entity picker switches between them. No remount on a
 * switch: the detail syncs its `vehicleId` and drops a stale response itself (latest-only.ts).
 *
 * Its Add menu is the page's one Add for a fund holding: notices and NAV statements open its own
 * dialogs, "Other transaction" opens the investments section's generic form (`onAddTransaction`), and
 * "Transfer cost" its cost transfer dialog (`onTransferCost`).
 */
export function FundRegisterSection({ companyId, entities, initialEntityId, onChanged, onAddTransaction, onTransferCost }: {
  companyId: string
  entities: HoldingEntity[]
  initialEntityId: string | null
  /** A notice confirmed or a NAV saved booked a transaction: the investments section reloads. */
  onChanged?: () => void
  onAddTransaction?: () => void
  /** "Transfer cost" in the Add menu: opens the investments section's cost transfer dialog. */
  onTransferCost?: () => void
}) {
  return (
    <div className="mt-6">
      <FundHoldingDetail
        companyId={companyId}
        vehicleId={initialEntity(entities, initialEntityId)}
        onChanged={onChanged}
        onAddTransaction={onAddTransaction}
        onTransferCost={onTransferCost}
      />
    </div>
  )
}
