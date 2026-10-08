import type { ComponentProps } from 'react'
import type { PageContext } from '@/lib/pages/context'
import type { QAChat } from './qa-chat'
import { canSeeVehicle } from '@/lib/access/scope'

export type DiligenceQaPageData = Pick<ComponentProps<typeof QAChat>, 'dealId' | 'dealName'>

export async function loadDiligenceQaPage({ admin, page }: PageContext, params: { id: string }): Promise<DiligenceQaPageData | null> {
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', page.fundId)
    .maybeSingle()
  // One of the viewer's entities' records (admins: all), as the diligence page checks.
  if (!deal || !canSeeVehicle(page.access, (deal as any).vehicle_id ?? null)) return null
  return { dealId: params.id, dealName: (deal as any).name }
}
