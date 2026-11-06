// Saving a memo someone other than the memo agent wrote: an assistant connected over MCP writing
// from the brief (diligence_draft_memo), or a partner's edited Word file (Word re-import). Either way
// it becomes a NEW open draft for the deal, carrying the same evidence as the draft before it, with
// its citations, its provenance and the review's flags. Nothing here finalizes a memo.
//
// Also: research findings an assistant found with its own tools (diligence_add_research), added to
// the deal's evidence so a memo can cite them.

import type { SupabaseClient } from '@supabase/supabase-js'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { briefSources, latestDraftRow, loadMemoBrief, type BriefSection, type MemoBrief } from './brief'
import { refToSource, reviewMemo, sourceToRef, type ReviewFlag } from './review'
import { MEMO_SKILL_VERSION } from './skill'
import type { MemoDraftOutput, MemoParagraph } from './stages/draft'
import type { ResearchOutput } from './stages/research'
import { readMemoDocx } from './render/design-template'
import { matchImported, type ImportChange } from './word-import'

type Admin = SupabaseClient

export type WrittenBy = 'memo_agent' | 'assistant' | 'import' | 'partner'

export interface ParagraphInput {
  /** The section's id or title. */
  section: string
  text: string
  /** Brief refs this paragraph rests on. */
  sources?: string[]
}

export interface SaveMemoInput {
  paragraphs: ParagraphInput[]
  header?: Partial<Record<'company_name' | 'sector' | 'stage' | 'round_size' | 'valuation' | 'memo_date' | 'location' | 'website', string>>
  /** Things a partner must look at before the memo is final. */
  attention?: Array<{ body: string; urgency?: 'must_address' | 'should_address' | 'fyi'; sources?: string[] }>
  /** What the writer found hard or is least sure of. */
  notes?: string
}

export const PARTNER_PLACEHOLDER = '[Partner to complete]'
const MAX_PARAGRAPHS = 200
const MAX_TEXT = 8000

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()

export function resolveSection(sections: BriefSection[], ref: string): BriefSection | null {
  const r = norm(ref)
  return sections.find(s => s.id === ref || norm(s.id) === r) ?? sections.find(s => norm(s.title) === r) ?? null
}

/** The next draft version after `prev`, tagged with who wrote it: v0.3 → v0.4-assistant. */
export function nextDraftVersion(prev: string | null | undefined, tag: string): string {
  const m = /^v(\d+)\.(\d+)/.exec(prev ?? '')
  return `${m ? `v${m[1]}.${Number(m[2]) + 1}` : 'v0.2'}-${tag}`
}

/** The paragraphs a memo is made of, from what a writer gave: sections resolved, refs turned into sources. */
export function buildParagraphs(sections: BriefSection[], input: ParagraphInput[], origin: MemoParagraph['origin'], partnerWrites = false): {
  paragraphs: MemoParagraph[]
  problems: ReviewFlag[]
} {
  const problems: ReviewFlag[] = []
  const paragraphs: MemoParagraph[] = []
  const counters = new Map<string, number>()
  for (const p of input) {
    const text = String(p.text ?? '').trim()
    if (!text) continue
    const section = resolveSection(sections, String(p.section ?? ''))
    const sectionId = section?.id ?? (norm(String(p.section ?? 'other')).replace(/ /g, '_') || 'other')
    if (!section) problems.push({ kind: 'unknown_section', severity: 'check', message: `"${p.section}" is not one of the memo's sections, so it was kept as its own section.`, section: sectionId })
    if (section?.partner_only && !partnerWrites) {
      problems.push({ kind: 'recommendation_outside_section', severity: 'must_fix', message: `"${section.title}" is the partners' to write, so what was given for it was left out and the placeholder kept.`, section: section.id })
      continue
    }
    const n = (counters.get(sectionId) ?? 0) + 1
    counters.set(sectionId, n)
    const sources = (p.sources ?? []).map(r => refToSource(String(r))).filter((s): s is { source_type: string; source_id: string } => !!s)
    paragraphs.push({
      id: `p_${sectionId}_${n}`, section_id: sectionId, order: n, prose: text.slice(0, MAX_TEXT),
      sources, origin: section?.partner_only ? 'partner_drafted' : origin, confidence: 'n/a',
      contains_projection: /\b(?:project|forecast|expects?|plan|target)\w*\b/i.test(text),
      contains_unverified_claim: false, contains_contradiction: false,
    })
  }
  for (const s of sections.filter(s => s.partner_only && !paragraphs.some(p => p.section_id === s.id))) {
    paragraphs.push({
      id: `p_${s.id}_1`, section_id: s.id, order: 1, prose: PARTNER_PLACEHOLDER, sources: [],
      origin: 'partner_only_placeholder', confidence: 'n/a', contains_projection: false, contains_unverified_claim: false, contains_contradiction: false,
    })
  }
  const order = new Map(sections.map((s, i) => [s.id, i]))
  paragraphs.sort((a, b) => (order.get(a.section_id) ?? 999) - (order.get(b.section_id) ?? 999) || a.order - b.order)
  return { paragraphs, problems }
}

/** The review over a memo's paragraphs, against the brief. */
export function reviewParagraphs(brief: Pick<MemoBrief, 'claims' | 'findings' | 'qa' | 'notes' | 'facts' | 'sections'>, paragraphs: MemoParagraph[], year?: number): ReviewFlag[] {
  return reviewMemo({
    paragraphs: paragraphs.filter(p => !p.hidden).map(p => ({
      id: p.id, section_id: p.section_id, prose: p.prose, refs: (p.sources ?? []).map(sourceToRef),
      placeholder: p.origin === 'partner_only_placeholder',
    })),
    sources: briefSources(brief),
    sections: brief.sections.map(s => ({ id: s.id, title: s.title })),
    partnerOnlySections: brief.sections.filter(s => s.partner_only).map(s => s.id),
    year,
  })
}

/** Save a memo as a new open draft for the deal. */
export async function saveMemoDraft(
  admin: Admin, ctx: { fundId: string; userId: string | null }, deal: any, input: SaveMemoInput, writtenBy: Exclude<WrittenBy, 'memo_agent'>,
): Promise<Outcome<{ draft_id: string; draft_version: string; paragraphs: number; flags: ReviewFlag[] }>> {
  if (!Array.isArray(input?.paragraphs) || input.paragraphs.length === 0) return fail(400, 'Pass the memo as paragraphs: [{ section, text, sources }].')
  if (input.paragraphs.length > MAX_PARAGRAPHS) return fail(400, `At most ${MAX_PARAGRAPHS} paragraphs.`)
  const prior = await latestDraftRow(admin, ctx.fundId, deal.id)
  if (!prior) return fail(409, 'This deal has no evidence yet. Analyze its data room first (diligence_run_agent with stage "analyze").')
  const brief = await loadMemoBrief(admin, ctx.fundId, deal)
  const origin: MemoParagraph['origin'] = writtenBy === 'assistant' ? 'agent_drafted' : 'partner_edited'
  const { paragraphs, problems } = buildParagraphs(brief.sections, input.paragraphs, origin, writtenBy !== 'assistant')
  const flags = [...problems, ...reviewParagraphs(brief, paragraphs)]

  const priorHeader = (prior.memo_draft_output?.header ?? {}) as Record<string, unknown>
  const header = {
    ...priorHeader,
    company_name: input.header?.company_name ?? priorHeader.company_name ?? deal.name,
    sector: input.header?.sector ?? priorHeader.sector ?? deal.sector ?? null,
    stage: input.header?.stage ?? priorHeader.stage ?? deal.stage_at_consideration ?? null,
    round_size: input.header?.round_size ?? priorHeader.round_size ?? null,
    valuation: input.header?.valuation ?? priorHeader.valuation ?? null,
    memo_date: input.header?.memo_date ?? new Date().toISOString().slice(0, 10),
    deal_lead: priorHeader.deal_lead ?? null,
    ...(input.header?.location ? { location: input.header.location } : {}),
    ...(input.header?.website ? { website: input.header.website } : {}),
  }
  const attention = (input.attention ?? []).filter(a => a?.body?.trim()).slice(0, 50).map(a => ({
    kind: 'writer_flag',
    urgency: (['must_address', 'should_address', 'fyi'] as const).includes(a.urgency as any) ? a.urgency! : 'should_address',
    body: a.body.trim().slice(0, 2000),
    links: (a.sources ?? []).map(r => refToSource(String(r))).filter(Boolean) as Array<{ source_type: string; source_id: string }>,
  }))
  const memo: MemoDraftOutput & { agent_notes?: string } = {
    header, paragraphs, partner_attention: attention,
    ...(input.notes?.trim() ? { agent_notes: input.notes.trim().slice(0, 8000) } : {}),
  }
  const cited = new Set(paragraphs.flatMap(p => p.sources.map(sourceToRef)))
  const sources = briefSources(brief)
  const version = nextDraftVersion(prior.draft_version, writtenBy)
  const { data: created, error } = await (admin as any)
    .from('diligence_memo_drafts')
    .insert({
      deal_id: deal.id, fund_id: ctx.fundId, draft_version: version,
      agent_version: writtenBy === 'assistant' ? `investment-memo skill ${MEMO_SKILL_VERSION}` : 'word re-import',
      ingestion_output: prior.ingestion_output, research_output: prior.research_output, qa_answers: prior.qa_answers,
      memo_draft_output: memo, is_draft: true, created_by: ctx.userId,
      written_by: writtenBy, skill_version: MEMO_SKILL_VERSION, review_flags: flags,
      brief_snapshot: {
        taken_at: new Date().toISOString(),
        sections: brief.sections.map(s => ({ id: s.id, title: s.title })),
        cited: Object.fromEntries([...cited].map(r => [r, sources.get(r) ?? null])),
        counts: { claims: brief.claims.length, findings: brief.findings.length, qa: brief.qa.length, notes: brief.notes.length, facts: brief.facts.length },
      },
    })
    .select('id')
    .single()
  if (error || !created) return dbFail(error, 'memo-save-draft')
  const draftId = (created as { id: string }).id
  if (attention.length) {
    await (admin as any).from('diligence_attention_items').insert(attention.map(a => ({
      deal_id: deal.id, draft_id: draftId, fund_id: ctx.fundId, kind: a.kind, urgency: a.urgency, body: a.body, links: a.links, status: 'open',
    })))
  }
  return done({ draft_id: draftId, draft_version: version, paragraphs: paragraphs.length, flags })
}

export interface ResearchInput {
  topic: string
  /** What was found, as the memo would rely on it. */
  evidence: string
  status?: 'verified' | 'contradicted' | 'company_stated' | 'inconclusive'
  sources: Array<{ title: string; url?: string | null }>
  /** The data-room claim it checks, as a brief ref (claim:…). */
  checks?: string | null
}

/** Add findings from outside research to the deal's evidence, each with an id a memo can cite. */
export async function addResearchFindings(
  admin: Admin, ctx: { fundId: string; userId: string | null }, deal: any, findings: ResearchInput[],
): Promise<Outcome<{ draft_id: string; added: Array<{ ref: string; topic: string }> }>> {
  if (!Array.isArray(findings) || findings.length === 0) return fail(400, 'Pass findings: [{ topic, evidence, sources }].')
  if (findings.length > 25) return fail(400, 'At most 25 findings at a time.')
  for (const f of findings) {
    if (!f?.topic?.trim() || !f?.evidence?.trim()) return fail(400, 'Every finding needs a topic and the evidence.')
    if (!Array.isArray(f.sources) || !f.sources.some(s => s?.title?.trim())) return fail(400, `"${f.topic}" needs at least one source (title, and its link where there is one).`)
  }
  const draft = await latestDraftRow(admin, ctx.fundId, deal.id)
  if (!draft) return fail(409, 'This deal has no evidence yet. Analyze its data room first (diligence_run_agent with stage "analyze").')
  if (!draft.is_draft) return fail(409, "The deal's latest memo is final. Research can only be added to an open draft.")
  const research: ResearchOutput = draft.research_output ?? {
    findings: [], contradictions: [], competitive_map: { named_by_company: [], named_by_research: [] },
    founder_dossiers: [], research_gaps: [], research_mode: 'no_web_search',
  }
  const stamp = Date.now().toString(36)
  const added = findings.map((f, i) => ({
    id: `f_chat_${stamp}_${i + 1}`,
    claim_ref: f.checks ? (refToSource(f.checks)?.source_id ?? null) : null,
    topic: f.topic.trim().slice(0, 300),
    verification_status: (['verified', 'contradicted', 'company_stated', 'inconclusive'] as const).includes(f.status as any) ? f.status! : 'inconclusive',
    evidence: f.evidence.trim().slice(0, 4000),
    sources: f.sources.filter(s => s?.title?.trim()).slice(0, 10).map(s => ({
      title: s.title.trim().slice(0, 300), url: typeof s.url === 'string' && /^https?:\/\//.test(s.url) ? s.url : null, tier: 'tier_2' as const,
    })),
    origin: 'assistant',
    added_by: ctx.userId,
    added_at: new Date().toISOString(),
  }))
  const next = { ...research, findings: [...(research.findings ?? []), ...added] }
  const { error } = await (admin as any).from('diligence_memo_drafts').update({ research_output: next }).eq('id', draft.id).eq('fund_id', ctx.fundId)
  if (error) return dbFail(error, 'memo-add-research')
  return done({ draft_id: draft.id, added: added.map(f => ({ ref: `finding:${f.id}`, topic: f.topic })) })
}

const MARKERS = /\s*\((?:projection|unverified|contradiction)(?: · (?:projection|unverified|contradiction))*\)\s*$/

/**
 * A partner's edited Word memo as a new draft version: read under its headings, matched to the draft
 * it was exported from (unchanged paragraphs keep their citations), saved, and the changes listed.
 */
export async function importWordMemo(
  admin: Admin, ctx: { fundId: string; userId: string | null }, deal: any, draftId: string, bytes: Buffer,
): Promise<Outcome<{ draft_id: string; draft_version: string; changes: ImportChange[]; unmatched_sections: string[]; flags: ReviewFlag[] }>> {
  const { data: from } = await (admin as any)
    .from('diligence_memo_drafts').select('id, memo_draft_output').eq('id', draftId).eq('deal_id', deal.id).eq('fund_id', ctx.fundId).maybeSingle()
  if (!from) return fail(404, 'That memo draft was not found for this deal.')
  let read
  try {
    read = await readMemoDocx(bytes)
  } catch (e) {
    return fail(400, (e as Error).message)
  }
  const sectionsIn = read.sections
    .filter(s => !/^scor(e|ing)/i.test(s.title.trim()))
    .map(s => ({ title: s.title, paragraphs: s.paragraphs.map(p => p.replace(MARKERS, '')).filter(Boolean) }))
  if (sectionsIn.length === 0) return fail(400, 'No section headings were found in that file. Import a memo exported from this deal and edited in Word.')
  const brief = await loadMemoBrief(admin, ctx.fundId, deal)
  const prior = ((from as any).memo_draft_output?.paragraphs ?? []) as MemoParagraph[]
  const matched = matchImported(sectionsIn, brief.sections, prior)
  if (matched.paragraphs.length === 0) return fail(400, 'The file has headings but no text under them.')
  const saved = await saveMemoDraft(admin, ctx, deal, { paragraphs: matched.paragraphs, header: (from as any).memo_draft_output?.header ?? {} }, 'import')
  if (!saved.ok) return saved
  return done({ ...saved.value, changes: matched.changes, unmatched_sections: matched.unmatched })
}
