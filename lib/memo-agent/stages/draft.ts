import { createAdminClient } from '@/lib/supabase/admin'
import { logAIUsage } from '@/lib/ai/usage'
import { getStageProvider } from '@/lib/memo-agent/stage-provider'
import { getActiveSchema, ensureDefaults } from '@/lib/memo-agent/firm-schemas'
import { buildSystemPrompt } from '@/lib/memo-agent/prompts/system'
import {
  buildDraftOutlineContent,
  buildDraftSectionFillContent,
  buildDraftReviewContent,
  type QARecord,
  type OutlineSection,
} from '@/lib/memo-agent/prompts/draft'
import { extractJsonObject } from '@/lib/memo-agent/parse-ai-json'
import { buildMemoTemplateBlock } from '@/lib/memo-agent/prompts/memo-template'
import { buildMemoConfigBlock, type MemoTemplateConfig } from '@/lib/memo-agent/prompts/memo-config'
import { effectiveSections } from '@/lib/memo-agent/design-sections'
import type { IngestionOutput } from './ingest'
import type { ResearchOutput } from './research'

type Admin = ReturnType<typeof createAdminClient>

export interface MemoParagraph {
  id: string
  section_id: string
  order: number
  prose: string
  sources: Array<{ source_type: string; source_id: string; span?: string | null }>
  origin: 'agent_drafted' | 'partner_drafted' | 'partner_only_placeholder' | 'partner_edited'
  confidence: 'low' | 'medium' | 'high' | 'n/a'
  contains_projection: boolean
  contains_unverified_claim: boolean
  contains_contradiction: boolean
  /** Partner-hidden paragraphs are kept in the draft but excluded from renders. */
  hidden?: boolean
}

export interface PartnerAttentionItem {
  kind: string
  urgency: 'must_address' | 'should_address' | 'fyi'
  body: string
  links: Array<{ source_type: string; source_id: string }>
}

export interface MemoDraftOutput {
  header: Record<string, any>
  paragraphs: MemoParagraph[]
  partner_attention: PartnerAttentionItem[]
}

export interface DraftResult {
  draft_id: string
  output: MemoDraftOutput
  warnings: string[]
}

// Fill batches are balanced by PARAGRAPH count, not section count — a single
// large section (e.g. a 6-paragraph team section) must not land in the same
// call as several others and produce an oversized response. Each fill call
// targets ~this many paragraphs; a section larger than the target gets its
// own call (sections are never split across calls, for coherence).
const PARAGRAPHS_PER_FILL = 8

// The review pass is chunked the same way — each review call handles at most
// this many paragraphs so its edit output is always bounded.
const PARAGRAPHS_PER_REVIEW = 12

/**
 * Pack sections into batches targeting PARAGRAPHS_PER_FILL paragraphs each.
 * Sections are kept whole; a section larger than the target becomes its own
 * batch. Guarantees no fill call is handed an oversized writing task.
 */
function balanceSectionBatches(sections: OutlineSection[]): OutlineSection[][] {
  const batches: OutlineSection[][] = []
  let current: OutlineSection[] = []
  let count = 0
  for (const section of sections) {
    const secCount = section.paragraphs.length || 1
    if (count > 0 && count + secCount > PARAGRAPHS_PER_FILL) {
      batches.push(current)
      current = []
      count = 0
    }
    current.push(section)
    count += secCount
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Stage 4 — assemble the memo draft.
 *
 * Two-phase to fit inside the 300s Vercel ceiling:
 *   4A. Outline call — plans header + per-section paragraph skeletons +
 *       partner_attention. Small output, always fits.
 *   4B. Fill calls — the outline's sections are batched and each batch is
 *       written by a parallel AI call. Each fill call sees the full memo
 *       shape (to avoid cross-section repetition) but only writes its batch.
 *
 * A single fill failure surfaces as a warning; the rest of the memo still
 * lands, instead of the prior all-or-nothing single call that orphaned via
 * max_tokens truncation on large memos.
 */
export async function runDraft(params: {
  admin: Admin
  fundId: string
  dealId: string
  draftId?: string
  progressCb?: (msg: string) => Promise<void>
}): Promise<DraftResult> {
  const { admin, fundId, dealId, progressCb } = params
  const note = async (msg: string) => { if (progressCb) await progressCb(msg) }
  const warnings: string[] = []

  await note('Loading draft inputs…')
  const draft = await loadDraftWithInputs(admin, fundId, dealId, params.draftId)
  if (!draft) throw new Error('No draft found. Run Stage 1 first.')
  if (!draft.ingestion_output) throw new Error('Ingestion output missing on draft. Run Stage 1 first.')

  const ingestion = draft.ingestion_output as IngestionOutput
  const research = (draft.research_output as ResearchOutput | null) ?? null
  // Partner-excluded Q&A entries are dropped from evaluation entirely.
  const qa_answers = (Array.isArray(draft.qa_answers) ? draft.qa_answers as QARecord[] : []).filter(r => !r.excluded)

  const docCount = ingestion.documents?.length ?? 0
  const claimCount = ingestion.documents?.reduce((acc, d) => acc + (d.claims?.length ?? 0), 0) ?? 0

  await note('Loading deal record…')
  const { data: dealRow } = await admin
    .from('diligence_deals')
    .select('name, sector, stage_at_consideration, partner_memo_guidance, memo_template_config')
    .eq('id', dealId)
    .eq('fund_id', fundId)
    .maybeSingle()
  const deal = (dealRow as any) ?? { name: 'this deal' }
  const partnerGuidance = (deal.partner_memo_guidance ?? '').toString()
  let templateConfig = (deal.memo_template_config ?? {}) as MemoTemplateConfig
  // No section list of its own: write under the fund design template's headings, when it has one.
  if (!templateConfig.sections?.length) {
    const fromDesign = await effectiveSections(admin as any, fundId, undefined)
    if (fromDesign?.length) templateConfig = { ...templateConfig, sections: fromDesign as MemoTemplateConfig['sections'] }
  }
  // Style override: when the partner has set one on the memo config, use it
  // instead of deal.stage_at_consideration for calibration. The config block
  // also restates this for the model, so both the calibration and the partner
  // instruction agree.
  const effectiveStage = templateConfig?.style_override ?? deal.stage_at_consideration ?? null
  const memoConfigBlock = buildMemoConfigBlock({ partnerGuidance, config: templateConfig })

  await note('Loading schemas…')
  await ensureDefaults(fundId, admin)
  const memoOutputSchema = await getActiveSchema(fundId, 'memo_output', admin)
  const rubricSchema = await getActiveSchema(fundId, 'rubric', admin)
  if (!memoOutputSchema || !rubricSchema) {
    throw new Error('memo_output or rubric schema missing. Re-seed defaults.')
  }

  await note('Building draft prompt…')
  const { prompt: system } = await buildSystemPrompt({ admin, fundId, stage: 'draft' })
  const { provider, model, providerType } = await getStageProvider(admin, fundId, 'draft')
  // Fund memo template — first-page exemplar + structural reference from the
  // fund's own sample memos.
  const memoTemplate = await buildMemoTemplateBlock(admin, fundId)

  // ---- Phase 4A: outline -------------------------------------------------
  await note(`Planning memo outline (${docCount} docs, ${claimCount} claims)…`)
  const outlineContent = buildDraftOutlineContent({
    dealName: deal.name,
    stage: effectiveStage,
    memoOutputYaml: memoOutputSchema.yaml_content,
    memoTemplate,
    memoConfigBlock,
    ingestion,
    research,
    qa_answers,
  })
  const outlineRes = await provider.createMessage({
    model,
    // 16K — the outline skeleton (no prose, no source-id lists) is compact,
    // but a memo with many sections still needs headroom so it never
    // truncates into unbalanced JSON.
    maxTokens: 16384,
    system,
    content: outlineContent,
  })
  logAIUsage(admin, { fundId, dealId, provider: providerType, model, feature: 'memo_agent_draft_outline', usage: outlineRes.usage })
  if (outlineRes.truncated) {
    warnings.push('Memo outline was truncated — later sections may be missing from the plan.')
  }
  const outline = parseOutlineResponse(outlineRes.text)
  if (outline.sections.length === 0) {
    throw new Error('Draft outline produced 0 sections. Cannot proceed to section fills.')
  }

  // ---- Phase 4B: parallel section fills ----------------------------------
  const allSectionTopics = outline.sections.map(s => ({
    section_id: s.section_id,
    topics: s.paragraphs.map(p => p.topic),
  }))
  const batches = balanceSectionBatches(outline.sections)

  await note(`Writing ${outline.sections.length} sections across ${batches.length} parallel fill calls…`)
  let fillsDone = 0
  const fillResults = await Promise.all(batches.map(async (batch, idx): Promise<MemoParagraph[]> => {
    const batchLabel = batch.map(s => s.section_id).join(', ')
    try {
      const res = await provider.createMessage({
        model,
        maxTokens: 16384,
        system,
        content: buildDraftSectionFillContent({
          dealName: deal.name,
          stage: effectiveStage,
          memoTemplate,
          memoConfigBlock,
          sectionsToWrite: batch,
          allSectionTopics,
          ingestion,
          research,
          qa_answers,
        }),
      })
      logAIUsage(admin, { fundId, dealId, provider: providerType, model, feature: 'memo_agent_draft_fill', usage: res.usage })
      if (res.truncated) {
        warnings.push(`Section batch "${batchLabel}" was truncated (max_tokens) — some paragraphs may be missing.`)
      }
      const paragraphs = parseFillResponse(res.text)
      fillsDone += 1
      await note(`Wrote section batch ${fillsDone}/${batches.length}: ${batchLabel}`)
      return paragraphs
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Section batch "${batchLabel}" failed: ${msg}`)
      fillsDone += 1
      await note(`Section batch ${fillsDone}/${batches.length} failed: ${batchLabel}`)
      return []
    }
  }))

  // ---- Assemble ----------------------------------------------------------
  let paragraphs = fillResults.flat().sort((a, b) => {
    if (a.section_id !== b.section_id) return a.section_id.localeCompare(b.section_id)
    return a.order - b.order
  })

  // Force the recommendation section to a partner-only placeholder.
  paragraphs = enforceRecommendationPlaceholder(paragraphs)

  const parsed: MemoDraftOutput = {
    header: outline.header,
    paragraphs,
    partner_attention: outline.partner_attention,
  }

  // Quality checks — warnings, not failures.
  if (parsed.paragraphs.length === 0) {
    warnings.push('Draft produced 0 paragraphs across all fill calls — every batch failed. Re-run recommended.')
  }
  const plannedSections = outline.sections.map(s => s.section_id)
  const writtenSections = new Set(parsed.paragraphs.map(p => p.section_id))
  const missingSections = plannedSections.filter(s => !writtenSections.has(s))
  if (missingSections.length > 0) {
    warnings.push(`Sections planned but not written (fill failure): ${missingSections.join(', ')}.`)
  }

  // Validate source IDs.
  const validIds = collectValidIds(ingestion, research, qa_answers)
  for (const p of parsed.paragraphs) {
    for (const s of p.sources) {
      if (s.source_type === 'partner_only') continue
      const set = validIds[s.source_type as keyof typeof validIds]
      if (set && !set.has(s.source_id)) {
        warnings.push(`Paragraph ${p.id} cites unknown ${s.source_type} id ${s.source_id}`)
      }
    }
  }

  await note('Writing draft to database…')
  const { error: updateErr } = await admin
    .from('diligence_memo_drafts')
    .update({ memo_draft_output: parsed as any })
    .eq('id', draft.id)
  if (updateErr) throw new Error(`Failed to persist draft: ${updateErr.message}`)

  await note('Writing partner attention items…')
  if (parsed.partner_attention.length > 0) {
    const rows = parsed.partner_attention.map(item => ({
      deal_id: dealId,
      draft_id: draft.id,
      fund_id: fundId,
      kind: item.kind,
      urgency: item.urgency,
      body: item.body,
      links: item.links as any,
      status: 'open',
    }))
    await admin.from('diligence_attention_items').insert(rows as any)
  }

  return { draft_id: draft.id, output: parsed, warnings }
}

// ---------------------------------------------------------------------------
// Stage 4C — review & edit pass
// ---------------------------------------------------------------------------

export interface DraftReviewResult {
  draft_id: string
  edits_applied: number
  warnings: string[]
}

/**
 * Stage 4C — review/edit pass. Loads the persisted first-draft memo, runs a
 * single review call (typically on a stronger model via the `draft_review`
 * stage override), and applies the returned targeted edits in place.
 *
 * Runs as its own job so it gets a fresh 300s budget — folding it into the
 * draft job alongside outline + fills + score would blow the function ceiling.
 */
export async function runDraftReview(params: {
  admin: Admin
  fundId: string
  dealId: string
  draftId?: string
  progressCb?: (msg: string) => Promise<void>
}): Promise<DraftReviewResult> {
  const { admin, fundId, dealId, progressCb } = params
  const note = async (msg: string) => { if (progressCb) await progressCb(msg) }
  const warnings: string[] = []

  await note('Loading draft for review…')
  const row = await loadDraftWithMemo(admin, fundId, dealId, params.draftId)
  if (!row) throw new Error('No draft found to review. Run Stage 4 draft first.')
  if (!row.memo_draft_output) throw new Error('memo_draft_output missing — Stage 4 draft must complete first.')

  const memo = row.memo_draft_output as MemoDraftOutput
  const ingestion = (row.ingestion_output as IngestionOutput | null) ?? { documents: [], gap_analysis: { missing: [], inadequate: [] }, cross_doc_flags: [] }
  const research = (row.research_output as ResearchOutput | null) ?? null
  const qa_answers = (Array.isArray(row.qa_answers) ? row.qa_answers as QARecord[] : []).filter(r => !r.excluded)

  const reviewable = memo.paragraphs.filter(p => p.origin !== 'partner_only_placeholder')
  if (reviewable.length === 0) {
    warnings.push('No reviewable paragraphs (draft is empty or all placeholders). Skipping review.')
    return { draft_id: row.id, edits_applied: 0, warnings }
  }

  await note('Building review prompt…')
  const { data: dealRow } = await admin
    .from('diligence_deals')
    .select('name, stage_at_consideration')
    .eq('id', dealId)
    .eq('fund_id', fundId)
    .maybeSingle()
  const dealName = (dealRow as { name: string } | null)?.name ?? 'this deal'
  const dealStage = (dealRow as { stage_at_consideration: string | null } | null)?.stage_at_consideration ?? null
  const { prompt: system } = await buildSystemPrompt({ admin, fundId, stage: 'draft' })
  const { provider, model, providerType } = await getStageProvider(admin, fundId, 'draft_review')

  // Chunk the reviewable paragraphs so each review call's edit output is
  // bounded. Calls run in parallel — wall-clock stays flat regardless of
  // memo size.
  const reviewChunks: typeof reviewable[] = []
  for (let i = 0; i < reviewable.length; i += PARAGRAPHS_PER_REVIEW) {
    reviewChunks.push(reviewable.slice(i, i + PARAGRAPHS_PER_REVIEW))
  }

  await note(`Reviewing ${reviewable.length} paragraphs across ${reviewChunks.length} parallel call(s)…`)
  const editLists = await Promise.all(reviewChunks.map(async (chunk, idx) => {
    try {
      const res = await provider.createMessage({
        model,
        maxTokens: 16384,
        system,
        content: buildDraftReviewContent({
          dealName,
          stage: dealStage,
          paragraphs: chunk.map(p => ({ id: p.id, section_id: p.section_id, prose: p.prose })),
          ingestion,
          research,
          qa_answers,
        }),
      })
      logAIUsage(admin, { fundId, dealId, provider: providerType, model, feature: 'memo_agent_draft_review', usage: res.usage })
      if (res.truncated) {
        warnings.push(`Review chunk ${idx + 1} was truncated — some edits may not have been applied.`)
      }
      return parseReviewResponse(res.text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Review chunk ${idx + 1} failed: ${msg}. Those paragraphs keep their first-draft prose.`)
      return []
    }
  }))
  const edits = editLists.flat()
  const byId = new Map(memo.paragraphs.map(p => [p.id, p]))
  let applied = 0
  for (const e of edits) {
    const target = byId.get(e.paragraph_id)
    if (!target) continue
    if (target.origin === 'partner_only_placeholder') continue
    if (!e.revised_prose.trim()) continue
    target.prose = e.revised_prose
    applied += 1
    if (e.reason) warnings.push(`Review edited ${e.paragraph_id}: ${e.reason}`)
  }

  await note('Writing reviewed draft…')
  const { error: updateErr } = await admin
    .from('diligence_memo_drafts')
    .update({ memo_draft_output: memo as any })
    .eq('id', row.id)
  if (updateErr) throw new Error(`Failed to persist reviewed draft: ${updateErr.message}`)

  return { draft_id: row.id, edits_applied: applied, warnings }
}

function parseReviewResponse(raw: string): Array<{ paragraph_id: string; revised_prose: string; reason: string }> {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Review AI returned non-object JSON')
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.edits)) return []
  return obj.edits
    .filter((e: any) => e && typeof e === 'object' && typeof e.paragraph_id === 'string' && typeof e.revised_prose === 'string')
    .map((e: any) => ({
      paragraph_id: e.paragraph_id,
      revised_prose: e.revised_prose,
      reason: typeof e.reason === 'string' ? e.reason : '',
    }))
}

// ---------------------------------------------------------------------------

interface DraftRow {
  id: string
  ingestion_output: unknown
  research_output: unknown
  qa_answers: unknown
}

async function loadDraftWithInputs(admin: Admin, fundId: string, dealId: string, draftId?: string): Promise<DraftRow | null> {
  if (draftId) {
    const { data } = await admin
      .from('diligence_memo_drafts')
      .select('id, ingestion_output, research_output, qa_answers')
      .eq('id', draftId)
      .eq('fund_id', fundId)
      .maybeSingle()
    return (data as any) ?? null
  }
  const { data } = await admin
    .from('diligence_memo_drafts')
    .select('id, ingestion_output, research_output, qa_answers')
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .eq('is_draft', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

interface DraftWithMemoRow {
  id: string
  memo_draft_output: unknown
  ingestion_output: unknown
  research_output: unknown
  qa_answers: unknown
}

async function loadDraftWithMemo(admin: Admin, fundId: string, dealId: string, draftId?: string): Promise<DraftWithMemoRow | null> {
  const cols = 'id, memo_draft_output, ingestion_output, research_output, qa_answers'
  if (draftId) {
    const { data } = await admin
      .from('diligence_memo_drafts')
      .select(cols)
      .eq('id', draftId)
      .eq('fund_id', fundId)
      .maybeSingle()
    return (data as any) ?? null
  }
  const { data } = await admin
    .from('diligence_memo_drafts')
    .select(cols)
    .eq('deal_id', dealId)
    .eq('fund_id', fundId)
    .eq('is_draft', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedOutline {
  header: Record<string, any>
  sections: OutlineSection[]
  partner_attention: PartnerAttentionItem[]
}

function parseOutlineResponse(raw: string): ParsedOutline {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Draft outline AI returned non-object JSON')
  }
  const obj = parsed as Record<string, unknown>
  const required = ['header', 'sections'] as const
  const missing = required.filter(k => !(k in obj))
  if (missing.length > 0) {
    throw new Error(`Draft outline missing required keys: ${missing.join(', ')}. First 300 chars: ${JSON.stringify(obj).slice(0, 300)}`)
  }

  const sections: OutlineSection[] = Array.isArray(obj.sections)
    ? obj.sections.map(coerceOutlineSection).filter(Boolean) as OutlineSection[]
    : []

  return {
    header: (obj.header && typeof obj.header === 'object' ? obj.header : {}) as Record<string, any>,
    sections,
    partner_attention: Array.isArray(obj.partner_attention) ? obj.partner_attention as PartnerAttentionItem[] : [],
  }
}

function coerceOutlineSection(raw: unknown): OutlineSection | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (typeof r.section_id !== 'string') return null
  const paragraphs = Array.isArray(r.paragraphs)
    ? r.paragraphs.map((p: any, i: number) => {
        if (!p || typeof p !== 'object') return null
        return {
          id: typeof p.id === 'string' ? p.id : `p_${r.section_id}_${i + 1}`,
          section_id: r.section_id,
          order: typeof p.order === 'number' ? p.order : i + 1,
          topic: typeof p.topic === 'string' ? p.topic : '',
        }
      }).filter(Boolean)
    : []
  return { section_id: r.section_id, paragraphs: paragraphs as OutlineSection['paragraphs'] }
}

function parseFillResponse(raw: string): MemoParagraph[] {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Draft fill AI returned non-object JSON')
  }
  const obj = parsed as Record<string, unknown>
  if (!('paragraphs' in obj)) {
    throw new Error(`Draft fill response missing "paragraphs" key. First 300 chars: ${JSON.stringify(obj).slice(0, 300)}`)
  }
  return Array.isArray(obj.paragraphs)
    ? obj.paragraphs.map(coerceParagraph).filter(Boolean) as MemoParagraph[]
    : []
}

function coerceParagraph(raw: unknown): MemoParagraph | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (typeof r.section_id !== 'string') return null
  return {
    id: typeof r.id === 'string' ? r.id : `p_${r.section_id}_${Math.random().toString(36).slice(2, 6)}`,
    section_id: r.section_id,
    order: typeof r.order === 'number' ? r.order : 0,
    prose: typeof r.prose === 'string' ? r.prose : '',
    sources: Array.isArray(r.sources) ? r.sources : [],
    origin: ['agent_drafted', 'partner_drafted', 'partner_only_placeholder', 'partner_edited'].includes(r.origin)
      ? r.origin as MemoParagraph['origin']
      : 'agent_drafted',
    confidence: ['low', 'medium', 'high', 'n/a'].includes(r.confidence) ? r.confidence : 'medium',
    contains_projection: !!r.contains_projection,
    contains_unverified_claim: !!r.contains_unverified_claim,
    contains_contradiction: !!r.contains_contradiction,
  }
}

function enforceRecommendationPlaceholder(paragraphs: MemoParagraph[]): MemoParagraph[] {
  const out = paragraphs.filter(p => p.section_id !== 'recommendation')
  out.push({
    id: 'p_recommendation_placeholder',
    section_id: 'recommendation',
    order: 0,
    prose: '[Partner to complete]',
    sources: [],
    origin: 'partner_only_placeholder',
    confidence: 'n/a',
    contains_projection: false,
    contains_unverified_claim: false,
    contains_contradiction: false,
  })
  return out
}

function collectValidIds(ingestion: IngestionOutput, research: ResearchOutput | null, qa: QARecord[]) {
  const claim = new Set<string>()
  for (const doc of ingestion.documents) for (const c of doc.claims) claim.add(c.id)
  const finding = new Set<string>()
  if (research) for (const f of research.findings) finding.add(f.id)
  const qa_answer = new Set<string>()
  for (const r of qa) qa_answer.add(r.question_id)
  return { claim, finding, qa_answer }
}
