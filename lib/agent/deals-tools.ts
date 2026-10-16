// Handlers for the INBOUND DEALS agent tools (top-of-funnel screening).
//
// The writes call lib/deals/service.ts, the functions behind the Deals page's own routes, so a deal
// created or moved from chat is checked and stored exactly like one made there.
//
// See deals-tools-manifest.ts for why these are named `deals_*_inbound` and kept
// distinct from the `diligence_*` tools: they are different tables at different stages of
// the same funnel, and conflating them silently answers the wrong question.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { parseUpdateFiles } from '@/lib/company-updates/submit'
import { createManualDeal, MAX_DEAL_FILE_BYTES, MAX_DEAL_FILES, promoteInboundDeal, queueDealResearch, updateInboundDeal } from '@/lib/deals/service'
import { readStagedUploads, removeStaged } from '@/lib/uploads/signed-upload'
import { unwrap } from '@/lib/service-outcome'
import { fundMemberId, visibleVehicleId } from './refs'
import { jobHandle, jobRecordId } from './jobs'

const LIST_COLUMNS =
  'id, company_name, company_url, company_domain, founder_name, founder_email, intro_source, referrer_name, ' +
  'thesis_fit_score, stage, industry, raise_amount, status, promoted_diligence_id, created_at'

export async function resolveInboundDeal(admin: SupabaseClient, fundId: string, ref: string, access: AccessContext): Promise<any> {
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
      .select('from_address, subject, received_at, raw_payload')
      .eq('id', deal.email_id)
      .eq('fund_id', fundId)
      .maybeSingle()

    // Not analysed yet (the fund has no server AI key, or the analyzer failed): hand the caller what
    // the analyzer would have read, so it can write the analysis back with deals_update_inbound.
    let toAnalyse: Record<string, unknown> | undefined
    if (!deal.thesis_fit_score) {
      const { data: settings } = await (admin as any).from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
      toAnalyse = {
        pitch: String((email as any)?.raw_payload?.TextBody ?? '').slice(0, 12_000),
        attachments: (((email as any)?.raw_payload?.Attachments ?? []) as { Name?: string }[]).map(a => a.Name).filter(Boolean),
        fund_thesis: (settings as any)?.deal_thesis ?? null,
        screening_guidance: (settings as any)?.deal_screening_prompt ?? null,
        then: 'deals_update_inbound with company_summary, thesis_fit_analysis, thesis_fit_score, stage, industry, raise_amount',
      }
    }

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
      ...(toAnalyse ? { to_analyse: toAnalyse } : {}),
    }
  },

  deals_create_inbound: async ({ admin, fundId, access, userId, origin }: AgentToolContext, input: any) => {
    const actor = requireUser(userId)
    const vehicleRef = str(input?.vehicle)
    const vehicleId = vehicleRef ? await visibleVehicleId(admin, access, vehicleRef) : null
    const { data: u } = await (admin as any).auth.admin.getUserById(actor)
    // A deck PUT to deals_deck_upload_url's staging URL comes back as bytes, as the form's would.
    const staged = await readStagedUploads(admin, fundId, 'deal', input?.uploaded_files, { maxFiles: MAX_DEAL_FILES, maxBytes: MAX_DEAL_FILE_BYTES })
    const out = unwrap(await createManualDeal(admin, { fundId, userId: actor, userEmail: u?.user?.email ?? null, access }, {
      companyName: str(input?.company_name),
      founderName: str(input?.founder_name),
      founderEmail: str(input?.founder_email),
      pitch: str(input?.pitch),
      companyUrl: str(input?.company_url),
      introSource: str(input?.intro_source),
      referrerName: str(input?.referrer_name),
      referrerEmail: str(input?.referrer_email),
      vehicleId,
      files: [...parseUpdateFiles(input?.files), ...staged.map(f => ({ name: f.name, type: f.type, bytes: f.bytes }))],
    }))
    // Stored under the deal's email now: the staged copies are done with.
    await removeStaged(admin, staged.map(f => f.storagePath))
    const { data: deal } = out.dealId
      ? await (admin as any).from('inbound_deals').select('company_name, thesis_fit_score, status').eq('id', out.dealId).eq('fund_id', fundId).maybeSingle()
      : { data: null }
    return {
      dealId: out.dealId,
      company: deal?.company_name ?? str(input?.company_name),
      thesis_fit: deal?.thesis_fit_score ?? null,
      status: deal?.status ?? null,
      url: out.dealId ? `${(origin ?? '').replace(/\/$/, '')}/deals/${out.dealId}` : null,
      ...(out.analysed ? {} : {
        note: 'Saved without analysis: this fund has no server AI key. Read the fund\'s thesis and this pitch, then write the ' +
          'analysis with deals_update_inbound (company_summary, thesis_fit_analysis, thesis_fit_score, stage, industry, raise_amount).',
      }),
    }
  },

  deals_update_inbound: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveInboundDeal(admin, fundId, str(input?.deal), access)
    const vehicleRef = str(input?.vehicle)
    const assigned = typeof input?.assigned_to === 'string' ? input.assigned_to.trim() : undefined
    const out = unwrap(await updateInboundDeal(admin, access, deal.id, {
      status: input?.status,
      vehicleId: vehicleRef ? await visibleVehicleId(admin, access, vehicleRef) : undefined,
      assignedTo: assigned === undefined ? undefined : assigned === '' ? null : await fundMemberId(admin, fundId, assigned),
      analysis: {
        companySummary: input?.company_summary,
        thesisFitAnalysis: input?.thesis_fit_analysis,
        thesisFitScore: input?.thesis_fit_score,
        stage: input?.stage,
        industry: input?.industry,
        raiseAmount: input?.raise_amount,
      },
      research: input?.research && typeof input.research === 'object' ? input.research : undefined,
    }))
    return { dealId: deal.id, company: deal.company_name, updated: out.updated }
  },

  deals_research_inbound: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveInboundDeal(admin, fundId, str(input?.deal), access)
    const out = unwrap(await queueDealResearch(admin, fundId, deal.id))
    return { dealId: deal.id, company: deal.company_name, ...out, job: jobHandle('deal_research', deal.id, out.research_status) }
  },

  deals_research_status: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const ref = input?.job_id ? jobRecordId('deal_research', input.job_id) : str(input?.deal)
    const deal = await resolveInboundDeal(admin, fundId, ref, access)
    if (!deal.research_status) return { dealId: deal.id, company: deal.company_name, job: null, note: 'No research has been queued for this deal. Start it with deals_research_inbound.' }
    const job = jobHandle('deal_research', deal.id, deal.research_status)
    return {
      dealId: deal.id, company: deal.company_name, job,
      error: job.status === 'failed' ? deal.research_error ?? null : null,
      research: job.status === 'done' ? deal.research_output ?? null : null,
    }
  },

  deals_promote_to_diligence: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveInboundDeal(admin, fundId, str(input?.deal), access)
    const out = unwrap(await promoteInboundDeal(admin, { fundId, userId: requireUser(userId) }, deal.id))
    return { inboundDealId: deal.id, diligenceDealId: out.diligenceId, company: deal.company_name }
  },
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** A write records who made it; a credential with no person behind it cannot. */
export function requireUser(userId: string | null): string {
  if (!userId) throw new Error('This credential is not tied to a person, so it cannot make changes.')
  return userId
}
