import type { ComponentProps } from 'react'
import type { PageContext } from '@/lib/pages/context'
import type { DiligenceIndex } from './diligence-index'
import { visibleVehicleIds } from '@/lib/access/scope'

export type DiligencePageData = Pick<ComponentProps<typeof DiligenceIndex>, 'initialDeals' | 'isAdmin'>

export async function loadDiligencePage({ admin, page }: PageContext): Promise<DiligencePageData> {
  let query = admin
    .from('diligence_deals')
    .select('id, name, sector, stage_at_consideration, deal_status, current_memo_stage, lead_partner_id, promoted_company_id, created_at, updated_at')
    .eq('fund_id', page.fundId)
  // Only the viewer's entities' diligence (admins: all).
  const vehicleIds = visibleVehicleIds(page.access)
  if (vehicleIds !== null) query = query.in('vehicle_id' as any, vehicleIds)
  const { data: deals } = await query
    .order('updated_at', { ascending: false })
    .limit(200)
  return { initialDeals: (deals as any) ?? [], isAdmin: page.isAdmin }
}
