import type { ContentBlock } from '@/lib/ai/types'
import type { IngestionOutput } from '@/lib/memo-agent/stages/ingest'
import type { ResearchOutput } from '@/lib/memo-agent/stages/research'
import { stageCalibrationBlock } from './stage-calibration'

export interface QARecord {
  question_id: string
  answer_text: string
  feeds_dimensions?: string[]
  category?: string | null
  /** Set for partner-authored questions (the partner wrote the question itself). */
  question_text?: string
  /** Partner-excluded from deal evaluation — filtered out before draft/scoring. */
  excluded?: boolean
}

/** A planned (not-yet-written) paragraph from the outline pass. */
export interface OutlineParagraph {
  id: string
  section_id: string
  order: number
  topic: string
}

export interface OutlineSection {
  section_id: string
  paragraphs: OutlineParagraph[]
}

/**
 * Stage 4A — outline pass. Plans the memo structure without writing prose.
 * Small output (skeletons only) so it always fits comfortably; the heavy
 * prose generation is fanned out across per-section fill calls.
 */
export function buildDraftOutlineContent(params: {
  dealName: string
  stage: string | null
  memoOutputYaml: string
  memoTemplate?: string
  memoConfigBlock?: string
  ingestion: IngestionOutput
  research: ResearchOutput | null
  qa_answers: QARecord[]
  /** A later diligence round: what changed and the prior round's memo, to revise rather than replan. */
  revisionBlock?: string
}): ContentBlock[] {
  const text = [
    `Deal: ${params.dealName}`,
    '',
    stageCalibrationBlock(params.stage),
    ...(params.memoTemplate ? ['', params.memoTemplate] : []),
    ...(params.memoConfigBlock ? ['', params.memoConfigBlock] : []),
    '',
    `=== STAGE 4A — MEMO OUTLINE ===`,
    `Plan the memo structure. Do NOT write prose in this call.`,
    '',
    `--- MEMO SCHEMA (memo_output.yaml — section list is authoritative) ---`,
    params.memoOutputYaml,
    '',
    `--- INGESTION OUTPUT (claims with verification_status) ---`,
    summarizeIngestion(params.ingestion),
    '',
    `--- RESEARCH OUTPUT ---`,
    params.research ? summarizeResearch(params.research) : '(none)',
    '',
    `--- PARTNER Q&A ANSWERS ---`,
    summarizeQA(params.qa_answers),
    '',
    ...(params.revisionBlock ? [params.revisionBlock, ''] : []),
    OUTLINE_INSTRUCTIONS,
  ].join('\n')

  return [{ type: 'text', text }]
}

/**
 * Stage 4B — section fill. Writes prose for one batch of outlined sections.
 * Each fill call gets the full source data (for correct citation) plus the
 * complete section topic list (so it doesn't repeat content covered
 * elsewhere) but only writes the sections in `sectionsToWrite`.
 */
export function buildDraftSectionFillContent(params: {
  dealName: string
  stage: string | null
  memoTemplate?: string
  memoConfigBlock?: string
  sectionsToWrite: OutlineSection[]
  allSectionTopics: Array<{ section_id: string; topics: string[] }>
  ingestion: IngestionOutput
  research: ResearchOutput | null
  qa_answers: QARecord[]
  /** A later diligence round: the prior paragraphs of this batch's sections, and how to revise them. */
  revisionBlock?: string
}): ContentBlock[] {
  const planLines: string[] = []
  for (const sec of params.sectionsToWrite) {
    planLines.push(`## Section: ${sec.section_id}`)
    for (const p of sec.paragraphs) {
      planLines.push(`  - paragraph ${p.id} (order ${p.order}): ${p.topic}`)
    }
  }

  const fullMemoShape = params.allSectionTopics
    .map(s => `  - ${s.section_id}: ${s.topics.join(' | ')}`)
    .join('\n')

  // Shared, cacheable block: the deal context, full memo shape, ingestion /
  // research / Q&A, and instructions are identical across every section-fill
  // batch in this draft run, so cache them. Only the per-batch section plan
  // (planLines) varies — it goes in the trailing block.
  const sharedText = [
    `Deal: ${params.dealName}`,
    '',
    stageCalibrationBlock(params.stage),
    ...(params.memoTemplate ? ['', params.memoTemplate] : []),
    ...(params.memoConfigBlock ? ['', params.memoConfigBlock] : []),
    '',
    `=== STAGE 4B — WRITE MEMO SECTIONS ===`,
    `Write the prose for ONLY the sections listed under "SECTIONS TO WRITE IN THIS CALL" at the end.`,
    `Other sections are written separately — the full memo shape is listed so you avoid repeating`,
    `content that belongs elsewhere.`,
    '',
    `--- FULL MEMO SHAPE (for context — do NOT write these) ---`,
    fullMemoShape,
    '',
    `--- INGESTION OUTPUT (claims with verification_status) ---`,
    summarizeIngestion(params.ingestion),
    '',
    `--- RESEARCH OUTPUT ---`,
    params.research ? summarizeResearch(params.research) : '(none)',
    '',
    `--- PARTNER Q&A ANSWERS ---`,
    summarizeQA(params.qa_answers),
    '',
    SECTION_FILL_INSTRUCTIONS,
  ].join('\n')

  const variableText = [
    ...(params.revisionBlock ? [params.revisionBlock, ''] : []),
    `--- SECTIONS TO WRITE IN THIS CALL ---`,
    planLines.join('\n'),
  ].join('\n')

  return [
    { type: 'text', text: sharedText, cacheControl: true },
    { type: 'text', text: variableText },
  ]
}

export interface ScorePromptInput {
  dealName: string
  stage: string | null
  rubricYaml: string
  ingestion: IngestionOutput
  research: ResearchOutput | null
  qa_answers: QARecord[]
  /** The memo prose, when one has been drafted. Scoring runs without it. */
  memo_draft_output_summary: string | null
  /**
   * When set, the model scores ONLY these rubric dimension_ids in this pass.
   * Used to batch scoring across several calls so no single response runs past
   * the output-token limit. The full rubric is still provided for context.
   */
  onlyDimensionIds?: string[]
}

export function buildScoreUserContent(params: ScorePromptInput): ContentBlock[] {
  const text = [
    `Deal: ${params.dealName}`,
    '',
    stageCalibrationBlock(params.stage),
    '',
    `=== STAGE 5 — RUBRIC SCORING ===`,
    'Score every machine and hybrid dimension per the active rubric.yaml. Partner-only dimensions (e.g. team) get score=null and rationale containing supporting material.',
    'Score against stage-appropriate expectations (see calibration above) — do NOT mark a dimension down for lacking data a company at this stage would not have.',
    params.onlyDimensionIds && params.onlyDimensionIds.length > 0
      ? `IMPORTANT — for THIS pass, score ONLY these dimension_ids and omit all others from "scores" (they are scored in separate passes): ${params.onlyDimensionIds.join(', ')}.`
      : '',
    '',
    // Scoring judges the EVIDENCE. The memo is a convenience summary of that same
    // evidence, so when it hasn't been drafted yet the rubric is still fully
    // scoreable — say so explicitly rather than leaving the model to infer that a
    // missing memo means missing information.
    params.memo_draft_output_summary
      ? `--- DRAFT MEMO (high-level) ---\n${params.memo_draft_output_summary}`
      : `--- DRAFT MEMO ---\n(not drafted yet — score from the evidence below; do NOT mark a dimension down or lower its confidence merely because no memo exists)`,
    '',
    `--- INGESTION CLAIMS ---`,
    summarizeIngestion(params.ingestion),
    '',
    `--- RESEARCH FINDINGS ---`,
    params.research ? summarizeResearch(params.research) : '(none)',
    '',
    `--- PARTNER Q&A ---`,
    summarizeQA(params.qa_answers),
    '',
    SCORE_INSTRUCTIONS,
  ].join('\n')

  return [{ type: 'text', text }]
}

/**
 * Stage 4C — review pass. A stronger model reads the assembled first draft
 * and returns ONLY the paragraphs that need improvement (targeted edits), so
 * the output stays small enough to fit a single call.
 */
export function buildDraftReviewContent(params: {
  dealName: string
  stage: string | null
  paragraphs: Array<{ id: string; section_id: string; prose: string }>
  ingestion: IngestionOutput
  research: ResearchOutput | null
  qa_answers: QARecord[]
}): ContentBlock[] {
  const memoLines: string[] = []
  for (const p of params.paragraphs) {
    memoLines.push(`### ${p.section_id} — paragraph ${p.id}`)
    memoLines.push(p.prose || '(empty)')
    memoLines.push('')
  }

  const text = [
    `Deal: ${params.dealName}`,
    '',
    stageCalibrationBlock(params.stage),
    '',
    `=== STAGE 4C — MEMO REVIEW & EDIT ===`,
    `Review the first-draft memo below. Return ONLY paragraphs that need`,
    `improvement — not the whole memo.`,
    '',
    `--- FIRST-DRAFT MEMO ---`,
    memoLines.join('\n'),
    '',
    `--- INGESTION OUTPUT (claims with verification_status) ---`,
    summarizeIngestion(params.ingestion),
    '',
    `--- RESEARCH OUTPUT ---`,
    params.research ? summarizeResearch(params.research) : '(none)',
    '',
    `--- PARTNER Q&A ANSWERS ---`,
    summarizeQA(params.qa_answers),
    '',
    REVIEW_INSTRUCTIONS,
  ].join('\n')

  return [{ type: 'text', text }]
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const OUTLINE_INSTRUCTIONS = `Output JSON ONLY. Plan the memo — do NOT write prose.

{
  "header": {
    "company_name": string,
    "sector": string|null,
    "stage": string|null,
    "round_size": string|null,
    "deal_lead": null,                     // partner_only — leave null
    "memo_date": string,                   // ISO date
    "draft_version": string,
    "agent_version": "memo-agent v0.1"
  },
  "sections": [
    {
      "section_id": string,                // matches a section id from memo_output.yaml
      "paragraphs": [
        {
          "id": string,                    // "p_<section>_<n>"
          "order": integer,
          "topic": string                  // ONE concise line (max 15 words): what this paragraph covers
        }
      ]
    }
  ],
  "partner_attention": [
    {
      "kind": "unverified_material_claim" | "contradiction" | "data_room_gap" | "low_confidence_score" | "missing_qa" | "aggressive_assumption" | "partner_only_blank",
      "urgency": "must_address" | "should_address" | "fyi",
      "body": string,
      "links": [{ "source_type": string, "source_id": string }]
    }
  ]
}

This memo is an INVESTMENT ARGUMENT, not a report. Before planning sections,
decide the spine of the memo: What is the bet? What are the two or three
things that have to be true for this to be a great investment? What is the
single biggest risk? Plan the memo so it builds that argument — every
section should advance it, not just catalogue facts.

Planning rules:
  • Section set & order: if the PER-DEAL MEMO CONFIG block specifies an explicit section list, use EXACTLY that set and order (those are partner-defined and override the schema) — still excluding "scoring_summary" and "appendix" if present. Otherwise, include every section from memo_output.yaml EXCEPT "scoring_summary" and "appendix" (those come from later stages).
  • Plan FEWER, sharper paragraphs over exhaustive coverage. A section that makes one clear point in two paragraphs beats one that makes five diffuse ones. Only plan a paragraph if it earns its place in the argument.
  • The "recommendation" section gets exactly ONE paragraph with topic "[partner-only placeholder]".
  • The "team" section SHOULD plan MULTIPLE paragraphs: (a) factual_summary — per-founder background; (b) prior_work — what each founder built/shipped/led, with sourced specifics; (c) public_output — papers, talks, OSS, public writing; (d) references_to_qa — partner Q&A about the team. Plus placeholder paragraphs for character_assessment and founder_market_fit_judgment.
  • Each "topic" is one concise line describing the POINT the paragraph makes (e.g. "why the wedge into mid-market is defensible"), not the facts it lists. The section-fill step has the full source data and will pick exact citations.
  • Surface genuine concerns as partner_attention items — but calibrate to stage (see calibration above): do not raise the absence of late-stage data as something the partner must address.`

const SECTION_FILL_INSTRUCTIONS = `Output JSON ONLY. Write prose for the planned paragraphs.

{
  "paragraphs": [
    {
      "id": string,                        // echo the planned paragraph id
      "section_id": string,                // echo the planned section id
      "order": integer,                    // echo the planned order
      "prose": string,                     // Investigative prose — see writing standards below. Length serves the point; do not pad to a target.
      "sources": [
        {
          "source_type": "claim" | "finding" | "qa_answer" | "assumption" | "partner_only" | "gap",
          "source_id": string,
          "span": string|null
        }
      ],
      "origin": "agent_drafted" | "partner_only_placeholder",
      "confidence": "low" | "medium" | "high" | "n/a",
      "contains_projection": boolean,
      "contains_unverified_claim": boolean,
      "contains_contradiction": boolean
    }
  ]
}

WRITING STANDARDS — this is what the partner feedback is about. Follow closely:
  • Be INVESTIGATIVE, not a reporter. Lead with what the evidence MEANS for the
    investment decision — the judgment, the implication, the "so what" — then
    support it. Do not catalogue facts and leave the reader to interpret them.
  • Tell a STORY. The memo should read as a connected argument: each paragraph
    follows from the last and advances the case. Use transitions. Don't write
    a list of disconnected observations.
  • Write the way an experienced partner writes to their own partnership —
    direct, opinionated, plain-spoken, willing to take a view. Not hedged
    corporate prose, not marketing language.
  • Be CONCISE. Vary length to serve the point — a sharp two-sentence
    observation can outweigh a dense paragraph. Cut anything that doesn't
    advance the argument. Density is a flaw, not a virtue.
  • Sourcing supports the point; it is not the point. Cite to back a claim,
    but never let citation crowd out insight.
  • Match the stage (see calibration above). Frame early-stage uncertainty as
    normal; do not write as though missing late-stage data is a red flag.

Hard rules:
  • Write a paragraph for every planned paragraph in the sections to write — match the planned id, section_id, order.
  • If the plan includes the "recommendation" section: emit it as origin="partner_only_placeholder", prose="[Partner to complete]", sources=[], confidence="n/a", contains_*=false. Do NOT draft a recommendation.
  • Team placeholder paragraphs (character_assessment, founder_market_fit_judgment) get origin="partner_only_placeholder", prose="[Partner to complete]". Do NOT interpret character or fit. Do NOT score the team.
  • Every agent_drafted paragraph MUST have at least one source.
  • Every paragraph that mentions a forward-looking number sets contains_projection=true.
  • Every paragraph relying on an unverified claim sets contains_unverified_claim=true.
  • Cite source_ids that actually appear in the input data above. Never invent ids.`

const REVIEW_INSTRUCTIONS = `Output JSON ONLY. Return ONLY paragraphs that genuinely need improvement.

{
  "edits": [
    {
      "paragraph_id": string,            // must match a paragraph id from the first-draft memo above
      "revised_prose": string,           // the improved paragraph text
      "reason": string                   // one line: what was wrong and what you fixed
    }
  ]
}

You are the senior editor. Read the whole draft, then fix what's weak —
prioritise the partner's feedback that the memo reads as a dense report
rather than an investigative argument:

  1. Story & flow — does the memo build a connected argument? Fix paragraphs
     that read as disconnected observations; add the through-line so each
     point follows from the last.
  2. Insight over reporting — rewrite paragraphs that catalogue facts without
     saying what they MEAN for the decision. Lead with the judgment.
  3. Density — tighten flabby, overlong, or padded paragraphs. Cut anything
     that doesn't advance the argument. Shorter and sharper is better.
  4. Voice — replace hedged, corporate, or marketing-flavoured prose with
     direct, opinionated partner-style writing.
  5. Stage fit — rewrite anything that penalises the company for lacking
     data it can't be expected to have at this stage (see calibration above).
  6. Sourcing accuracy — fix prose that asserts more than the source supports,
     or reads as verified when the claim is company-stated/unverified.

Rules:
  • Do NOT return paragraphs that are already good. An empty edits array is valid.
  • Do NOT rewrite partner_only_placeholder paragraphs (prose "[Partner to complete]"). Leave them alone.
  • Do NOT draft a recommendation or score the team.
  • Do NOT pad paragraphs to a length target — tightening is an improvement.
  • revised_prose replaces the paragraph's prose verbatim — return the full improved paragraph, not a diff.`

const SCORE_INSTRUCTIONS = `Output JSON ONLY:

{
  "scores": [
    {
      "dimension_id": string,                  // from rubric.yaml dimensions
      "mode": "machine" | "hybrid" | "partner_only",  // echo from rubric
      "score": integer|null,                   // 1-5; null when partner_only or low_confidence
      "confidence": "low" | "medium" | "high" | null,
      "rationale": string,                     // 1-3 sentences. For partner_only this is supporting material, not a justification
      "supporting_evidence": [
        { "source_type": "claim" | "finding" | "qa_answer", "source_id": string }
      ]
    }
  ],
  "low_confidence_attention": [
    { "dimension_id": string, "reason": string }
  ]
}

Hard rules:
  • Partner-only dimensions (mode=partner_only): score=null, confidence=null, rationale = compiled supporting material.
  • For machine and hybrid dimensions, only assign a numeric score when confidence ≥ medium. Otherwise leave score=null and surface the dimension in low_confidence_attention.
  • The "team" dimension is partner-only — never produce a numeric team score.`

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarizeIngestion(out: IngestionOutput): string {
  const parts: string[] = []
  for (const doc of out.documents) {
    parts.push(`# ${doc.detected_type} (${doc.document_id})`)
    if (doc.summary) parts.push(doc.summary)
    for (const c of doc.claims) {
      parts.push(`  • [${c.criticality}] ${c.id} · ${c.field} = ${c.value}${c.context ? ` (${c.context})` : ''}`)
    }
  }
  const activeMissing = out.gap_analysis.missing.filter(g => !g.dismissed)
  if (activeMissing.length > 0) {
    parts.push(`# Missing`)
    for (const g of activeMissing) parts.push(`  • [${g.criticality}] ${g.expected_type ?? '?'}: ${g.rationale}`)
  }
  if (out.cross_doc_flags.length > 0) {
    parts.push(`# Cross-doc flags`)
    for (const f of out.cross_doc_flags) parts.push(`  • ${f.description}`)
  }
  return parts.join('\n')
}

function summarizeResearch(out: ResearchOutput): string {
  const parts: string[] = []
  for (const f of out.findings) {
    parts.push(`finding ${f.id} [${f.verification_status}] ${f.topic}: ${f.evidence}`)
  }
  for (const c of out.contradictions) {
    parts.push(`contradiction (${c.severity}) ${c.topic}: ${c.description}`)
  }
  for (const g of out.research_gaps) {
    parts.push(`gap [${g.criticality}] ${g.topic}: ${g.rationale}`)
  }
  for (const f of out.founder_dossiers) {
    parts.push(`founder ${f.founder_name} (${f.role}): ${f.background_summary}`)
  }
  return parts.join('\n')
}

function summarizeQA(records: QARecord[]): string {
  if (records.length === 0) return '(no Q&A captured)'
  return records.map(r => {
    // Partner-authored questions carry their own text; agent questions are
    // identified by id. Tag partner questions so the draft can weight them.
    const label = r.question_text
      ? `Partner question — "${r.question_text}"`
      : `${r.question_id}${r.category ? ` [${r.category}]` : ''}`
    return `${label}: ${r.answer_text}`
  }).join('\n')
}
