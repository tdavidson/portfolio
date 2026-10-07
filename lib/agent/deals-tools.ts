// Handlers for the INBOUND DEALS agent tools (top-of-funnel screening). Read-only.
//
// See deals-tools-manifest.ts for why these are named `deals_*_inbound` and kept
// distinct from the `diligence_*` tools: they are different tables at different stages of
// the same funnel, and conflating them silently answers the wrong question.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'

const LIST_COLUMNS =
  'id, company_name, company_url, company_domain, founder_name, founder_email, intro_source, referrer_name, ' +
  'thesis_fit_score, stage, industry, raise_amount, status, promoted_diligence_id, created_at'

async function resolveInboundDeal(admin: SupabaseClient, fundId: string, ref: string, access: AccessContext): Promise<any> {
  if (!ref) throw new Error('An inbound deal id or company name is required')
  // Only deals owned by one of the caller's entities (unassigned ones: unscoped callers only).
  const mine = (d: any) => canSeeVehicle(access, d.vehicle_id ?? null)

  const { data: byId } = await (admin as any)
    .from('inbound_deals').select('*').eq('fund_id', fundId).eq('id', ref).maybeSingle()
  if (byId && mine(byId)) return byId

  const { data } = await (admin as any)
    .from('inbound_deals').select('*').eq('fund_id', fundId).ilike('company_name', ref)
  const rows = ((data as any[]) ?? []).filter(mine)
  if (rows.length === 1) return rows[0]
  if (rows.length > 1) {
    // Genuinely common here: the same company pitches twice. `prior_deal_id` chains them,
    // so the newest is almost certainly the one meant — but say so rather than assume.
    const newest = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    throw new Error(
      `"${ref}" matches ${rows.length} inbound deals (the company has pitched more than once). ` +
      `The most recent is ${newest.id} (${newest.created_at}). Pass an id.`
    )
  }

  const { data: fuzzy } = await (admin as any)
    .from('inbound_deals').select('*').eq('fund_id', fundId).ilike('company_name', `%${ref}%`).limit(25)
  const near = ((fuzzy as any[]) ?? []).filter(mine).slice(0, 5).map(d => d.company_name)
  throw new Error(
    near.length > 0
      ? `No inbound deal for "${ref}". Did you mean: ${near.join(', ')}?`
      : `No inbound deal for "${ref}" in this fund.`
  )
}

export const DEALS_HANDLERS: Record<string, AgentToolHandler> = {
  deals_list_inbound: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const limit = Math.min(Number(input?.limit ?? 100), 500)
    let q = (admin as any)
      .from('inbound_deals')
      .select(LIST_COLUMNS)
      .eq('fund_id', fundId)
      .order('created_at', { ascending: false })
      .limit(limit)

    // The caller's entities only. Filtered only for a scoped caller: vehicle_id exists once the
    // entity migration has run, and before it every caller is unscoped.
    const vehicleIds = visibleVehicleIds(access)
    if (vehicleIds !== null) q = q.in('vehicle_id', vehicleIds)
    if (input?.status) q = q.eq('status', String(input.status))
    if (input?.fit_score) q = q.eq('thesis_fit_score', String(input.fit_score))
    if (input?.intro_source) q = q.eq('intro_source', String(input.intro_source))

    const { data } = await q
    let rows = ((data as any[]) ?? [])
    if (input?.q) {
      const needle = String(input.q).toLowerCase()
      rows = rows.filter(d =>
        String(d.company_name ?? '').toLowerCase().includes(needle) ||
        String(d.founder_name ?? '').toLowerCase().includes(needle)
      )
    }

    return rows.map(d => ({
      id: d.id,
      company: d.company_name,
      url: d.company_url,
      founder: d.founder_name,
      intro_source: d.intro_source,
      referrer: d.referrer_name,
      thesis_fit: d.thesis_fit_score,
      stage: d.stage,          // the COMPANY's funding stage, not a pipeline position
      industry: d.industry,
      raise: d.raise_amount,
      status: d.status,
      in_diligence: !!d.promoted_diligence_id,
      diligence_deal_id: d.promoted_diligence_id ?? null,
      created_at: d.created_at,
    }))
  },

  deals_inbound_detail: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveInboundDeal(admin, fundId, String(input?.deal ?? ''), access)

    const { data: email } = await (admin as any)
      .from('inbound_emails')
      .select('from_address, subject, received_at')
      .eq('id', deal.email_id)
      .eq('fund_id', fundId)
      .maybeSingle()

    return {
      id: deal.id,
      company: deal.company_name,
      url: deal.company_url,
      domain: deal.company_domain,
      founder: deal.founder_name,
      founder_email: deal.founder_email,
      co_founders: deal.co_founders ?? [],
      intro_source: deal.intro_source,
      referrer: deal.referrer_name ? { name: deal.referrer_name, email: deal.referrer_email } : null,
      summary: deal.company_summary,
      thesis_fit: deal.thesis_fit_score,
      thesis_fit_analysis: deal.thesis_fit_analysis,
      stage: deal.stage,
      industry: deal.industry,
      raise: deal.raise_amount,
      status: deal.status,
      research: deal.research_status
        ? {
            status: deal.research_status,
            summary: deal.research_summary ?? null,
            findings: deal.research_findings ?? [],
            sources: deal.research_sources ?? [],
            researched_at: deal.researched_at ?? null,
          }
        : null,
      // The bridge into the other half of the funnel — hand this id to the diligence tools.
      promoted_to_diligence: deal.promoted_diligence_id ?? null,
      source_email: email
        ? { from: (email as any).from_address, subject: (email as any).subject, received_at: (email as any).received_at }
        : null,
      created_at: deal.created_at,
    }
  },
}
