// Diligence writes, shared by the web routes (app/api/diligence/**) and the agent tools
// (lib/agent/diligence-tools.ts): the deal room, its checklist, notes, attention queue, data room
// and memo. A change made from chat goes through exactly the checks and steps the Diligence page's.
//
// The caller has already decided the person may write diligence (the route gate, or the tool's
// domain) and that they can see the deal (the tools resolve it with their access). What is checked
// here is the entity a deal is put on, and every query is scoped to the fund.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { checkDealEntity } from '@/lib/deals/service'
import { safeWebUrl } from '@/lib/deals/submission-validation'
import { seedDealChecklistFromFundDefault } from './seed-checklist'
import { classifyDocumentHeuristic } from '@/lib/memo-agent/heuristic-classify'
import { scanFileAsync } from '@/lib/security/scan-file'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

// 'invested' is the current label for a closed/won deal; 'won'/'lost'/'on_hold' are retained for
// back-compat with rows written before the relabel.
export const DILIGENCE_DEAL_STATUSES = ['invested', 'active', 'passed', 'won', 'lost', 'on_hold'] as const
export const MEMO_STAGES = ['not_started', 'ingest', 'research', 'qa', 'draft', 'score', 'render', 'finalized'] as const
export const CHECKLIST_STATUSES = ['unknown', 'found', 'partial', 'missing', 'not_applicable'] as const
export const ATTENTION_STATUSES = ['open', 'ignore', 'done'] as const

const DEAL_COLUMNS = 'id, name, sector, stage_at_consideration, deal_status, current_memo_stage, lead_partner_id, created_at, updated_at'

export interface NewDiligenceDeal {
  name: unknown
  sector?: unknown
  stageAtConsideration?: unknown
  leadPartnerId?: unknown
  driveFolderUrl?: unknown
  vehicleId: string | null
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * A new deal room: its checklist seeded from the fund's template, and the fund's memo preset for
 * its stage applied. Both are best-effort, so a hiccup in either never fails the create.
 */
export async function createDiligenceDeal(
  admin: SupabaseClient, ctx: { fundId: string; userId: string; access: AccessContext }, input: NewDiligenceDeal,
): Promise<Outcome<Record<string, unknown>>> {
  const { fundId } = ctx
  const name = text(input.name)
  if (!name) return fail(400, 'name is required')

  const insert: Record<string, unknown> = { fund_id: fundId, name, created_by: ctx.userId }
  if (text(input.sector)) insert.sector = text(input.sector)
  if (text(input.stageAtConsideration)) insert.stage_at_consideration = text(input.stageAtConsideration)
  if (typeof input.leadPartnerId === 'string' && input.leadPartnerId) insert.lead_partner_id = input.leadPartnerId
  if (text(input.driveFolderUrl)) {
    // Only http(s): a `javascript:` or `data:` URL would fire wherever it is rendered as a link.
    const safe = safeWebUrl(text(input.driveFolderUrl))
    if (!safe) return fail(400, 'drive_folder_url must be a valid http(s) URL')
    insert.drive_folder_url = safe
  }

  // A member must choose one of their entities (an unassigned record is admin-only).
  const entity = await checkDealEntity(admin, ctx.access, input.vehicleId)
  if (!entity.ok) return entity
  if (input.vehicleId) insert.vehicle_id = input.vehicleId

  const db = admin as any
  const { data, error } = await db.from('diligence_deals').insert(insert).select(DEAL_COLUMNS).single()
  if (error || !data) return dbFail(error, 'diligence-deals-create')
  const dealId = (data as { id: string }).id

  await seedDealChecklistFromFundDefault({ admin, fundId, dealId })

  const stage = (data as any).stage_at_consideration as string | null
  if (stage) {
    try {
      const { data: preset } = await db
        .from('fund_memo_presets')
        .select('partner_memo_guidance, memo_template_config')
        .eq('fund_id', fundId)
        .eq('default_for_stage', stage)
        .maybeSingle()
      if (preset) {
        await db
          .from('diligence_deals')
          .update({ partner_memo_guidance: preset.partner_memo_guidance ?? '', memo_template_config: preset.memo_template_config ?? {} })
          .eq('id', dealId)
          .eq('fund_id', fundId)
      }
    } catch {
      // The partner can apply a preset from the Memo tab.
    }
  }
  return done(data as Record<string, unknown>)
}

export interface DiligenceDealChanges {
  name?: unknown
  sector?: unknown
  stageAtConsideration?: unknown
  leadPartnerId?: string | null
  dealStatus?: unknown
  memoStage?: unknown
  /** undefined: unchanged. null: unassigned (admins only). */
  vehicleId?: string | null
}

export async function updateDiligenceDeal(
  admin: SupabaseClient, access: AccessContext, dealId: string, changes: DiligenceDealChanges,
): Promise<Outcome<{ updated: string[] }>> {
  const updates: Record<string, unknown> = {}
  if (text(changes.name)) updates.name = text(changes.name)
  if (typeof changes.sector === 'string') updates.sector = changes.sector.trim() || null
  if (typeof changes.stageAtConsideration === 'string') updates.stage_at_consideration = changes.stageAtConsideration.trim() || null
  if (changes.leadPartnerId !== undefined) updates.lead_partner_id = changes.leadPartnerId
  if (typeof changes.dealStatus === 'string') {
    if (!(DILIGENCE_DEAL_STATUSES as readonly string[]).includes(changes.dealStatus)) return fail(400, 'Invalid deal_status')
    updates.deal_status = changes.dealStatus
  }
  if (typeof changes.memoStage === 'string') {
    if (!(MEMO_STAGES as readonly string[]).includes(changes.memoStage)) return fail(400, 'Invalid current_memo_stage')
    updates.current_memo_stage = changes.memoStage
  }
  // The caller can see this record; the new entity must be theirs too, and the fund's.
  if (changes.vehicleId !== undefined) {
    const entity = await checkDealEntity(admin, access, changes.vehicleId)
    if (!entity.ok) return entity
    updates.vehicle_id = changes.vehicleId
  }
  if (Object.keys(updates).length === 0) return fail(400, 'No fields to update')

  const { error } = await (admin as any).from('diligence_deals').update(updates).eq('id', dealId).eq('fund_id', access.fundId)
  if (error) return dbFail(error, 'diligence-deal-update')
  return done({ updated: Object.keys(updates) })
}

/** The tables a deal room's delete takes with it (ON DELETE CASCADE on deal_id). */
export const DILIGENCE_CASCADE_TABLES = [
  'diligence_documents', 'diligence_memo_drafts', 'diligence_notes', 'diligence_attention_items',
  'diligence_checklist_items', 'diligence_agent_sessions', 'diligence_qa_chats', 'diligence_call_transcripts', 'memo_agent_jobs',
] as const

/**
 * Delete a deal room. Admin-only on every surface (the route's own admin check; the
 * `diligence_delete_deal` tool through lib/access/admin-only.ts). ON DELETE CASCADE handles
 * documents, drafts, attention items, sessions, notes. Storage objects under {dealId}/* will
 * dangle; cleaning them is async (TODO).
 */
export async function deleteDiligenceDeal(admin: SupabaseClient, fundId: string, dealId: string): Promise<Outcome<{ ok: true }>> {
  const { error } = await (admin as any).from('diligence_deals').delete().eq('id', dealId).eq('fund_id', fundId)
  if (error) return dbFail(error, 'diligence-deal-delete')
  return done({ ok: true })
}

/** One partner-added checklist item, under a section found by name or created for it. */
export async function addChecklistItem(
  admin: SupabaseClient, fundId: string, dealId: string, input: { label: unknown; sectionLabel?: unknown },
): Promise<Outcome<Record<string, unknown>>> {
  const label = text(input.label)
  if (!label) return fail(400, 'label is required')
  const sectionLabel = text(input.sectionLabel)
  const db = admin as any

  const { data: existing } = await db.from('diligence_checklist_items').select('id, kind, label, order_index').eq('deal_id', dealId).eq('fund_id', fundId)
  const rows = (existing ?? []) as Array<{ id: string; kind: string; label: string; order_index: number }>
  let maxOrder = rows.reduce((m, r) => Math.max(m, r.order_index), 0)

  let parentId: string | null = null
  if (sectionLabel) {
    const match = rows.find(r => r.kind === 'section' && r.label.toLowerCase() === sectionLabel.toLowerCase())
    if (match) {
      parentId = match.id
    } else {
      const { data: section, error: secErr } = await db
        .from('diligence_checklist_items')
        .insert({ deal_id: dealId, fund_id: fundId, parent_id: null, kind: 'section', label: sectionLabel, order_index: maxOrder + 1, source: 'partner_added' })
        .select('id, order_index')
        .single()
      if (secErr || !section) return dbFail(secErr, 'diligence-checklist-add-parent-section')
      parentId = section.id as string
      maxOrder = section.order_index as number
    }
  }

  const { data: item, error } = await db
    .from('diligence_checklist_items')
    .insert({ deal_id: dealId, fund_id: fundId, parent_id: parentId, kind: 'item', label, order_index: maxOrder + 1, source: 'partner_added' })
    .select('*')
    .single()
  if (error || !item) return dbFail(error, 'diligence-checklist-add-item')
  return done(item as Record<string, unknown>)
}

export interface ChecklistItemChanges {
  label?: unknown
  status?: unknown
  agentNotes?: unknown
  partnerNotes?: unknown
  partnerFacts?: unknown
}

/** Partial update to one checklist item: its label, status, notes, or the partner's facts. */
export async function updateChecklistItem(
  admin: SupabaseClient, fundId: string, dealId: string, itemId: string, changes: ChecklistItemChanges,
): Promise<Outcome<Record<string, unknown>>> {
  if (!itemId) return fail(400, 'itemId is required')
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof changes.label === 'string') patch.label = changes.label.trim()
  if (typeof changes.status === 'string') {
    if (!(CHECKLIST_STATUSES as readonly string[]).includes(changes.status)) return fail(400, 'Invalid status')
    patch.status = changes.status
  }
  if (typeof changes.agentNotes === 'string') patch.agent_notes = changes.agentNotes
  if (typeof changes.partnerNotes === 'string') patch.partner_notes = changes.partnerNotes
  if (Array.isArray(changes.partnerFacts)) {
    patch.partner_facts = (changes.partnerFacts as unknown[])
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as any).text === 'string')
      .map(f => ({
        id: typeof f.id === 'string' && f.id ? f.id : `fact_${Math.random().toString(36).slice(2, 9)}`,
        text: (f.text as string).trim().slice(0, 1000),
      }))
      .filter(f => f.text.length > 0)
      .slice(0, 50)
  }

  const { data, error } = await (admin as any)
    .from('diligence_checklist_items')
    .update(patch)
    .eq('id', itemId)
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .select('*')
    .single()
  if (error || !data) return dbFail(error, 'diligence-checklist-item-update')
  return done(data as Record<string, unknown>)
}

export async function addDiligenceNote(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, dealId: string, body: unknown,
): Promise<Outcome<{ id: string; deal_id: string; body: string; author_id: string; created_at: string; updated_at: string }>> {
  const noteBody = text(body)
  if (!noteBody) return fail(400, 'body is required')
  const { data, error } = await (admin as any)
    .from('diligence_notes')
    .insert({ deal_id: dealId, fund_id: ctx.fundId, body: noteBody, author_id: ctx.userId })
    .select('id, deal_id, body, author_id, created_at, updated_at')
    .single()
  if (error || !data) return dbFail(error, 'diligence-notes-create')
  return done(data)
}

/** Resolve, dismiss or reopen an item in the deal's attention queue. */
export async function updateAttentionItem(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, dealId: string, itemId: string,
  changes: { status?: unknown; resolutionNote?: unknown },
): Promise<Outcome<null>> {
  const updates: Record<string, unknown> = {}
  if (typeof changes.status === 'string') {
    if (!(ATTENTION_STATUSES as readonly string[]).includes(changes.status)) return fail(400, 'Invalid status')
    updates.status = changes.status
    const resolved = changes.status !== 'open'
    updates.resolved_at = resolved ? new Date().toISOString() : null
    updates.resolved_by = resolved ? ctx.userId : null
  }
  if (typeof changes.resolutionNote === 'string' || changes.resolutionNote === null) {
    updates.resolution_note = (changes.resolutionNote as string | null)?.trim() || null
  }
  if (Object.keys(updates).length === 0) return fail(400, 'Nothing to update')

  const { error } = await (admin as any)
    .from('diligence_attention_items')
    .update(updates)
    .eq('id', itemId)
    .eq('deal_id', dealId)
    .eq('fund_id', ctx.fundId)
  if (error) return dbFail(error, 'diligence-attention-update')
  return done(null)
}

export const DOCUMENT_COLUMNS = 'id, deal_id, file_name, file_format, file_size_bytes, detected_type, type_confidence, parse_status, uploaded_at'

export function safeDocumentName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 200)
}

/**
 * A file already in the deal's storage folder, made a data-room document: scanned (and removed if
 * unsafe, so it never reaches the pipeline), classified, recorded, and a recording queued for
 * transcription. Every way a document arrives ends here.
 */
export async function recordDiligenceDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  dealId: string,
  file: { storagePath: string; name: string; mime: string; size: number; bytes: Buffer },
): Promise<Outcome<Record<string, unknown>>> {
  const db = admin as any
  const remove = () => db.storage.from('diligence-documents').remove([file.storagePath]).catch(() => {})
  const scan = await scanFileAsync(file.bytes, file.name, file.mime)
  if (!scan.safe) {
    await remove()
    return fail(400, 'That file could not be accepted.')
  }

  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'bin').toLowerCase()
  const { detected_type, confidence } = classifyDocumentHeuristic(file.name, file.mime)
  const { data: row, error } = await db
    .from('diligence_documents')
    .insert({
      deal_id: dealId,
      fund_id: ctx.fundId,
      storage_path: file.storagePath,
      file_name: file.name,
      file_format: ext,
      file_size_bytes: file.size,
      detected_type,
      type_confidence: confidence,
      parse_status: 'pending',
      uploaded_by: ctx.userId,
    })
    .select(DOCUMENT_COLUMNS)
    .single()
  if (error || !row) {
    await remove()
    return dbFail(error ?? { message: 'Insert failed' }, 'diligence-documents-insert')
  }

  // A recording needs transcribing before it can be ingested, unless a job is already running.
  if (detected_type === 'call_recording') {
    const { data: activeJob } = await db
      .from('memo_agent_jobs')
      .select('id')
      .eq('deal_id', dealId)
      .eq('fund_id', ctx.fundId)
      .in('status', ['pending', 'running'])
      .limit(1)
      .maybeSingle()
    if (!activeJob) {
      await db.from('memo_agent_jobs').insert({
        fund_id: ctx.fundId, deal_id: dealId, kind: 'transcribe', payload: { document_id: row.id }, enqueued_by: ctx.userId,
      })
    }
  }
  return done(row as Record<string, unknown>)
}

/** The data room's bucket caps an object at 100 MB. */
export const MAX_DILIGENCE_DOCUMENT_BYTES = 100 * 1024 * 1024

/** Where a new file for this deal goes: inside the deal's folder, at a path the server picks. */
export function diligenceUploadPath(dealId: string, rawName: string): string {
  return `${dealId}/${Date.now()}_${safeDocumentName(rawName)}`
}

/**
 * A signed URL to upload one file straight into the deal's folder (POST .../documents/upload-url,
 * and `diligence_document_upload_url` from chat). The caller has checked the deal is the fund's.
 */
export async function createDiligenceUploadUrl(
  admin: SupabaseClient, dealId: string, rawName: string,
): Promise<Outcome<{ storagePath: string; token: string; signedUrl: string }>> {
  if (!rawName) return fail(400, 'file_name is required')
  const storagePath = diligenceUploadPath(dealId, rawName)
  const { data, error } = await (admin as any).storage.from('diligence-documents').createSignedUploadUrl(storagePath)
  if (error || !data) return fail(500, error?.message ?? 'Failed to create upload URL')
  return done({ storagePath, token: data.token as string, signedUrl: data.signedUrl as string })
}

/**
 * A file already PUT to a signed URL in the deal's folder, made a data-room document: the path is
 * re-checked to be inside the deal, the object must exist (and be under the bucket cap), and its
 * bytes are read back so recordDiligenceDocument can scan them. The browser's JSON registration
 * (POST .../documents with storage_path) and `diligence_add_documents` with uploaded files both end here.
 */
export async function registerUploadedDiligenceDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  dealId: string,
  file: { storagePath: string; fileName?: string | null; contentType?: string | null },
): Promise<Outcome<Record<string, unknown>>> {
  const db = admin as any
  const storagePath = file.storagePath
  // The upload URL was minted inside this deal's folder, but re-check: the caller sends the path.
  if (!storagePath.startsWith(`${dealId}/`) || storagePath.includes('..')) return fail(400, 'storage_path outside deal folder')
  const name = safeDocumentName(file.fileName || (storagePath.split('/').pop() ?? ''))
  const mime = file.contentType || 'application/octet-stream'

  // The object must exist: the client could register before (or without) finishing the upload.
  const folder = storagePath.split('/').slice(0, -1).join('/')
  const fileBase = storagePath.split('/').pop()
  const { data: listing, error: listErr } = await db.storage
    .from('diligence-documents')
    .list(folder, { search: fileBase ?? undefined, limit: 1 })
  if (listErr || !listing || listing.length === 0) return fail(400, 'Uploaded file not found in storage')
  const size = (listing[0] as any).metadata?.size ?? 0
  if (size === 0) return fail(400, 'Empty file')
  if (size > MAX_DILIGENCE_DOCUMENT_BYTES) {
    // Defensive: the bucket already enforces 100 MB.
    await db.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
    return fail(400, 'File exceeds 100 MB limit')
  }

  // Pushed straight to the bucket, so the bytes come back here to be scanned before the row exists.
  const { data: blob, error: dlErr } = await db.storage.from('diligence-documents').download(storagePath)
  if (dlErr || !blob) {
    await db.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
    return fail(400, 'Uploaded file could not be read for scanning.')
  }
  const bytes = Buffer.from(await blob.arrayBuffer())
  return recordDiligenceDocument(admin, ctx, dealId, { storagePath, name, mime, size, bytes })
}

/** Store bytes the server already holds in the deal's folder, then record them. */
export async function uploadDiligenceDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  dealId: string,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<Outcome<Record<string, unknown>>> {
  if (file.bytes.length === 0) return fail(400, 'Empty file')
  const name = safeDocumentName(file.name)
  const storagePath = `${dealId}/${Date.now()}_${name}`
  const { error } = await (admin as any).storage
    .from('diligence-documents')
    .upload(storagePath, file.bytes, { contentType: file.mime, upsert: false })
  if (error) {
    console.error('[diligence-documents] upload', error.message)
    return fail(500, 'Upload failed.')
  }
  return recordDiligenceDocument(admin, ctx, dealId, { storagePath, name, mime: file.mime, size: file.bytes.length, bytes: file.bytes })
}

/** The deal's current memo draft (not finalized), if there is one. */
async function currentDraft(admin: SupabaseClient, fundId: string, dealId: string, draftId?: string) {
  let q = (admin as any)
    .from('diligence_memo_drafts')
    .select('id, memo_draft_output, is_draft')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
  q = draftId ? q.eq('id', draftId) : q.order('created_at', { ascending: false }).limit(1)
  const { data } = await q.maybeSingle()
  return data as { id: string; memo_draft_output: any; is_draft: boolean } | null
}

/**
 * Finalize a memo draft (admin-only, on every surface). The recommendation is the partner's to
 * write, so a draft whose recommendation is still the placeholder is refused.
 */
export async function finalizeMemo(
  admin: SupabaseClient, ctx: { fundId: string; userId: string }, dealId: string, draftId?: string,
): Promise<Outcome<{ draftId: string }>> {
  const row = await currentDraft(admin, ctx.fundId, dealId, draftId)
  if (!row) return fail(404, draftId ? 'Not found' : 'This deal has no memo draft yet.')
  if (!row.is_draft) return fail(409, 'Already finalized')

  const memo = row.memo_draft_output as { paragraphs?: Array<{ section_id: string; prose: string; origin: string }> } | null
  const recommendation = memo?.paragraphs?.find(p => p.section_id === 'recommendation')
  if (!recommendation || isPlaceholder(recommendation)) {
    return fail(422, 'Recommendation section is empty. The partner must complete this before finalizing.')
  }

  const db = admin as any
  const { error } = await db
    .from('diligence_memo_drafts')
    .update({ is_draft: false, finalized_at: new Date().toISOString(), finalized_by: ctx.userId })
    .eq('id', row.id)
    .eq('fund_id', ctx.fundId)
  if (error) return dbFail(error, 'diligence-draft-finalize')
  await db.from('diligence_deals').update({ current_memo_stage: 'finalized' }).eq('id', dealId).eq('fund_id', ctx.fundId)
  return done({ draftId: row.id })
}

function isPlaceholder(p: { prose: string; origin: string }): boolean {
  return p.prose.trim() === '[Partner to complete]' || p.origin === 'partner_only_placeholder'
}

/**
 * A partner's words in the current memo draft: rewrite one paragraph by id, or add one to a
 * section. Adding to a section whose only paragraph is the partner placeholder (the recommendation)
 * fills the placeholder in, since that is what finalizing checks.
 */
export async function writeMemoParagraph(
  admin: SupabaseClient, fundId: string, dealId: string,
  input: { paragraphId?: unknown; section?: unknown; prose: unknown },
): Promise<Outcome<{ draftId: string; paragraphId: string; section: string; action: 'edited' | 'added' }>> {
  const prose = text(input.prose)
  if (!prose) return fail(400, 'prose is required')
  const row = await currentDraft(admin, fundId, dealId)
  if (!row || !row.memo_draft_output) return fail(404, 'This deal has no memo draft yet. Draft the memo first.')
  if (!row.is_draft) return fail(409, 'Draft is finalized, edits are locked.')

  const memo = { ...row.memo_draft_output, paragraphs: [...(row.memo_draft_output.paragraphs ?? [])] }
  const paragraphId = text(input.paragraphId)
  const section = text(input.section)
  let target: { index: number; action: 'edited' | 'added' }

  if (paragraphId) {
    const index = memo.paragraphs.findIndex((p: any) => p.id === paragraphId)
    if (index < 0) return fail(404, `No paragraph ${paragraphId} in the current draft.`)
    target = { index, action: 'edited' }
  } else if (section) {
    const placeholder = memo.paragraphs.findIndex((p: any) => p.section_id === section && isPlaceholder(p))
    if (placeholder >= 0) {
      target = { index: placeholder, action: 'edited' }
    } else {
      const order = memo.paragraphs.filter((p: any) => p.section_id === section).reduce((m: number, p: any) => Math.max(m, Number(p.order) || 0), 0) + 1
      memo.paragraphs.push({
        id: `p_partner_${Math.random().toString(36).slice(2, 10)}`,
        section_id: section, order, prose: '', sources: [], origin: 'partner_drafted', confidence: 'n/a',
        contains_projection: false, contains_unverified_claim: false, contains_contradiction: false, hidden: false,
      })
      target = { index: memo.paragraphs.length - 1, action: 'added' }
    }
  } else {
    return fail(400, 'Name the paragraph_id to rewrite, or the section to add to.')
  }

  const p = memo.paragraphs[target.index]
  memo.paragraphs[target.index] = { ...p, prose, origin: target.action === 'added' ? 'partner_drafted' : 'partner_edited', hidden: false }
  const { error } = await (admin as any)
    .from('diligence_memo_drafts')
    .update({ memo_draft_output: memo })
    .eq('id', row.id)
    .eq('fund_id', fundId)
  if (error) return dbFail(error, 'diligence-draft-update')
  return done({ draftId: row.id, paragraphId: p.id, section: p.section_id, action: target.action })
}
