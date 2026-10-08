import { createAdminClient } from '@/lib/supabase/admin'
import type { AIProvider } from '@/lib/ai/types'
import type { ExtractionResult } from '@/lib/parsing/extractAttachmentText'
import type { PostmarkPayload } from '@/lib/pipeline/processEmail'
import { analyzeDeal, DEFAULT_SCREENING_PROMPT, type DealAnalysis } from '@/lib/claude/analyzeDeal'
import { loadDealResearchSettings, shouldResearchDeal } from '@/lib/deals/research'

type Supabase = ReturnType<typeof createAdminClient>

export interface ProcessDealParams {
  supabase: Supabase
  emailId: string
  fundId: string
  payload: PostmarkPayload
  extracted: ExtractionResult
  provider: AIProvider
  providerType: string
  model: string
}

export interface ProcessDealResult {
  dealId: string | null
  /** out_of_thesis or spam — a low-fit deal that shouldn't trigger active alerts. */
  lowFit: boolean
  reviewFlagged: boolean
}

/**
 * Run the deals AI pipeline for an email the classifier routed to "deals".
 *
 * Steps:
 *   1. Load fund thesis + screening prompt.
 *   2. Single AI call producing extraction + summary + thesis-fit + score.
 *   3. Dedupe (founder_email → company_domain → company_name) and link prior_deal_id.
 *   4. Insert inbound_deals row. status=archived if out_of_thesis, else status=new.
 *   5. Flag in parsing_reviews when critical fields are missing.
 */
export async function processDeal(params: ProcessDealParams): Promise<ProcessDealResult> {
  const { supabase, emailId, fundId, payload, extracted, provider, providerType, model } = params

  const settings = await loadSettings(supabase, fundId)
  const thesis = settings?.deal_thesis ?? ''
  const screening = settings?.deal_screening_prompt ?? DEFAULT_SCREENING_PROMPT

  const combinedText = extracted.attachments
    .filter(a => !a.skipped && a.extractedText)
    .map(a => `[${a.filename}]\n${a.extractedText}`)
    .join('\n\n')

  const pdfBase64s = extracted.attachments
    .filter(a => !a.skipped && a.base64Content && a.contentType === 'application/pdf')
    .map(a => a.base64Content!)

  const images = extracted.attachments
    .filter(a => !a.skipped && a.base64Content && a.contentType.startsWith('image/'))
    .map(a => ({ data: a.base64Content!, mediaType: a.contentType }))

  const analysis = await analyzeDeal({
    emailSubject: payload.Subject ?? '',
    emailBody: extracted.emailBody,
    combinedAttachmentText: combinedText,
    pdfBase64s,
    images,
    thesis,
    screeningPrompt: screening,
    provider,
    providerType,
    model,
    log: { admin: supabase, fundId },
  })

  // Dedupe: find a prior deal from the same founder/company.
  const priorDealId = await findPriorDeal(supabase, fundId, analysis)

  // No auto-archiving — every deal starts as 'new' and carries its fit tag
  // (Out / Spam), so junk surfaces and stays filterable instead of being hidden.
  const status = 'new'
  const lowFit = analysis.thesis_fit_score === 'out_of_thesis' || analysis.thesis_fit_score === 'spam'

  const senderEmail = (payload.FromFull?.Email ?? payload.From ?? '').trim().toLowerCase() || null
  const founderEmail = analysis.founder_email ?? senderEmail
  const companyDomain = analysis.company_domain ?? deriveDomain(founderEmail)

  // External research is queued, not run here: a web-search round takes 30-60s
  // and this function runs inside the inbound-email webhook, which would time
  // out. /api/cron/deal-research drains the queue. Only deals that clear the
  // fund's interest bar are queued at all — see lib/deals/research.ts.
  const researchSettings = await loadDealResearchSettings(supabase, fundId)
  const researchStatus = shouldResearchDeal(analysis.thesis_fit_score, researchSettings)
    ? 'pending'
    : 'skipped'

  // The entity new pitches land in (Settings → Deal screening); none = unassigned, for admins to
  // triage. Only sent when set: before the entity migration the column does not exist.
  const { data: dealsDefault } = await (supabase as any)
    .from('fund_settings').select('deals_default_vehicle_id').eq('fund_id', fundId).maybeSingle()
  const defaultVehicleId = ((dealsDefault as any)?.deals_default_vehicle_id as string | null) ?? null

  const insertResult = await supabase
    .from('inbound_deals')
    .insert({
      ...(defaultVehicleId ? { vehicle_id: defaultVehicleId } : {}),
      email_id: emailId,
      fund_id: fundId,
      research_status: researchStatus,
      company_name: analysis.company_name,
      company_url: analysis.company_url,
      company_domain: companyDomain,
      founder_name: analysis.founder_name,
      founder_email: founderEmail,
      co_founders: analysis.co_founders as any,
      intro_source: analysis.intro_source,
      referrer_name: analysis.referrer_name,
      referrer_email: analysis.referrer_email,
      stage: analysis.stage,
      industry: analysis.industry,
      raise_amount: analysis.raise_amount,
      company_summary: analysis.company_summary,
      thesis_fit_analysis: analysis.thesis_fit_analysis,
      thesis_fit_score: analysis.thesis_fit_score,
      status,
      prior_deal_id: priorDealId,
    })
    .select('id')
    .single()

  if (insertResult.error || !insertResult.data) {
    console.error('[processDeal] insert failed:', insertResult.error)
    return { dealId: null, lowFit: false, reviewFlagged: false }
  }

  const dealId = (insertResult.data as { id: string }).id

  // Flag missing critical fields for human review.
  const reviewFlagged = await maybeFlagForReview(supabase, fundId, emailId, dealId, analysis)

  return { dealId, lowFit, reviewFlagged }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSettings(supabase: Supabase, fundId: string) {
  const { data } = await supabase
    .from('fund_settings')
    .select('deal_thesis, deal_screening_prompt')
    .eq('fund_id', fundId)
    .maybeSingle()
  return data as { deal_thesis: string | null; deal_screening_prompt: string | null } | null
}

/**
 * Two-pass dedupe per spec §7:
 *   1. Match founder_email (case-insensitive)
 *   2. Fall back to company_domain or company_name
 *
 * Returns the most recent prior deal's id, or null.
 */
async function findPriorDeal(supabase: Supabase, fundId: string, analysis: DealAnalysis): Promise<string | null> {
  if (analysis.founder_email) {
    const byFounder = await supabase
      .from('inbound_deals')
      .select('id')
      .eq('fund_id', fundId)
      .eq('founder_email', analysis.founder_email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (byFounder.data) return (byFounder.data as { id: string }).id
  }

  if (analysis.company_domain) {
    const byDomain = await supabase
      .from('inbound_deals')
      .select('id')
      .eq('fund_id', fundId)
      .eq('company_domain', analysis.company_domain)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (byDomain.data) return (byDomain.data as { id: string }).id
  }

  if (analysis.company_name) {
    const byName = await supabase
      .from('inbound_deals')
      .select('id')
      .eq('fund_id', fundId)
      .ilike('company_name', analysis.company_name)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (byName.data) return (byName.data as { id: string }).id
  }

  return null
}

async function maybeFlagForReview(
  supabase: Supabase,
  fundId: string,
  emailId: string,
  dealId: string,
  analysis: DealAnalysis
): Promise<boolean> {
  const missing: string[] = []
  if (!analysis.company_name) missing.push('company_name')
  if (!analysis.founder_name) missing.push('founder_name')
  if (!analysis.thesis_fit_score) missing.push('thesis_fit_score')

  if (missing.length === 0) return false

  await supabase.from('parsing_reviews').insert({
    fund_id: fundId,
    email_id: emailId,
    issue_type: 'deal_extraction',
    extracted_value: dealId,
    context_snippet: `Deal extraction missing: ${missing.join(', ')}`,
  })

  return true
}

function deriveDomain(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).toLowerCase()
  // Filter out generic personal domains — they don't represent the company.
  const personal = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'me.com', 'protonmail.com'])
  return personal.has(domain) ? null : domain
}
