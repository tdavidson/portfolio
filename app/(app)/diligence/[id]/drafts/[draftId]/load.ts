import type { ComponentProps } from 'react'
import type { PageContext } from '@/lib/pages/context'
import { buildSourceLabels } from '@/lib/memo-agent/render/source-labels'
import type { MemoEditor } from './memo-editor'
import { canSeeVehicle } from '@/lib/access/scope'

export type MemoDraftPageData = Pick<
  ComponentProps<typeof MemoEditor>,
  'dealId' | 'dealName' | 'draft' | 'initialAttention' | 'sourceLabels' | 'isAdmin'
>

export async function loadMemoDraftPage({ admin, page }: PageContext, params: { id: string; draftId: string }): Promise<MemoDraftPageData | null> {
  const fundId = page.fundId
  // The record first: one of the viewer's entities' (admins: all), as the diligence page checks —
  // before any of its draft is read. '*': vehicle_id exists once the entity migration has run.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal || !canSeeVehicle(page.access, (deal as any).vehicle_id ?? null)) return null

  const { data: draft } = await admin
    .from('diligence_memo_drafts')
    .select('*')
    .eq('id', params.draftId)
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!draft) return null

  const [{ data: attention }, { data: docs }] = await Promise.all([
    admin
      .from('diligence_attention_items')
      .select('id, deal_id, draft_id, kind, urgency, body, links, status, created_at')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId)
      .order('created_at', { ascending: false }),
    admin
      .from('diligence_documents')
      .select('id, file_name')
      .eq('deal_id', params.id)
      .eq('fund_id', fundId),
  ])

  const documentNames = Object.fromEntries(
    ((docs as any[]) ?? []).map(d => [d.id as string, (d.file_name ?? '') as string])
  )
  const sourceLabels = Object.fromEntries(
    buildSourceLabels({
      ingestion: (draft as any).ingestion_output ?? null,
      research: (draft as any).research_output ?? null,
      qa: (draft as any).qa_answers ?? null,
      documentNames,
    })
  )

  return {
    dealId: params.id,
    dealName: (deal as any).name,
    draft: draft as any,
    initialAttention: (attention as any) ?? [],
    sourceLabels,
    isAdmin: page.isAdmin,
  }
}
