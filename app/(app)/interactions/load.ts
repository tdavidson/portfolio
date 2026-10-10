import type { ComponentProps } from 'react'
import type { PageContext } from '@/lib/pages/context'
import type { InteractionsContent } from './interactions-content'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

export type InteractionsPageData = Pick<ComponentProps<typeof InteractionsContent>, 'interactions' | 'company'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The latest hundred interactions with the company name attached to each — the caller's companies'
 *  (and ones about no company), as /api/interactions serves them. With `companyId` (a company
 *  page's "View all"), that company's only — and only if it is one of the caller's companies; any
 *  other id is ignored rather than answered with an empty list that would confirm it exists. */
export async function loadInteractionsPage({ admin, page }: PageContext, companyId?: string | null): Promise<InteractionsPageData> {
  const scope = await entityScopeFor(admin as any, page.access)
  let company: { id: string; name: string } | null = null
  if (companyId && UUID.test(companyId) && (scope.companyIds === null || scope.companyIds.includes(companyId))) {
    const { data } = await (admin as any).from('companies').select('id, name').eq('fund_id', page.fundId).eq('id', companyId).maybeSingle()
    company = data ? { id: data.id, name: data.name } : null
  }
  let query = filterByCompany((admin as any)
    .from('interactions')
    .select('id, fund_id, company_id, email_id, user_id, tags, subject, summary, intro_contacts, body_preview, interaction_date, created_at')
    .eq('fund_id', page.fundId), scope.companyIds, { keepUnlinked: true })
  if (company) query = query.eq('company_id', company.id)
  const { data: interactions } = await query
    .order('interaction_date', { ascending: false })
    .limit(100)

  // Batch-load company names
  const companyIds = Array.from(new Set((interactions ?? []).map((i: any) => i.company_id).filter(Boolean))) as string[]
  const companyNameMap: Record<string, string> = {}
  if (companyIds.length > 0) {
    const { data: companies } = await admin
      .from('companies')
      .select('id, name')
      .in('id', companyIds) as { data: { id: string; name: string }[] | null }
    for (const c of companies ?? []) {
      companyNameMap[c.id] = c.name
    }
  }

  const enriched = (interactions ?? []).map((i: any) => ({
    ...i,
    company_name: i.company_id ? companyNameMap[i.company_id] ?? null : null,
  }))
  return { interactions: enriched, company }
}
