import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createFundAIProviderWithOverride } from '@/lib/ai'
import type { ContentBlock } from '@/lib/ai/types'
import { logAIUsage } from '@/lib/ai/usage'
import { logActivity } from '@/lib/activity'
import { buildCompanyContext } from '@/lib/ai/context-builder'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import {
  extractAttachmentText,
  hydrateAttachments,
  type PostmarkPayload,
} from '@/lib/parsing/extractAttachmentText'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { entityScopeFor } from '@/lib/access/entity-scope'

// Verify the company belongs to the user's fund
async function verifyCompanyAccess(supabase: Awaited<ReturnType<typeof createClient>>, admin: ReturnType<typeof createAdminClient>, userId: string, companyId: string) {
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 404 }) }

  const { data: company } = await admin
    .from('companies')
    .select('fund_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (company.fund_id !== membership.fund_id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  return { fundId: membership.fund_id, role: membership.role }
}

// ---------------------------------------------------------------------------
// GET — return the most recent stored summary (if any)
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  const { data: summaries } = await admin
    .from('company_summaries')
    .select('id, summary_text, period_label, created_at')
    .eq('company_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50) as { data: { id: string; summary_text: string; period_label: string | null; created_at: string }[] | null }

  if (!summaries || summaries.length === 0) {
    return NextResponse.json({ summary: null, generated_at: null, history: [] })
  }

  const latest = summaries[0]

  return NextResponse.json({
    summary: latest.summary_text,
    period_label: latest.period_label,
    generated_at: latest.created_at,
    history: summaries.map(s => ({
      id: s.id,
      summary_text: s.summary_text,
      period_label: s.period_label,
      created_at: s.created_at,
    })),
  })
}

// ---------------------------------------------------------------------------
// DELETE — wipe all stored summaries so the next generate is fresh
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  const { error } = await admin
    .from('company_summaries')
    .delete()
    .eq('company_id', params.id)

  if (error) return dbError(error, 'companies-id-summary')

  return NextResponse.json({ ok: true })
}

// ---------------------------------------------------------------------------
// POST — generate a new AI summary and persist it
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Rate limit AI summary generation: 10 per 5 minutes per user
  const limited = await rateLimit({ key: `ai-summary:${user.id}`, limit: 10, windowSeconds: 300 })
  if (limited) return limited

  // Read optional provider override from body
  let providerOverride: import('@/lib/ai').ProviderType | undefined
  try {
    const body = await req.json()
    const validProviders = ['anthropic', 'openai']
    if (validProviders.includes(body.provider)) {
      providerOverride = body.provider
    }
  } catch {
    // No body or invalid JSON — use default provider
  }

  const admin = createAdminClient()

  // Verify fund access before proceeding
  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  // Build shared context. Team notes are the `relationships` domain — a member who can draft a
  // company summary is not thereby entitled to the team's internal commentary about it, and an
  // AI summary is a very effective way to launder that distinction away.
  const ctxAccess = await loadAccessContext(admin, access.fundId, user.id, access.role)
  const ctx = await buildCompanyContext(admin, params.id, {
    includeTeamNotes: hasAccess(ctxAccess, 'relationships', 'read', 'notes'),
    scope: await entityScopeFor(admin, ctxAccess),
  })
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { company, currentPeriodLabel, metricsBlock, reportContentBlock, previousSummariesBlock, documentsBlock } = ctx

  // --- AI provider + model + custom prompt ---
  let provider: Awaited<ReturnType<typeof createFundAIProviderWithOverride>>['provider']
  let aiModel: string
  let aiProviderType: string
  try {
    const result = await createFundAIProviderWithOverride(admin, company.fund_id, providerOverride)
    provider = result.provider
    aiModel = result.model
    aiProviderType = result.providerType
  } catch {
    return NextResponse.json({
      error: 'AI API key not configured. Add one in Settings to enable AI summaries.',
    }, { status: 400 })
  }

  const { data: promptSettings } = await admin
    .from('fund_settings')
    .select('ai_summary_prompt')
    .eq('fund_id', company.fund_id)
    .maybeSingle()
  const customPrompt = (promptSettings as unknown as { ai_summary_prompt: string | null } | null)?.ai_summary_prompt ?? null

  // -----------------------------------------------------------------------
  // Build binary content parts (PDFs/images) — summary-specific
  // -----------------------------------------------------------------------
  const contentParts: ContentBlock[] = []

  // Re-fetch email for binary attachments (context builder only extracts text)
  const { data: latestEmail } = await admin
    .from('inbound_emails')
    .select('raw_payload, subject, received_at')
    .eq('company_id', params.id)
    .eq('processing_status', 'success')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestEmail?.raw_payload) {
    const payload = await hydrateAttachments(latestEmail.raw_payload as unknown as PostmarkPayload)
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

  // Binary documents from storage
  const { data: companyDocuments } = await admin
    .from('company_documents' as any)
    .select('filename, has_native_content, storage_path, file_type')
    .eq('company_id', params.id)
    .eq('has_native_content', true)
    .order('created_at', { ascending: false })
    .limit(5) as { data: { filename: string; has_native_content: boolean; storage_path: string; file_type: string }[] | null }

  if (companyDocuments) {
    for (const doc of companyDocuments) {
      if (doc.storage_path) {
        const { data: fileData } = await admin
          .storage
          .from('company-documents')
          .download(doc.storage_path)

        if (fileData) {
          const buffer = Buffer.from(await fileData.arrayBuffer())
          const base64 = buffer.toString('base64')

          if (doc.file_type === 'application/pdf') {
            contentParts.push({ type: 'document', mediaType: 'application/pdf', data: base64 })
          } else if (doc.file_type.startsWith('image/')) {
            contentParts.push({ type: 'image', mediaType: doc.file_type, data: base64 })
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Build prompt
  // -----------------------------------------------------------------------

  const hasData = metricsBlock || reportContentBlock || contentParts.length > 0 || documentsBlock
  if (!hasData) {
    return NextResponse.json({
      summary: 'No data available yet. The summary will be generated after the first report is processed.',
      generated_at: null,
    })
  }

  const DEFAULT_TASK_PROMPT = `Write a concise analyst summary covering:

1. **Current Status**, How is the company performing right now? Reference specific numbers.
2. **Trends**, What direction are the key metrics heading? Growth rates, acceleration or deceleration.
3. **Progress & Positives**, What's going well? Milestones, improvements, or strong execution.
4. **Challenges & Risks**, What concerns you? Declining metrics, missing data, red flags.
5. **Key Follow-ups**, What should the investment team ask about or monitor next?

Keep it to 2-4 short paragraphs. Be direct and analytical, not promotional. Use specific numbers. Do not use markdown formatting, write in plain prose paragraphs.`

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

  // -----------------------------------------------------------------------
  // Call Claude
  // -----------------------------------------------------------------------

  const userContent: ContentBlock[] = [
    ...contentParts,
    { type: 'text', text: promptText },
  ]

  try {
    const { text: summaryText, usage } = await provider.createMessage({
      model: aiModel,
      maxTokens: 1000,
      content: userContent,
    })

    logAIUsage(admin, {
      fundId: company.fund_id,
      userId: user.id,
      provider: aiProviderType,
      model: aiModel,
      feature: 'summary',
      usage,
    })

    logActivity(admin, company.fund_id, user.id, 'company.summary', { companyId: params.id })

    // Persist the summary
    const { error: insertError } = await admin.from('company_summaries').insert({
      company_id: params.id,
      fund_id: company.fund_id,
      period_label: currentPeriodLabel,
      summary_text: summaryText,
    })

    if (insertError) {
      console.error('[company-summary] DB insert error:', insertError)
      // Still return the summary even if persist fails
    }

    return NextResponse.json({
      summary: summaryText,
      period_label: currentPeriodLabel,
      generated_at: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[company-summary] Claude error:', message, err)
    return NextResponse.json({
      error: 'Summary generation failed. Check your API key in Settings.',
    }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PUT — save analyst-drafted text as a company summary
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const access = await verifyCompanyAccess(supabase, admin, user.id, params.id)
  if ('error' in access) return access.error

  let body: { summary_text?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.summary_text || typeof body.summary_text !== 'string') {
    return NextResponse.json({ error: 'summary_text is required' }, { status: 400 })
  }

  const { error: insertError } = await admin.from('company_summaries').insert({
    company_id: params.id,
    fund_id: access.fundId,
    period_label: null,
    summary_text: body.summary_text.trim(),
  })

  if (insertError) return dbError(insertError, 'companies-id-summary-put')

  logActivity(admin, access.fundId, user.id, 'company.summary', { companyId: params.id, source: 'analyst' })

  return NextResponse.json({
    summary: body.summary_text.trim(),
    generated_at: new Date().toISOString(),
  })
}
