// Revising the memo in a later diligence round. Round 2's memo is round 1's memo revised, not a
// fresh one: paragraphs whose evidence did not change stay word for word, paragraphs whose evidence
// changed are rewritten, new material gets new paragraphs, and a "What changed since Round N"
// section opens the memo. A partner's own words are never rewritten by the agent; when the evidence
// under one changes, the partner is told instead.
//
// The pure part (prompt blocks, applying the revision) is tested in revision.test.ts; loading the
// context is the one database read.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  affectedPriorRefs, describeChangesForPrompt, diffRoundEvidence, ROUND_CHANGES_SECTION_ID, roundChangesTitle, sourceRef,
  type MemoRevision, type RoundChanges,
} from '@/lib/diligence/rounds'
import { loadRounds, roundDraft } from '@/lib/diligence/rounds-service'
import type { MemoParagraph, PartnerAttentionItem } from './stages/draft'

export interface RevisionContext {
  roundNumber: number
  priorRoundNumber: number
  changes: RoundChanges
  /** Prior-round refs whose item changed or went away. */
  affected: Set<string>
  /** The prior round's memo paragraphs, without its own "What changed" section. */
  priorParagraphs: MemoParagraph[]
}

const PARTNER_ORIGINS = new Set(['partner_edited', 'partner_drafted'])

/**
 * The revision context for a draft, or null when the draft is in round 1, its round has no previous
 * round with a written memo, or the database predates rounds.
 */
export async function loadRevisionContext(
  admin: SupabaseClient, fundId: string, dealId: string, draft: { id: string; ingestion_output: unknown; research_output: unknown; qa_answers: unknown },
): Promise<RevisionContext | null> {
  try {
    const { data: row, error } = await (admin as any).from('diligence_memo_drafts').select('round_id').eq('id', draft.id).eq('fund_id', fundId).maybeSingle()
    if (error || !row?.round_id) return null
    const rounds = await loadRounds(admin, fundId, dealId)
    const round = rounds.find(r => r.id === row.round_id)
    if (!round) return null
    const previous = rounds.filter(r => r.round_number < round.round_number).pop()
    if (!previous) return null
    const prior = await roundDraft(admin, fundId, previous.id)
    const priorParagraphs = ((prior?.memo_draft_output?.paragraphs ?? []) as MemoParagraph[])
      .filter(p => p.section_id !== ROUND_CHANGES_SECTION_ID)
    if (priorParagraphs.length === 0) return null
    const changes = diffRoundEvidence(prior, draft)
    return { roundNumber: round.round_number, priorRoundNumber: previous.round_number, changes, affected: affectedPriorRefs(changes), priorParagraphs }
  } catch (err) {
    console.error('[memo-revision-context]', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** True when any of a prior paragraph's sources changed or went away this round. */
export function paragraphAffected(p: MemoParagraph, affected: Set<string>): boolean {
  return (p.sources ?? []).some(s => affected.has(sourceRef(s)))
}

function priorParagraphLine(p: MemoParagraph, affected: Set<string>): string {
  const tag = PARTNER_ORIGINS.has(p.origin)
    ? 'PARTNER-WRITTEN (do not rewrite)'
    : p.origin === 'partner_only_placeholder' ? 'PARTNER PLACEHOLDER'
      : paragraphAffected(p, affected) ? 'EVIDENCE CHANGED' : 'EVIDENCE UNCHANGED'
  const refs = (p.sources ?? []).map(sourceRef).join(', ')
  return `  - ${p.id} (order ${p.order}) [${tag}]${refs ? ` [sources: ${refs}]` : ''}: ${p.prose.replace(/\s+/g, ' ').trim()}`
}

/** The prior memo by section, each paragraph tagged with whether its evidence changed. */
export function priorMemoText(ctx: RevisionContext, sectionIds?: string[]): string {
  const wanted = sectionIds ? new Set(sectionIds) : null
  const bySection = new Map<string, MemoParagraph[]>()
  for (const p of ctx.priorParagraphs) {
    if (wanted && !wanted.has(p.section_id)) continue
    if (!bySection.has(p.section_id)) bySection.set(p.section_id, [])
    bySection.get(p.section_id)!.push(p)
  }
  if (bySection.size === 0) return '(the prior memo has no paragraphs in these sections)'
  const lines: string[] = []
  for (const [sec, paras] of bySection) {
    lines.push(`## Section: ${sec}`)
    for (const p of paras.slice().sort((a, b) => a.order - b.order)) lines.push(priorParagraphLine(p, ctx.affected))
  }
  return lines.join('\n')
}

/** The revision block for the outline call: what changed, the prior memo, and how to plan from it. */
export function revisionOutlineBlock(ctx: RevisionContext): string {
  return [
    `=== REVISION: ROUND ${ctx.roundNumber} OF DILIGENCE ===`,
    `This memo already exists from round ${ctx.priorRoundNumber}. REVISE it; do not plan a new memo.`,
    `  • Keep the prior memo's sections and paragraphs. Reuse a prior paragraph's id as the planned id whenever the planned paragraph continues it.`,
    `  • A paragraph tagged EVIDENCE UNCHANGED or PARTNER-WRITTEN keeps its id and its point.`,
    `  • A paragraph tagged EVIDENCE CHANGED keeps its id; its topic says what has to change.`,
    `  • Plan a NEW paragraph (a new id) only for material that the prior memo does not cover.`,
    `  • Drop a prior paragraph only when everything it rests on is gone.`,
    `  • Do not plan the "${ROUND_CHANGES_SECTION_ID}" section; it is written separately.`,
    '',
    `--- WHAT CHANGED IN THE EVIDENCE SINCE ROUND ${ctx.priorRoundNumber} ---`,
    describeChangesForPrompt(ctx.changes, ctx.priorRoundNumber),
    '',
    `--- THE ROUND ${ctx.priorRoundNumber} MEMO ---`,
    priorMemoText(ctx),
  ].join('\n')
}

/** The revision block for one fill call: the prior paragraphs of the sections it writes. */
export function revisionFillBlock(ctx: RevisionContext, sectionIds: string[]): string {
  return [
    `=== REVISION: ROUND ${ctx.roundNumber} OF DILIGENCE ===`,
    `You are revising the round ${ctx.priorRoundNumber} memo, not writing a new one. For each planned paragraph that`,
    `reuses a prior paragraph's id:`,
    `  • EVIDENCE UNCHANGED: return the prior prose exactly as written, with "revision": "kept".`,
    `  • EVIDENCE CHANGED: rewrite it so it is true to the current evidence, with "revision": "revised".`,
    `  • PARTNER-WRITTEN: return the prior prose exactly as written, with "revision": "kept". Never rewrite a partner's words.`,
    `A planned paragraph with a new id is new material: write it with "revision": "new".`,
    `Add the "revision" field to every paragraph object you return.`,
    '',
    `--- WHAT CHANGED IN THE EVIDENCE SINCE ROUND ${ctx.priorRoundNumber} ---`,
    describeChangesForPrompt(ctx.changes, ctx.priorRoundNumber),
    '',
    `--- THE ROUND ${ctx.priorRoundNumber} MEMO, SECTIONS IN THIS CALL ---`,
    priorMemoText(ctx, sectionIds),
  ].join('\n')
}

export type RoundStatus = 'kept' | 'revised' | 'new'

/**
 * Apply the revision rules to the newly written paragraphs, whatever the model returned:
 *  - a prior paragraph whose evidence did not change, returned as kept, keeps its exact prior prose;
 *  - a partner's paragraph is always restored word for word, even when the model dropped or rewrote
 *    it, and when the evidence under it changed the partner gets an attention item instead;
 *  - every paragraph is marked kept, revised or new for the editor.
 */
export function applyRevision(
  paragraphs: Array<MemoParagraph & { revision?: string }>, ctx: RevisionContext,
): { paragraphs: Array<MemoParagraph & { round_status: RoundStatus }>; attention: PartnerAttentionItem[] } {
  const prior = new Map(ctx.priorParagraphs.map(p => [p.id, p]))
  const attention: PartnerAttentionItem[] = []
  const out: Array<MemoParagraph & { round_status: RoundStatus }> = []

  for (const p of paragraphs) {
    const { revision, ...para } = p
    const was = prior.get(p.id)
    if (!was) { out.push({ ...para, round_status: 'new' }); continue }
    if (PARTNER_ORIGINS.has(was.origin)) continue // restored below, verbatim
    const unchanged = !paragraphAffected(was, ctx.affected)
    if (unchanged && (revision === 'kept' || norm(p.prose) === norm(was.prose))) {
      out.push({ ...was, round_status: 'kept' })
    } else {
      out.push({ ...para, round_status: norm(p.prose) === norm(was.prose) ? 'kept' : 'revised' })
    }
  }

  // The partners' own paragraphs come back as they wrote them, in place of anything the model did.
  for (const was of ctx.priorParagraphs) {
    if (!PARTNER_ORIGINS.has(was.origin)) continue
    if (was.section_id === 'recommendation') {
      // A written recommendation replaces the placeholder the draft always plants.
      for (let i = out.length - 1; i >= 0; i--) if (out[i].section_id === 'recommendation' && out[i].origin === 'partner_only_placeholder') out.splice(i, 1)
    }
    out.push({ ...was, round_status: 'kept' })
    if (paragraphAffected(was, ctx.affected)) {
      attention.push({
        kind: 'round_evidence_changed',
        urgency: 'should_address',
        body: `The evidence behind your paragraph in "${was.section_id}" changed in round ${ctx.roundNumber}. It was kept as you wrote it; check it against this round's changes.`,
        links: (was.sources ?? []).map(s => ({ source_type: s.source_type, source_id: s.source_id })),
      })
    } else if (was.section_id === 'recommendation') {
      attention.push({
        kind: 'round_recommendation_carried',
        urgency: 'fyi',
        body: `The recommendation is carried over from round ${ctx.priorRoundNumber}. Review it against what changed in round ${ctx.roundNumber}.`,
        links: [],
      })
    }
  }
  return { paragraphs: out, attention }
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The memo's revision marker. */
export function revisionMarker(ctx: RevisionContext): MemoRevision {
  return { round_number: ctx.roundNumber, prior_round_number: ctx.priorRoundNumber, title: roundChangesTitle(ctx.priorRoundNumber) }
}

/** The prompt for the "What changed since Round N" section. */
export function roundChangesPrompt(params: { dealName: string; ctx: RevisionContext }): string {
  const { ctx } = params
  return [
    `Deal: ${params.dealName}`,
    '',
    `=== WRITE THE "${roundChangesTitle(ctx.priorRoundNumber).toUpperCase()}" SECTION ===`,
    `This opens the round ${ctx.roundNumber} investment memo. Partners who read the round ${ctx.priorRoundNumber} memo read this`,
    `first, to learn what the new information changed in the case. Write 1 to 4 short paragraphs (a bulleted list`,
    `of "- " lines counts as one paragraph): what is new, what changed and in which direction, which open questions`,
    `were answered, which concerns went away and which new ones appeared, and what it means for the investment case.`,
    `Lead with what matters most to the decision. Do not restate everything that stayed the same. Do not make a`,
    `recommendation and do not judge the team. Cite the refs given below.`,
    '',
    `--- WHAT CHANGED IN THE EVIDENCE SINCE ROUND ${ctx.priorRoundNumber} ---`,
    describeChangesForPrompt(ctx.changes, ctx.priorRoundNumber),
    '',
    `Output JSON ONLY:`,
    `{ "paragraphs": [ { "prose": string, "sources": [ { "source_type": "claim" | "finding" | "qa_answer", "source_id": string } ] } ] }`,
    `A ref "claim:abc" is source_type "claim", source_id "abc"; "qa:xyz" is source_type "qa_answer". Cite only refs listed above.`,
  ].join('\n')
}

/** The "What changed" paragraphs from the model's JSON. */
export function roundChangesParagraphs(parsed: unknown): MemoParagraph[] {
  const list = (parsed as { paragraphs?: unknown })?.paragraphs
  if (!Array.isArray(list)) return []
  return list
    .filter((p: any) => p && typeof p.prose === 'string' && p.prose.trim())
    .slice(0, 6)
    .map((p: any, i: number) => ({
      id: `p_${ROUND_CHANGES_SECTION_ID}_${i + 1}`,
      section_id: ROUND_CHANGES_SECTION_ID,
      order: i + 1,
      prose: p.prose.trim(),
      sources: (Array.isArray(p.sources) ? p.sources : [])
        .filter((s: any) => s && typeof s.source_type === 'string' && typeof s.source_id === 'string')
        .map((s: any) => ({ source_type: s.source_type, source_id: s.source_id })),
      origin: 'agent_drafted' as const,
      confidence: 'medium' as const,
      contains_projection: false,
      contains_unverified_claim: false,
      contains_contradiction: false,
    }))
}
