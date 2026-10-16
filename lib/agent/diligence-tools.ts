// Handlers for the DILIGENCE agent tools. Merged into the same registry the ledger and
// portfolio tools use, so one key and one endpoint reach the whole firm: what the books
// say, what the fund owns, and what it is currently evaluating.
//
// The reads have no side effects, deliberately. The Q&A route writes into the partner's chat
// history AND promotes the exchange into the memo's evidence base; an agent asking questions must
// not do either, or every tool call would quietly graffiti the deal. `diligence_ask` therefore
// reuses the shared answer path (answerDealQuestion) and skips both writes.
//
// The writes are the Diligence page's own (lib/diligence/service.ts, lib/memo-agent/enqueue.ts),
// named for what they change. From a connected chat each is staged for the person to approve, so
// spending on the memo agent or editing the memo is always a decision someone confirmed.

import { fundHasAIKey, noKeyMessage } from '@/lib/ai/keyless'
import { extractText } from '@/lib/memo-agent/extract-text'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { answerDealQuestion } from '@/lib/diligence/qa-answer'
import {
  buildStages, countChecklist, countDocuments, assessedCount,
  checklistCoverage, countAttention,
} from '@/lib/diligence/progress'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { parseUpdateFiles } from '@/lib/company-updates/submit'
import {
  addChecklistItem, addDiligenceNote, createDiligenceDeal, finalizeMemo, updateAttentionItem, updateChecklistItem,
  registerUploadedDiligenceDocument, updateDiligenceDeal, uploadDiligenceDocument, writeMemoParagraph,
} from '@/lib/diligence/service'
import { enqueueMemoStage, MEMO_AGENT_STAGES, type MemoAgentStage } from '@/lib/memo-agent/enqueue'
import { advanceAssistantJobs, assistantCallAttachment, readAssistantCall, submitAssistantAnswers, waitingJobId } from '@/lib/memo-agent/assistant-jobs'
import { ASSISTANT_RUNNER } from '@/lib/memo-agent/assistant-runner'
import type { McpContentResult } from '@/lib/mcp-apps/server'
import { MAX_PAGE_IMAGE_BYTES, renderPdfPage } from '@/lib/pdf-page-image'
import { jobHandle, jobRecordId } from './jobs'
import { unwrap, type Outcome } from '@/lib/service-outcome'
import { contentTypeFor } from '@/lib/uploads/signed-upload'
import { requireUser } from './deals-tools'
import { fundMemberId, visibleVehicleId } from './refs'

/**
 * Resolve a deal by id, name, or alias. Agents are handed names, not UUIDs — failing on a
 * name would make every tool here unusable in practice. But a name matching two deals must
 * never silently pick one, so ambiguity is an error with the candidates listed.
 */
export async function resolveDeal(admin: SupabaseClient, fundId: string, ref: string, access: AccessContext): Promise<any> {
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

    const [{ data: docs }, { data: items }, { data: attn }, draft, { data: job }] = await Promise.all([
      (admin as any).from('diligence_documents').select('parse_status').eq('deal_id', deal.id).eq('fund_id', fundId),
      (admin as any).from('diligence_checklist_items').select('status').eq('deal_id', deal.id).eq('fund_id', fundId).eq('kind', 'item'),
      (admin as any).from('diligence_attention_items').select('urgency, status').eq('deal_id', deal.id).eq('fund_id', fundId),
      latestDraft(admin, fundId, deal.id),
      // The memo agent's latest job, as the deal page polls it (app/api/diligence/[id]/agent/status):
      // what diligence_run_agent started, and whether it is still going or failed.
      (admin as any).from('memo_agent_jobs')
        .select('id, kind, status, progress_message, error, enqueued_at, started_at, finished_at')
        .eq('deal_id', deal.id).eq('fund_id', fundId)
        .order('enqueued_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    const runningKind = job && (job.status === 'pending' || job.status === 'running') ? job.kind as string : null
    const failedKind = job && job.status === 'failed' ? job.kind as string : null
    // Memo PROSE, not merely a memo_draft_output: scoring parks its scores there without a memo.
    const hasMemo = Array.isArray(draft?.memo_draft_output?.paragraphs) && draft.memo_draft_output.paragraphs.length > 0

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
      hasMemoDraft: hasMemo,
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
      runningKind,
      failedKind,
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
      agent_job: job ? {
        id: job.id, kind: job.kind, status: job.status, progress: job.progress_message ?? null, error: job.error ?? null,
        enqueued_at: job.enqueued_at, started_at: job.started_at ?? null, finished_at: job.finished_at ?? null,
      } : null,
    }
  },

  diligence_ask: async ({ admin, fundId, userId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const question = String(input?.question ?? '').trim()
    if (!question) throw new Error('A question is required')
    if (!(await fundHasAIKey(admin, fundId))) throw new Error(noKeyMessage('diligence_qa', 'answer from the data room'))

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
      note: 'Read a document\'s text with diligence_document_text, or reach the extracted claims with diligence_evidence.',
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

  // Read on demand from the stored file: no text column exists (ingest parses transiently), and a
  // fund with no server AI key has no other way to put a document in front of a model.
  diligence_document_text: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, String(input?.deal ?? ''), access)
    const ref = String(input?.document ?? '').trim()
    if (!ref) throw new Error('Name the document: its id or file name, from diligence_list_documents.')
    const { data: docs } = await (admin as any)
      .from('diligence_documents')
      .select('id, file_name, file_format, storage_path')
      .eq('deal_id', deal.id)
      .eq('fund_id', fundId)
    const all = ((docs ?? []) as { id: string; file_name: string; file_format: string; storage_path: string }[])
    const doc = all.find(d => d.id === ref) ?? all.find(d => d.file_name.toLowerCase() === ref.toLowerCase())
    if (!doc) throw new Error(`No document "${ref}" in ${deal.name}'s data room.`)
    const { data: blob, error } = await (admin as any).storage.from('diligence-documents').download(doc.storage_path)
    if (error || !blob) throw new Error(`Could not open ${doc.file_name}.`)
    const text = (await extractText(Buffer.from(await blob.arrayBuffer()), doc.file_format ?? '')) ?? ''
    const offset = Math.max(0, Math.floor(Number(input?.offset) || 0))
    const max = Math.min(60_000, Math.max(2000, Math.floor(Number(input?.max_chars) || 30_000)))
    const slice = text.slice(offset, offset + max)
    return {
      deal: deal.name,
      document: doc.file_name,
      total_chars: text.length,
      offset,
      text: slice,
      ...(offset + slice.length < text.length ? { next_offset: offset + slice.length } : {}),
      ...(text ? {} : { note: 'No text could be read: a scanned PDF, an image, or an unsupported format. Do not guess at its contents.' }),
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
      .select('id, kind, urgency, body, status')
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
          id: p.id,
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
        .map(a => ({ id: a.id, kind: a.kind, urgency: a.urgency, body: a.body })),
    }
  },

  diligence_create_deal: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const vehicleRef = str(input?.vehicle)
    const lead = str(input?.lead_partner)
    const row = unwrap(await createDiligenceDeal(admin, { fundId, userId: requireUser(userId), access }, {
      name: input?.name,
      sector: input?.sector,
      stageAtConsideration: input?.stage,
      leadPartnerId: lead ? await fundMemberId(admin, fundId, lead) : undefined,
      driveFolderUrl: input?.drive_folder_url,
      vehicleId: vehicleRef ? await visibleVehicleId(admin, access, vehicleRef) : null,
    }))
    return { dealId: row.id, name: row.name, status: row.deal_status }
  },

  diligence_update_deal: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const vehicleRef = str(input?.vehicle)
    const lead = typeof input?.lead_partner === 'string' ? input.lead_partner.trim() : undefined
    const out = unwrap(await updateDiligenceDeal(admin, access, deal.id, {
      name: input?.name,
      sector: input?.sector,
      stageAtConsideration: input?.stage,
      dealStatus: input?.status,
      leadPartnerId: lead === undefined ? undefined : lead === '' ? null : await fundMemberId(admin, fundId, lead),
      vehicleId: vehicleRef ? await visibleVehicleId(admin, access, vehicleRef) : undefined,
    }))
    return { dealId: deal.id, deal: deal.name, updated: out.updated }
  },

  diligence_add_checklist_item: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const item = unwrap(await addChecklistItem(admin, fundId, deal.id, { label: input?.label, sectionLabel: input?.section }))
    return { deal: deal.name, itemId: item.id, label: item.label }
  },

  diligence_update_checklist_item: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const item = await resolveChecklistItem(admin, fundId, deal.id, str(input?.item))
    const fact = str(input?.add_fact)
    const updated = unwrap(await updateChecklistItem(admin, fundId, deal.id, item.id, {
      label: input?.label,
      status: input?.status,
      partnerNotes: input?.partner_notes,
      // Appended to the facts already there; the shared function keeps their ids.
      partnerFacts: fact ? [...(Array.isArray(item.partner_facts) ? item.partner_facts : []), { text: fact }] : undefined,
    }))
    return { deal: deal.name, itemId: updated.id, label: updated.label, status: updated.status }
  },

  diligence_add_note: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const note = unwrap(await addDiligenceNote(admin, { fundId, userId: requireUser(userId) }, deal.id, input?.body))
    return { deal: deal.name, noteId: note.id }
  },

  diligence_add_documents: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const files = parseUpdateFiles(input?.files)
    const uploaded = parseUploadedDocuments(input?.uploaded_files)
    if (files.length === 0 && uploaded.length === 0) throw new Error('Send at least one file (uploaded_files, or files).')
    const actor = requireUser(userId)
    const added: unknown[] = []
    const refused: string[] = []
    const record = (name: string, r: Outcome<Record<string, unknown>>) => {
      if (r.ok) added.push({ documentId: r.value.id, file: r.value.file_name, type: r.value.detected_type })
      else refused.push(`${name}: ${r.error}`)
    }
    for (const f of files) {
      record(f.name, await uploadDiligenceDocument(admin, { fundId, userId: actor }, deal.id, { name: f.name, mime: f.type, bytes: f.bytes }))
    }
    // PUT straight to the deal's folder (diligence_document_upload_url): registered as the browser's
    // signed-URL upload is, by the same function.
    for (const u of uploaded) {
      record(u.fileName ?? u.storagePath.split('/').pop() ?? 'file', await registerUploadedDiligenceDocument(admin, { fundId, userId: actor }, deal.id, u))
    }
    return {
      deal: deal.name, added, refused,
      next: added.length ? 'Run diligence_run_agent with stage "analyze" to read them into evidence.' : undefined,
    }
  },

  diligence_resolve_attention: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const itemId = str(input?.item)
    if (!itemId) throw new Error('item (the attention item id from diligence_memo) is required.')
    const { data: item } = await (admin as any)
      .from('diligence_attention_items').select('id, body').eq('id', itemId).eq('deal_id', deal.id).eq('fund_id', fundId).maybeSingle()
    if (!item) throw new Error(`No attention item ${itemId} on ${deal.name}.`)
    unwrap(await updateAttentionItem(admin, { fundId, userId: requireUser(userId) }, deal.id, item.id, {
      status: input?.status,
      resolutionNote: typeof input?.note === 'string' ? input.note : undefined,
    }))
    return { deal: deal.name, itemId: item.id, status: input?.status }
  },

  diligence_run_agent: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const stage = str(input?.stage) as MemoAgentStage
    if (!MEMO_AGENT_STAGES.includes(stage)) throw new Error(`stage must be one of ${MEMO_AGENT_STAGES.join(', ')}.`)
    const out = unwrap(await enqueueMemoStage(admin, { fundId, userId: requireUser(userId) }, deal.id, stage, { full: input?.full === true }))
    const awaitingAssistant = !!out.job_id && !(await fundHasAIKey(admin, fundId))
    return { deal: deal.name, stage, ...out, job: jobHandle('diligence', String(out.job_id), out.status as string, { awaitingAssistant }) }
  },

  diligence_stage_next: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    if (await fundHasAIKey(admin, fundId)) {
      return { deal: deal.name, state: 'server', next: 'This fund has a server AI key, so its memo-agent stages run on their own. Follow them with diligence_job_status.' }
    }
    return { deal: deal.name, ...(await advanceAssistantJobs(admin, fundId, deal.id)) }
  },

  diligence_stage_read: async ({ admin, fundId, access }: AgentToolContext, input: any): Promise<unknown> => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const jobId = await waitingJobId(admin, fundId, deal.id)
    if (input?.attachment !== undefined && input?.attachment !== null) {
      const callId = str(input?.call_id)
      if (!callId) throw new Error('call_id is required with attachment.')
      const a = await assistantCallAttachment(admin, fundId, jobId, callId, Number(input.attachment))
      let image: { data: string; mimeType: string; label: string }
      if (a.mediaType === 'application/pdf') {
        const page = Number(input?.page) || 1
        const { png, numPages } = await renderPdfPage(Buffer.from(a.data, 'base64'), page)
        image = { data: png.toString('base64'), mimeType: 'image/png', label: `Page ${page} of ${numPages}` }
      } else {
        image = { data: a.data, mimeType: a.mediaType, label: 'The image' }
      }
      if (image.data.length * 0.75 > MAX_PAGE_IMAGE_BYTES) throw new Error('That attachment is too large to hand over as an image.')
      const result: McpContentResult = {
        mcpContent: [
          { type: 'text', text: `${image.label} of attachment ${input.attachment} in call ${callId}.` },
          { type: 'image', data: image.data, mimeType: image.mimeType },
        ],
      }
      return result
    }
    return readAssistantCall(admin, fundId, {
      jobId,
      callId: str(input?.call_id) || undefined,
      systemId: str(input?.system_id) || undefined,
      offset: Number(input?.offset) || 0,
      maxChars: Number(input?.max_chars) || undefined,
    })
  },

  diligence_stage_submit: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const jobId = await waitingJobId(admin, fundId, deal.id)
    return { deal: deal.name, ...(await submitAssistantAnswers(admin, fundId, jobId, input?.answers)) }
  },

  diligence_job_status: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const cols = 'id, deal_id, kind, status, progress_message, error, enqueued_at, started_at, finished_at, external_job_id'
    const view = (j: any) => ({
      ...jobHandle('diligence', j.id, j.status, { awaitingAssistant: j.status === 'running' && j.external_job_id === ASSISTANT_RUNNER }), stage: j.kind, raw_status: j.status, progress: j.progress_message ?? null, error: j.error ?? null,
      enqueued_at: j.enqueued_at, started_at: j.started_at ?? null, finished_at: j.finished_at ?? null,
    })
    if (input?.job_id) {
      const id = jobRecordId('diligence', input.job_id)
      const { data: job } = await (admin as any).from('memo_agent_jobs').select(cols).eq('id', id).eq('fund_id', fundId).maybeSingle()
      // The deal's own scope: a job on another entity's deal is not found, like the deal.
      const deal = job ? await resolveDeal(admin, fundId, job.deal_id, access).catch(() => null) : null
      if (!job || !deal) throw new Error('No diligence job with that id.')
      return { deal: deal.name, job: view(job) }
    }
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const { data } = await (admin as any).from('memo_agent_jobs').select(cols).eq('deal_id', deal.id).eq('fund_id', fundId)
      .order('enqueued_at', { ascending: false }).limit(5)
    return { deal: deal.name, jobs: ((data ?? []) as any[]).map(view) }
  },

  diligence_write_memo: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const out = unwrap(await writeMemoParagraph(admin, fundId, deal.id, {
      paragraphId: input?.paragraph_id, section: input?.section, prose: input?.prose,
    }))
    return { deal: deal.name, ...out }
  },

  diligence_finalize_memo: async ({ admin, fundId, access, userId }: AgentToolContext, input: any) => {
    const deal = await resolveDeal(admin, fundId, str(input?.deal), access)
    const out = unwrap(await finalizeMemo(admin, { fundId, userId: requireUser(userId) }, deal.id))
    return { deal: deal.name, finalized: true, draftId: out.draftId }
  },
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The uploaded_files of a data-room upload, as registerUploadedDiligenceDocument takes them. */
function parseUploadedDocuments(v: unknown): { storagePath: string; fileName: string | null; contentType: string | null }[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new Error('uploaded_files must be a list of { storage_path, filename }.')
  if (v.length > 20) throw new Error('At most 20 uploaded files per call.')
  return v.map((u: any) => {
    const storagePath = str(u?.storage_path)
    if (!storagePath) throw new Error('Each uploaded file needs its storage_path (from diligence_document_upload_url).')
    const fileName = str(u?.filename) || null
    return { storagePath, fileName, contentType: str(u?.content_type) || (fileName ? contentTypeFor(fileName) : null) }
  })
}

/** A checklist item by id, or by its exact label when that names one item. */
async function resolveChecklistItem(admin: SupabaseClient, fundId: string, dealId: string, ref: string): Promise<any> {
  if (!ref) throw new Error('item (an id or label from diligence_checklist) is required.')
  const { data } = await (admin as any)
    .from('diligence_checklist_items').select('id, label, partner_facts').eq('deal_id', dealId).eq('fund_id', fundId).eq('kind', 'item')
  const rows = ((data ?? []) as any[])
  const byId = rows.find(r => r.id === ref)
  if (byId) return byId
  const byLabel = rows.filter(r => String(r.label).trim().toLowerCase() === ref.toLowerCase())
  if (byLabel.length === 1) return byLabel[0]
  throw new Error(byLabel.length > 1
    ? `"${ref}" matches ${byLabel.length} checklist items. Pass the item id from diligence_checklist.`
    : `No checklist item "${ref}" on this deal. Find it with diligence_checklist.`)
}
