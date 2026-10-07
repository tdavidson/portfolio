// Handlers for the DILIGENCE agent tools. Merged into the same registry the ledger and
// portfolio tools use, so one key and one endpoint reach the whole firm: what the books
// say, what the fund owns, and what it is currently evaluating.
//
// Everything here is READ-ONLY, and deliberately so. The diligence pipeline has real
// side effects — running ingest costs model spend, and the Q&A route writes into the
// partner's chat history AND promotes the exchange into the memo's evidence base. An
// agent asking questions must not do either, or every tool call would quietly graffiti
// the deal. `diligence_ask` therefore reuses the shared answer path (answerDealQuestion)
// and skips both writes.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { answerDealQuestion } from '@/lib/diligence/qa-answer'
import {
  buildStages, countChecklist, countDocuments, assessedCount,
  checklistCoverage, countAttention,
} from '@/lib/diligence/progress'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'

/**
 * Resolve a deal by id, name, or alias. Agents are handed names, not UUIDs — failing on a
 * name would make every tool here unusable in practice. But a name matching two deals must
 * never silently pick one, so ambiguity is an error with the candidates listed.
 */
async function resolveDeal(admin: SupabaseClient, fundId: string, ref: string, access: AccessContext): Promise<any> {
  if (!ref) throw new Error('A deal id or name is required')
  // Only records owned by one of the caller's entities (unassigned ones: unscoped callers only).
  const mine = (d: any) => canSeeVehicle(access, d.vehicle_id ?? null)

  const { data: byId } = await (admin as any)
    .from('diligence_deals').select('*').eq('fund_id', fundId).eq('id', ref).maybeSingle()
  if (byId && mine(byId)) return byId

  const { data: all } = await (admin as any)
    .from('diligence_deals').select('*').eq('fund_id', fundId)
  const rows = ((all as any[]) ?? []).filter(mine)
  const needle = ref.trim().toLowerCase()

  // Exact on name, then on any alias — `aliases` is text[] and exists precisely so a deal
  // can be found by the name the partner actually uses for it.
  const exact = rows.filter(d =>
    String(d.name ?? '').trim().toLowerCase() === needle ||
    (Array.isArray(d.aliases) && d.aliases.some((a: string) => String(a).trim().toLowerCase() === needle))
  )
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new Error(`"${ref}" matches ${exact.length} deals — pass the deal id instead.`)

  const near = rows.filter(d => String(d.name ?? '').toLowerCase().includes(needle))
  if (near.length === 1) return near[0]
  if (near.length > 1) {
    throw new Error(`"${ref}" matches several deals: ${near.slice(0, 5).map(d => d.name).join(', ')}. Pass the deal id.`)
  }
  throw new Error(
    rows.length > 0
      ? `No diligence deal named "${ref}". This fund has: ${rows.slice(0, 10).map(d => d.name).join(', ')}`
      : 'This fund has no deals in diligence yet.'
  )
}

/** The deal's latest memo draft — where every piece of extracted evidence actually lives. */
async function latestDraft(admin: SupabaseClient, fundId: string, dealId: string): Promise<any | null> {
  const { data } = await (admin as any)
    .from('diligence_memo_drafts')
    .select('id, draft_version, is_draft, finalized_at, created_at, ingestion_output, research_output, qa_answers, memo_draft_output')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export const DILIGENCE_HANDLERS: Record<string, AgentToolHandler> = {
  diligence_list_deals: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    let q = (admin as any)
      .from('diligence_deals')
      .select('id, name, sector, stage_at_consideration, deal_status, current_memo_stage, created_at')
      .eq('fund_id', fundId)
      .order('created_at', { ascending: false })
    // The caller's entities only (filtered for scoped callers; see deals-tools).
    const vehicleIds = visibleVehicleIds(access)
    if (vehicleIds !== null) q = q.in('vehicle_id', vehicleIds)
    if (input?.status) q = q.eq('deal_status', String(input.status))

    const { data } = await q
    let rows = ((data as any[]) ?? [])
    if (input?.q) {
      const needle = String(input.q).toLowerCase()
      rows = rows.filter(d =>
        String(d.name ?? '').toLowerCase().includes(needle) ||
        String(d.sector ?? '').toLowerCase().includes(needle)
      )
    }
    return rows.map(d => ({
      id: d.id,
      name: d.name,
      sector: d.sector,
      stage: d.stage_at_consideration,
      status: d.deal_status,
      memo_stage: d.current_memo_stage,
      created_at: d.created_at,
    }))
  },

  diligence_deal_detail: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)

    const [{ data: docs }, { data: items }, { data: attn }, draft] = await Promise.all([
      (admin as any).from('diligence_documents').select('parse_status').eq('deal_id', deal.id).eq('fund_id', fundId),
      (admin as any).from('diligence_checklist_items').select('status').eq('deal_id', deal.id).eq('fund_id', fundId).eq('kind', 'item'),
      (admin as any).from('diligence_attention_items').select('urgency, status').eq('deal_id', deal.id).eq('fund_id', fundId),
      latestDraft(admin, fundId, deal.id),
    ])

    const dataRoom = countDocuments(((docs as any[]) ?? []).map(d => ({ parse_status: d.parse_status })))
    const checklist = countChecklist(((items as any[]) ?? []).map(i => ({ status: i.status })))
    const coverage = checklistCoverage(checklist.counts)
    const attention = countAttention(((attn as any[]) ?? []).map(a => ({ urgency: a.urgency, status: a.status })))

    const scores: any[] = Array.isArray(draft?.memo_draft_output?.scores) ? draft.memo_draft_output.scores : []

    // Same progress model the UI renders, so an agent and a partner never disagree about
    // how far along a deal is.
    const stages = buildStages({
      hasIngestion: !!draft?.ingestion_output,
      hasResearch: !!draft?.research_output,
      hasMemoDraft: !!draft?.memo_draft_output,
      hasScores: scores.length > 0,
      finalized: !!draft?.finalized_at,
      documentCount: dataRoom.total,
      documentsHandled: dataRoom.counts.processed + dataRoom.counts.partial + dataRoom.counts.skipped,
      checklistAssessed: assessedCount(checklist.counts),
      checklistTotal: checklist.total,
      checklistCovered: coverage.covered,
      checklistApplicable: coverage.applicable,
      checklistGaps: coverage.gaps,
      scoredDimensions: scores.filter(s => s.score !== null || s.mode === 'partner_only').length,
      totalDimensions: scores.length,
      memoAttentionBlocking: attention.blocking,
      memoAttentionOpen: attention.open,
      memoAttentionTotal: attention.total,
      runningKind: null,
      failedKind: null,
    })

    return {
      id: deal.id,
      name: deal.name,
      aliases: deal.aliases ?? [],
      sector: deal.sector,
      stage: deal.stage_at_consideration,
      status: deal.deal_status,
      memo_stage: deal.current_memo_stage,
      notes_summary: deal.notes_summary,
      promoted_company_id: deal.promoted_company_id,
      documents: { total: dataRoom.total, ...dataRoom.counts },
      checklist: {
        total: checklist.total,
        ...checklist.counts,
        // Completeness, NOT assessment coverage: a `missing` item is assessed and is still
        // a hole in the deal.
        completeness: Math.round(coverage.fraction * 100) / 100,
        gaps: coverage.gaps,
      },
      attention: attention,
      progress: stages.map(s => ({ stage: s.key, state: s.state, percent: Math.round(s.progress * 100), note: s.hint })),
    }
  },

  diligence_ask: async ({ admin, fundId, userId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const question = String(input?.question ?? '').trim()
    if (!question) throw new Error('A question is required')

    const result = await answerDealQuestion({
      admin,
      fundId,
      dealId: deal.id,
      question,
      // The key's owner, so Affinity (if they've connected it) carries THEIR permissions.
      userId,
      feature: 'agent_diligence_ask',
    })

    const nameById = new Map(result.citableDocs.map(d => [d.id, d.file_name]))
    return {
      deal: deal.name,
      answer: result.answer,
      // Name the document, not just its id — a citation an agent can't resolve isn't one.
      citations: result.citations.map(c => ({
        document_id: c.document_id,
        document: nameById.get(c.document_id) ?? c.document_id,
        summary: c.summary,
      })),
      ...(result.affinityLookups.length > 0 ? { affinity_lookups: result.affinityLookups } : {}),
    }
  },

  diligence_checklist: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const { data } = await (admin as any)
      .from('diligence_checklist_items')
      .select('id, parent_id, kind, label, status, evidence, agent_notes, partner_notes, order_index')
      .eq('deal_id', deal.id)
      .eq('fund_id', fundId)
      .order('order_index', { ascending: true })

    const rows = ((data as any[]) ?? [])
    const sections = rows.filter(r => r.kind === 'section')
    let items = rows.filter(r => r.kind === 'item')
    const counts = countChecklist(items.map(i => ({ status: i.status })))
    const coverage = checklistCoverage(counts.counts)

    if (input?.status) items = items.filter(i => i.status === String(input.status))

    const sectionName = new Map(sections.map(s => [s.id, s.label]))
    return {
      deal: deal.name,
      summary: {
        total: counts.total,
        ...counts.counts,
        completeness: Math.round(coverage.fraction * 100) / 100,
        gaps: coverage.gaps,
      },
      items: items.map(i => ({
        id: i.id,
        section: sectionName.get(i.parent_id) ?? null,
        label: i.label,
        status: i.status,
        evidence: i.evidence ?? [],
        notes: i.agent_notes ?? i.partner_notes ?? null,
      })),
    }
  },

  diligence_list_documents: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const { data } = await (admin as any)
      .from('diligence_documents')
      .select('id, file_name, file_format, detected_type, type_confidence, parse_status, parse_notes, uploaded_at')
      .eq('deal_id', deal.id)
      .eq('fund_id', fundId)
      .order('uploaded_at', { ascending: false })

    // No extracted-text column exists — text is parsed transiently at ingest and thrown
    // away (and a PDF never has a text form at all; it goes to the model as base64). So
    // the honest thing to tell an agent is: the document's CONTENT is reachable through
    // diligence_ask / diligence_evidence, not from here.
    return {
      deal: deal.name,
      note: 'Document text is not stored. Use diligence_ask or diligence_evidence to reach what the documents actually say.',
      documents: ((data as any[]) ?? []).map(d => ({
        id: d.id,
        file_name: d.file_name,
        format: d.file_format,
        detected_type: d.detected_type,
        type_confidence: d.type_confidence,
        parse_status: d.parse_status,
        parse_notes: d.parse_notes,
        uploaded_at: d.uploaded_at,
      })),
    }
  },

  diligence_evidence: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const draft = await latestDraft(admin, fundId, deal.id)
    if (!draft || !draft.ingestion_output) {
      return {
        deal: deal.name,
        evidence: null,
        note: 'The data room has not been analyzed yet, so there is no extracted evidence. Run the data-room analysis first.',
      }
    }

    const include = String(input?.include ?? 'all')
    const want = (k: string) => include === 'all' || include === k

    const ingestion = draft.ingestion_output ?? {}
    const research = draft.research_output ?? null

    const out: Record<string, any> = { deal: deal.name }

    if (want('claims')) {
      out.documents = (ingestion.documents ?? []).map((d: any) => ({
        document_id: d.document_id,
        detected_type: d.detected_type,
        summary: d.summary,
        claims: (d.claims ?? []).map((c: any) => ({
          id: c.id, field: c.field, value: c.value, context: c.context, criticality: c.criticality,
        })),
      }))
    }
    if (want('research') && research) {
      out.research = {
        findings: research.findings ?? [],
        contradictions: research.contradictions ?? [],
        competitive_map: research.competitive_map ?? null,
      }
    }
    if (want('gaps')) {
      out.gaps = {
        ...(ingestion.gap_analysis ?? {}),
        cross_doc_flags: ingestion.cross_doc_flags ?? [],
        ...(research ? { research_gaps: research.research_gaps ?? [] } : {}),
      }
    }
    return out
  },

  diligence_memo: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const draft = await latestDraft(admin, fundId, deal.id)
    if (!draft || !draft.memo_draft_output) {
      return { deal: deal.name, memo: null, note: 'No memo has been drafted for this deal yet.' }
    }

    const { data: attn } = await (admin as any)
      .from('diligence_attention_items')
      .select('kind, urgency, body, status')
      .eq('deal_id', deal.id)
      .eq('fund_id', fundId)

    const memo = draft.memo_draft_output
    return {
      deal: deal.name,
      draft_version: draft.draft_version,
      finalized: !draft.is_draft,
      finalized_at: draft.finalized_at,
      paragraphs: (memo.paragraphs ?? [])
        .filter((p: any) => !p.hidden)
        .map((p: any) => ({
          section: p.section_id,
          prose: p.prose,
          origin: p.origin,
          confidence: p.confidence,
          flags: [
            p.contains_projection && 'projection',
            p.contains_unverified_claim && 'unverified',
            p.contains_contradiction && 'contradiction',
          ].filter(Boolean),
        })),
      scores: memo.scores ?? [],
      // Open items only — a finished memo is one with none of these left.
      open_attention: ((attn as any[]) ?? [])
        .filter(a => a.status === 'open')
        .map(a => ({ kind: a.kind, urgency: a.urgency, body: a.body })),
    }
  },
}
