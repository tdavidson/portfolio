import type { ComponentProps } from 'react'
import type { PageContext } from '@/lib/pages/context'
import type { DealDetail } from './deal-detail'
import { canSeeVehicle } from '@/lib/access/scope'

export type DiligenceDealPageData = Pick<
  ComponentProps<typeof DealDetail>,
  'deal' | 'initialDocuments' | 'latestDraft' | 'isAdmin' | 'currentUserId'
>

/** One diligence deal with its data room and latest memo draft; null when it is not this fund's. */
export async function loadDiligenceDealPage({ admin, user, page }: PageContext, params: { id: string }): Promise<DiligenceDealPageData | null> {
  const fundId = page.fundId
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return null
  // One of the viewer's entities' records (admins: all).
  if (!canSeeVehicle(page.access, (deal as any).vehicle_id ?? null)) return null

  const [{ data: documents }, { data: latestDraft }] = await Promise.all([
    admin
      .from('diligence_documents')
      .select('id, deal_id, file_name, file_format, file_size_bytes, detected_type, type_confidence, parse_status, drive_source_url, uploaded_at')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
      .order('uploaded_at', { ascending: false }),
    admin
      .from('diligence_memo_drafts')
      .select('id, draft_version, agent_version, is_draft, created_at, finalized_at')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    deal: deal as any,
    initialDocuments: (documents as any) ?? [],
    latestDraft: latestDraft as any,
    isAdmin: page.isAdmin,
    currentUserId: user.id,
  }
}
