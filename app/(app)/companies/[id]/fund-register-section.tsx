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
 */
export function FundRegisterSection({ companyId, entities, initialEntityId }: {
  companyId: string
  entities: HoldingEntity[]
  initialEntityId: string | null
}) {
  return (
    <div className="mt-6">
      <FundHoldingDetail companyId={companyId} vehicleId={initialEntity(entities, initialEntityId)} />
    </div>
  )
}
