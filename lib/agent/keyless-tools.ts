// Handlers for the keyless tools (./keyless-tools-manifest.ts). Fund-scoped by the caller's fund, and
// company-scoped like company_update_status: a member who sees only some entities sees only the
// updates filed under their companies, and an unfiled one only if they see every company.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import type { AccessContext } from '@/lib/access/effective'
import { visibleCompanyIds } from '@/lib/access/scope'
import { AWAITING_ASSISTANT, isAwaitingAssistant } from '@/lib/ai/keyless'
import { extractAttachmentText, hydrateAttachments, type PostmarkPayload } from '@/lib/parsing/extractAttachmentText'
import { captureCompanyUpdate } from '@/lib/company-updates/capture'
import { kickCron } from '@/lib/cron/kick'
import { AWAITING_ASSISTANT_OCR, loadArtifactBytes, ocrOneArtifact, suppliedTextEngine, type ClaimedArtifact } from '@/lib/company-updates/ocr'
import type { McpContentResult } from '@/lib/mcp-apps/server'
import { logActivity } from '@/lib/activity'
import { MAX_PAGE_IMAGE_BYTES, renderPdfPage } from '@/lib/pdf-page-image'

/** An image handed to the caller's model stays well under what a host accepts in one result. */

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

async function waitingEmail(admin: SupabaseClient, fundId: string, access: AccessContext, id: string) {
  const { data: email } = await (admin as any)
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, company_id, processing_status, processing_error, raw_payload')
    .eq('id', id)
    .eq('fund_id', fundId)
    .maybeSingle()
  const visible = await visibleCompanyIds(admin, access)
  const seen = !!email && (visible === null || (!!email.company_id && visible.includes(email.company_id)))
  if (!seen || email.processing_status !== 'pending' || !isAwaitingAssistant(email.processing_error)) {
    throw new Error('No waiting update with that id. inbox_waiting lists them.')
  }
  return email
}

const ARTIFACT_COLUMNS = 'id, fund_id, company_id, update_id, ordinal, attachment_key, filename, detected_content_type, declared_content_type, storage_path, ocr_attempts, ocr_status, metadata'

/** A scanned artifact waiting for OCR that this caller may see. */
async function waitingArtifact(admin: SupabaseClient, fundId: string, access: AccessContext, id: string) {
  const { data: artifact } = await (admin as any)
    .from('company_update_artifacts').select(ARTIFACT_COLUMNS).eq('id', id).eq('fund_id', fundId).maybeSingle()
  const visible = await visibleCompanyIds(admin, access)
  if (!artifact || artifact.ocr_status !== 'pending' || (visible !== null && !visible.includes(artifact.company_id))) {
    throw new Error('No scan waiting with that id. ocr_waiting lists them.')
  }
  return artifact as ClaimedArtifact & { company_id: string; ocr_status: string }
}

const typeOf = (a: { detected_content_type: string | null; declared_content_type: string | null }) =>
  a.detected_content_type ?? a.declared_content_type ?? ''

export const KEYLESS_HANDLERS: Record<string, AgentToolHandler> = {
  company_save_summary: async ({ admin, fundId, userId, access }: AgentToolContext, input: any) => {
    const { resolveCompany } = await import('./portfolio-tools')
    const company = await resolveCompany(admin, fundId, String(input?.company ?? ''), access)
    const summary = typeof input?.summary === 'string' ? input.summary.trim().slice(0, 20_000) : ''
    if (!summary) throw new Error('summary is required.')
    const period = typeof input?.period === 'string' && input.period.trim() ? input.period.trim().slice(0, 50) : null
    // The same row the web app's Summarise button and the Analyst's "save as summary" write.
    const { error } = await (admin as any).from('company_summaries').insert({
      company_id: company.id, fund_id: fundId, period_label: period, summary_text: summary,
    })
    if (error) throw new Error('Could not save the summary.')
    if (userId) logActivity(admin as any, fundId, userId, 'company.summary', { companyId: company.id, source: 'assistant' })
    return { company: company.name, period, saved: true }
  },

  ocr_waiting: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const visible = await visibleCompanyIds(admin, access)
    let q = (admin as any)
      .from('company_update_artifacts')
      .select('id, filename, detected_content_type, declared_content_type, metadata, ocr_error, companies(name), company_updates(subject, received_at)')
      .eq('fund_id', fundId)
      .eq('ocr_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(clamp(input?.limit, 1, 50, 20))
    if (visible !== null) q = q.in('company_id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
    const { data, error } = await q
    if (error) throw new Error('Could not read the scans waiting for OCR.')
    const one = (v: any) => (Array.isArray(v) ? v[0] : v)
    return {
      waiting: ((data ?? []) as any[]).map(a => ({
        artifact: a.id,
        file: a.filename,
        type: typeOf(a),
        company: one(a.companies)?.name ?? null,
        update: one(a.company_updates)?.subject ?? null,
        ...(Array.isArray(a.metadata?.ocrNeededPages) ? { pages: a.metadata.ocrNeededPages } : {}),
        ...(a.ocr_error === AWAITING_ASSISTANT_OCR ? {} : { note: 'Queued for the server\'s OCR; you may read it now anyway.' }),
      })),
    }
  },

  ocr_page: async ({ admin, fundId, access }: AgentToolContext, input: any): Promise<McpContentResult> => {
    const artifact = await waitingArtifact(admin, fundId, access, String(input?.artifact ?? ''))
    const type = typeOf(artifact)
    const bytes = await loadArtifactBytes(admin as any, artifact)
    let image: { data: Buffer; mimeType: string }
    let label = artifact.filename
    if (type === 'application/pdf') {
      const needed = (artifact.metadata?.ocrNeededPages as number[] | undefined) ?? []
      const page = Number.isInteger(Number(input?.page)) && Number(input.page) > 0 ? Number(input.page) : needed[0] ?? 1
      const { png, numPages } = await renderPdfPage(bytes, page)
      image = { data: png, mimeType: 'image/png' }
      label = `${artifact.filename}, page ${page} of ${numPages}`
    } else if (type.startsWith('image/')) {
      image = { data: bytes, mimeType: type }
    } else {
      throw new Error(`${artifact.filename} is not a scan (${type || 'unknown type'}).`)
    }
    if (image.data.length > MAX_PAGE_IMAGE_BYTES) throw new Error(`${label} is too large to hand over as an image.`)
    return {
      mcpContent: [
        { type: 'text', text: `${label}. Transcribe it verbatim and save it with ocr_save_text { artifact: "${artifact.id}" }.` },
        { type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType },
      ],
    }
  },

  ocr_save_text: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const artifact = await waitingArtifact(admin, fundId, access, String(input?.artifact ?? ''))
    const pages: Record<number, string> = {}
    for (const p of Array.isArray(input?.pages) ? input.pages : []) {
      const n = Number(p?.page)
      if (Number.isInteger(n) && n > 0 && typeof p?.text === 'string') pages[n] = p.text.slice(0, 200_000)
    }
    const text = typeof input?.text === 'string' ? input.text.slice(0, 200_000) : undefined
    if (!text && Object.keys(pages).length === 0) throw new Error('Send text (for an image) or pages: [{ page, text }] (for a PDF).')
    const outcome = await ocrOneArtifact(admin as any, artifact, suppliedTextEngine({ text, pages }))
    return { artifact: artifact.id, file: artifact.filename, outcome }
  },

  inbox_waiting: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const visible = await visibleCompanyIds(admin, access)
    let q = (admin as any)
      .from('inbound_emails')
      .select('id, from_address, subject, received_at, company_id, attachments_count, companies(name)')
      .eq('fund_id', fundId)
      .eq('processing_status', 'pending')
      .eq('processing_error', AWAITING_ASSISTANT)
      .order('received_at', { ascending: true })
      .limit(clamp(input?.limit, 1, 50, 20))
    if (visible !== null) q = q.in('company_id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
    const { data, error } = await q
    if (error) throw new Error('Could not read the inbox.')
    return {
      waiting: ((data ?? []) as any[]).map(e => ({
        email: e.id,
        from: e.from_address,
        subject: e.subject,
        received_at: e.received_at,
        company: (Array.isArray(e.companies) ? e.companies[0]?.name : e.companies?.name) ?? null,
        attachments: e.attachments_count ?? 0,
      })),
    }
  },

  inbox_read: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const email = await waitingEmail(admin, fundId, access, String(input?.email ?? ''))
    const budget = clamp(input?.max_chars, 2000, 60_000, 30_000)
    const payload = await hydrateAttachments(email.raw_payload as PostmarkPayload) as PostmarkPayload
    const extracted = await extractAttachmentText(payload)
    let left = budget
    const take = (text: string) => {
      const out = text.slice(0, Math.max(0, left))
      left -= out.length
      return out.length < text.length ? `${out}\n[cut: ${text.length - out.length} more characters]` : out
    }
    return {
      email: email.id,
      from: email.from_address,
      subject: email.subject,
      received_at: email.received_at,
      company_id: email.company_id,
      body: take(extracted.emailBody),
      attachments: extracted.attachments.map(a => ({
        name: a.filename,
        type: a.contentType,
        ...(a.extractedText
          ? { text: take(a.extractedText) }
          : { text: null, note: a.skipped ? (a.skipReason ?? 'Not readable.') : 'A PDF or image: no text was extracted here. Do not guess at its contents.' }),
      })),
    }
  },

  inbox_done: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const email = await waitingEmail(admin, fundId, access, String(input?.email ?? ''))
    // Imported here, not at the top: portfolio-tools spreads these handlers into its own map.
    const { resolveCompany } = await import('./portfolio-tools')
    const company = await resolveCompany(admin, fundId, String(input?.company ?? ''), access)
    const recorded = clamp(input?.recorded, 0, 10_000, 0)
    const { error } = await (admin as any)
      .from('inbound_emails')
      .update({
        company_id: company.id,
        routed_to: 'reporting',
        processing_status: recorded > 0 ? 'success' : 'not_processed',
        processing_error: null,
        metrics_extracted: recorded,
      })
      .eq('id', email.id)
      .eq('fund_id', fundId)
    if (error) throw new Error('Could not mark the update as done.')
    // Onto the company's Updates, as the pipeline would have filed it (searchable by get_updates).
    const warnings: string[] = []
    try {
      const payload = await hydrateAttachments(email.raw_payload as PostmarkPayload) as PostmarkPayload
      const captured = await captureCompanyUpdate(admin as any, { emailId: email.id, fundId, companyId: company.id, payload: payload as any })
      if (captured?.artifacts?.some(a => a.ocrStatus === 'pending')) await kickCron('company-updates-ocr')
    } catch {
      warnings.push('Marked as done, but it could not be added to the company\'s Updates; reprocess it from the Emails page.')
    }
    return { email: email.id, company: company.name, status: recorded > 0 ? 'success' : 'not_processed', ...(warnings.length ? { warnings } : {}) }
  },
}
