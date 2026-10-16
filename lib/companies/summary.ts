// The AI summary on a company page, written by the SERVER's model: the Summarise button
// (app/api/companies/[id]/summary POST) and `company_generate_summary` from chat both call
// generateCompanySummary, so they read the same inputs, use the same prompt and save the same row.
// With no server key a fund's own assistant writes the summary and saves it (company_save_summary).

import type { SupabaseClient } from '@supabase/supabase-js'
import { createFundAIProviderWithOverride, type ProviderType } from '@/lib/ai'
import type { ContentBlock } from '@/lib/ai/types'
import { logAIUsage } from '@/lib/ai/usage'
import { logActivity } from '@/lib/activity'
import { buildCompanyContext } from '@/lib/ai/context-builder'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { extractAttachmentText, hydrateAttachments, type PostmarkPayload } from '@/lib/parsing/extractAttachmentText'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export interface GeneratedSummary {
  summary: string
  period_label?: string | null
  generated_at: string | null
}

const DEFAULT_TASK_PROMPT = `Write a concise analyst summary covering:

1. **Current Status**, How is the company performing right now? Reference specific numbers.
2. **Trends**, What direction are the key metrics heading? Growth rates, acceleration or deceleration.
3. **Progress & Positives**, What's going well? Milestones, improvements, or strong execution.
4. **Challenges & Risks**, What concerns you? Declining metrics, missing data, red flags.
5. **Key Follow-ups**, What should the investment team ask about or monitor next?

Keep it to 2-4 short paragraphs. Be direct and analytical, not promotional. Use specific numbers. Do not use markdown formatting, write in plain prose paragraphs.`

/**
 * Generate and save a summary of one company. The caller has checked the company is in the fund
 * and the person may write it; `access` decides which inputs the model may read.
 */
export async function generateCompanySummary(
  admin: SupabaseClient,
  access: AccessContext,
  companyId: string,
  opts: { provider?: ProviderType } = {},
): Promise<Outcome<GeneratedSummary>> {
  const db = admin as any
  // Team notes are the `relationships` domain: a member who can draft a company summary is not
  // thereby entitled to the team's internal commentary about it, and an AI summary is a very
  // effective way to launder that distinction away.
  const ctx = await buildCompanyContext(admin as any, companyId, {
    includeTeamNotes: hasAccess(access, 'relationships', 'read', 'notes'),
    scope: await entityScopeFor(admin as any, access),
    // The summary is stored on the company and shown to everyone who can see it: company-level
    // inputs only, never one entity's positions or notes.
    companyLevelOnly: true,
  })
  if (!ctx) return fail(404, 'Not found')

  const { company, currentPeriodLabel, metricsBlock, reportContentBlock, previousSummariesBlock, documentsBlock } = ctx

  let provider: Awaited<ReturnType<typeof createFundAIProviderWithOverride>>['provider']
  let aiModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProviderWithOverride(admin as any, company.fund_id, opts.provider)
    provider = result.provider
    aiModel = result.model
    aiProviderType = result.providerType
  } catch {
    return fail(400, 'AI API key not configured. Add one in Settings to enable AI summaries.')
  }

  const { data: promptSettings } = await db.from('fund_settings').select('ai_summary_prompt').eq('fund_id', company.fund_id).maybeSingle()
  const customPrompt = (promptSettings as { ai_summary_prompt: string | null } | null)?.ai_summary_prompt ?? null

  // Binary content (PDFs, images): the context builder extracts text only.
  const contentParts: ContentBlock[] = []
  const { data: latestEmail } = await db
    .from('inbound_emails')
    .select('raw_payload, subject, received_at')
    .eq('company_id', companyId)
    .eq('processing_status', 'success')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestEmail?.raw_payload) {
    const payload = await hydrateAttachments(latestEmail.raw_payload as PostmarkPayload)
    const extracted = await extractAttachmentText(payload)
    for (const att of extracted.attachments) {
      if (!att.skipped && att.base64Content && att.contentType === 'application/pdf') {
        contentParts.push({ type: 'document', mediaType: 'application/pdf', data: att.base64Content })
      }
    }
    for (const att of extracted.attachments) {
      if (!att.skipped && att.base64Content && att.contentType.startsWith('image/')) {
        contentParts.push({ type: 'image', mediaType: att.contentType, data: att.base64Content })
      }
    }
  }

  const { data: companyDocuments } = await db
    .from('company_documents')
    .select('filename, has_native_content, storage_path, file_type')
    .eq('company_id', companyId)
    .eq('has_native_content', true)
    .order('created_at', { ascending: false })
    .limit(5) as { data: { filename: string; has_native_content: boolean; storage_path: string; file_type: string }[] | null }

  for (const doc of companyDocuments ?? []) {
    if (!doc.storage_path) continue
    const { data: fileData } = await db.storage.from('company-documents').download(doc.storage_path)
    if (!fileData) continue
    const base64 = Buffer.from(await fileData.arrayBuffer()).toString('base64')
    if (doc.file_type === 'application/pdf') {
      contentParts.push({ type: 'document', mediaType: 'application/pdf', data: base64 })
    } else if (doc.file_type.startsWith('image/')) {
      contentParts.push({ type: 'image', mediaType: doc.file_type, data: base64 })
    }
  }

  const hasData = metricsBlock || reportContentBlock || contentParts.length > 0 || documentsBlock
  if (!hasData) {
    return done({
      summary: 'No data available yet. The summary will be generated after the first report is processed.',
      generated_at: null,
    })
  }

  const taskPrompt = customPrompt ?? DEFAULT_TASK_PROMPT
  let promptText = ctx.systemPrompt

  if (metricsBlock) {
    promptText += `

=== QUANTITATIVE DATA ===
Tracked metrics over time:
${metricsBlock}`
  }

  if (reportContentBlock) {
    promptText += `

=== LATEST REPORT CONTENT ===
From the most recent email report (${latestEmail?.subject ?? 'no subject'}, received ${latestEmail?.received_at ? new Date(latestEmail.received_at).toLocaleDateString() : 'unknown date'}):

${reportContentBlock}`
  }

  if (previousSummariesBlock) {
    promptText += `

=== PREVIOUS ANALYSIS ===
Your prior analyst summaries for this company (oldest to newest):

${previousSummariesBlock}`
  }

  if (documentsBlock) {
    promptText += `

=== SUPPLEMENTARY DOCUMENTS ===
Additional context documents uploaded by the investment team (strategy decks, board materials, etc.):

${documentsBlock}`
  }

  promptText += `

=== YOUR TASK ===
${taskPrompt}

${previousSummariesBlock ? 'Build on your previous analysis, note what has changed since your last review. Avoid repeating the same observations unless they remain critical.' : 'This is the first analysis for this company, so base it entirely on the available data and report content.'}
${documentsBlock ? '\nYou also have access to supplementary documents (strategy decks, board materials, etc.) uploaded by the investment team. Reference these when relevant.' : ''}`

  try {
    const { text: summaryText, usage } = await provider.createMessage({
      model: aiModel,
      maxTokens: 1000,
      content: [...contentParts, { type: 'text', text: promptText }],
    })

    logAIUsage(admin as any, { fundId: company.fund_id, userId: access.userId, provider: aiProviderType, model: aiModel, feature: 'summary', usage })
    logActivity(admin as any, company.fund_id, access.userId, 'company.summary', { companyId })

    const { error: insertError } = await db.from('company_summaries').insert({
      company_id: companyId,
      fund_id: company.fund_id,
      period_label: currentPeriodLabel,
      summary_text: summaryText,
    })
    // Still return the summary even if saving it fails.
    if (insertError) console.error('[company-summary] DB insert error:', insertError)

    return done({ summary: summaryText, period_label: currentPeriodLabel, generated_at: new Date().toISOString() })
  } catch (err) {
    console.error('[company-summary] Claude error:', err instanceof Error ? err.message : String(err), err)
    return fail(500, 'Summary generation failed. Check your API key in Settings.')
  }
}
