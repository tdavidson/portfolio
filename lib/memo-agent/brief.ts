// The memo brief: everything a deal's investment memo may be written from, with a citation ref on
// every item, and the memo's sections. A connected assistant writes from it (diligence_memo_brief,
// then diligence_draft_memo); the same refs resolve when the memo is reviewed and rendered.
//
// The evidence lives on the deal's latest memo draft row (ingestion_output, research_output,
// qa_answers), with the partners' notes and checklist facts in their own tables.

import type { SupabaseClient } from '@supabase/supabase-js'
import yaml from 'js-yaml'
import { ensureDefaults, getActiveSchema } from './firm-schemas'
import { effectiveSections, schemaSectionsOf } from './design-sections'
import { describeDesignTemplate } from './design'
import { MEMO_SKILL_VERSION } from './skill'
import type { IngestionOutput } from './stages/ingest'
import type { ResearchOutput } from './stages/research'
import type { QARecord } from './prompts/draft'
import type { MemoTemplateConfig } from './prompts/memo-config'
import { notableChanges, ROUND_CHANGES_SECTION_ID, roundChangesTitle, sourceRef, type RequestItem, type RoundItemChange } from '@/lib/diligence/rounds'
import { loadRounds } from '@/lib/diligence/rounds-service'
import { loadRevisionContext, paragraphAffected } from './revision'

type Admin = SupabaseClient

export interface BriefSection {
  id: string
  title: string
  /** brief | standard | detailed | comprehensive */
  depth: string
  partner_only: boolean
  /** What the fund's schema says the section covers, or the partner's note for a custom one. */
  covers: string | null
}

export interface MemoBrief {
  deal: { id: string; name: string; sector: string | null; stage: string | null; status: string | null }
  draft_id: string | null
  skill_version: string
  sections: BriefSection[]
  settings: { partner_guidance: string | null; analyst_persona: string | null; style: string | null }
  claims: Array<{ ref: string; document: string; field: string; value: string; context: string | null; criticality: string | null }>
  findings: Array<{ ref: string; topic: string; status: string; evidence: string; sources: Array<{ title: string; url: string | null }>; added_from_chat?: boolean }>
  contradictions: Array<{ topic: string; description: string; severity: string; claim_ref: string | null }>
  qa: Array<{ ref: string; question: string; answer: string }>
  notes: Array<{ ref: string; body: string; at: string }>
  facts: Array<{ ref: string; item: string; fact: string }>
  checklist: { found: number; partial: number; missing: string[]; unknown: number }
  gaps: string[]
  design: { template: string | null; headings: string[] } | null
  /**
   * The diligence round the memo is for. In a later round the memo is a revision of the prior
   * round's memo: keep paragraphs whose evidence did not change, revise those whose evidence changed,
   * add new material, never rewrite a partner's words, and write the "What changed" section first.
   */
  round: {
    number: number
    label: string
    status: 'open' | 'closed'
    revising: boolean
    prior_round_number: number | null
    /** What is new, changed or resolved in the evidence since the prior round, with refs. */
    changes: RoundItemChange[]
    /** What the prior round asked the company for. */
    requested: RequestItem[]
    /** The prior round's memo, paragraph by paragraph. */
    prior_memo: Array<{ id: string; section: string; text: string; sources: string[]; evidence_changed: boolean; partner_written: boolean }>
  } | null
}

/** The deal's latest memo draft row, with the evidence on it. */
export async function latestDraftRow(admin: Admin, fundId: string, dealId: string): Promise<any | null> {
  const { data } = await (admin as any)
    .from('diligence_memo_drafts')
    .select('id, draft_version, agent_version, is_draft, finalized_at, created_at, ingestion_output, research_output, qa_answers, memo_draft_output')
    .eq('deal_id', dealId).eq('fund_id', fundId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data ?? null
}

function schemaGuidance(memoOutputYaml: string): Map<string, { guidance: string | null; kind: string | null }> {
  const out = new Map<string, { guidance: string | null; kind: string | null }>()
  try {
    const parsed = yaml.load(memoOutputYaml) as any
    for (const s of parsed?.memo_structure?.sections ?? []) {
      if (!s?.id) continue
      const g = typeof s.guidance === 'string' ? s.guidance : typeof s.agent_behavior === 'string' ? s.agent_behavior : null
      out.set(String(s.id), { guidance: g ? g.replace(/\s+/g, ' ').trim() : null, kind: typeof s.kind === 'string' ? s.kind : null })
    }
  } catch { /* an unreadable schema leaves the sections without guidance */ }
  return out
}

/** The memo's sections for a deal: its own settings, else the design template's headings, else the schema's. */
export async function memoSections(admin: Admin, fundId: string, config: MemoTemplateConfig | null): Promise<BriefSection[]> {
  await ensureDefaults(fundId, admin as any)
  const schema = await getActiveSchema(fundId, 'memo_output', admin as any)
  const yamlText = schema?.yaml_content ?? ''
  const guide = schemaGuidance(yamlText)
  const configured = await effectiveSections(admin, fundId, config?.sections ?? null)
  const list = (configured ?? schemaSectionsOf(yamlText)) as Array<{ id: string; title: string; included?: boolean; complexity?: string; custom?: boolean; cover?: string }>
  return list
    .filter(s => s.included !== false && s.id !== 'header' && s.id !== 'appendix' && s.id !== 'scoring_summary')
    .map(s => {
      const g = guide.get(s.id)
      return {
        id: s.id,
        title: s.title,
        depth: s.complexity ?? config?.complexity ?? 'standard',
        partner_only: s.id === 'recommendation' || g?.kind === 'partner_only',
        covers: s.custom ? (s.cover ?? null) : g?.guidance ?? null,
      }
    })
}

export async function loadMemoBrief(admin: Admin, fundId: string, deal: any): Promise<MemoBrief> {
  const [draft, notesRes, itemsRes, design] = await Promise.all([
    latestDraftRow(admin, fundId, deal.id),
    (admin as any).from('diligence_notes').select('id, body, created_at').eq('deal_id', deal.id).eq('fund_id', fundId).order('created_at'),
    (admin as any).from('diligence_checklist_items').select('id, kind, label, status, partner_facts').eq('deal_id', deal.id).eq('fund_id', fundId),
    describeDesignTemplate(admin, fundId),
  ])
  const { data: docRows } = await (admin as any).from('diligence_documents').select('id, file_name').eq('deal_id', deal.id).eq('fund_id', fundId)
  const docName = new Map<string, string>(((docRows as any[]) ?? []).map(d => [d.id, d.file_name]))

  const ingestion = (draft?.ingestion_output ?? null) as IngestionOutput | null
  const research = (draft?.research_output ?? null) as ResearchOutput | null
  const qa = (Array.isArray(draft?.qa_answers) ? draft.qa_answers as QARecord[] : []).filter(r => !r.excluded && r.answer_text?.trim())
  const config = (deal.memo_template_config ?? null) as MemoTemplateConfig | null

  const claims: MemoBrief['claims'] = []
  for (const doc of ingestion?.documents ?? []) {
    for (const c of doc.claims ?? []) {
      claims.push({
        ref: `claim:${c.id}`, document: docName.get(doc.document_id) ?? doc.detected_type ?? doc.document_id,
        field: c.field, value: c.value, context: c.context || null, criticality: c.criticality ?? null,
      })
    }
  }
  const findings: MemoBrief['findings'] = (research?.findings ?? []).filter(f => !f.dismissed).map(f => ({
    ref: `finding:${f.id}`, topic: f.topic, status: f.verification_status, evidence: f.evidence,
    sources: (f.sources ?? []).map(s => ({ title: s.title, url: s.url ?? null })),
    ...((f as any).origin === 'assistant' ? { added_from_chat: true } : {}),
  }))
  const items = ((itemsRes.data as any[]) ?? []).filter(i => i.kind === 'item')
  const facts: MemoBrief['facts'] = []
  for (const i of items) {
    for (const f of Array.isArray(i.partner_facts) ? i.partner_facts : []) {
      if (f?.id && f?.text) facts.push({ ref: `fact:${i.id}/${f.id}`, item: i.label, fact: f.text })
    }
  }
  const round = await briefRound(admin, fundId, deal.id, draft)
  const sections = await memoSections(admin, fundId, config)
  if (round?.revising && round.prior_round_number && !sections.some(s => s.id === ROUND_CHANGES_SECTION_ID)) {
    sections.unshift({
      id: ROUND_CHANGES_SECTION_ID, title: roundChangesTitle(round.prior_round_number), depth: 'brief', partner_only: false,
      covers: `What the new information changed since round ${round.prior_round_number}: what is new, what changed and in which direction, which questions were answered and concerns resolved, which new ones appeared, and what it means for the case. Cite the refs in round.changes.`,
    })
  }

  const gaps = [
    ...(ingestion?.gap_analysis?.missing ?? []).filter(g => !g.dismissed).map(g => `Missing from the data room: ${g.expected_type ?? 'a document'} (${g.criticality}). ${g.rationale}`),
    ...(research?.research_gaps ?? []).filter(g => !g.dismissed).map(g => `Not found in research: ${g.topic} (${g.criticality}). ${g.rationale}`),
  ]
  return {
    deal: { id: deal.id, name: deal.name, sector: deal.sector ?? null, stage: deal.stage_at_consideration ?? null, status: deal.deal_status ?? null },
    draft_id: draft?.id ?? null,
    skill_version: MEMO_SKILL_VERSION,
    sections,
    settings: {
      partner_guidance: deal.partner_memo_guidance ?? null,
      analyst_persona: config?.analyst_persona || null,
      style: config?.style_override ?? deal.stage_at_consideration ?? null,
    },
    claims,
    findings,
    contradictions: (research?.contradictions ?? []).filter(c => !c.dismissed).map(c => ({
      topic: c.topic, description: c.description, severity: c.severity, claim_ref: c.claim_ref ? `claim:${c.claim_ref}` : null,
    })),
    qa: qa.map(r => ({ ref: `qa:${r.question_id}`, question: r.question_text ?? r.question_id, answer: r.answer_text })),
    notes: ((notesRes.data as any[]) ?? []).map(n => ({ ref: `note:${n.id}`, body: n.body, at: n.created_at })),
    facts,
    checklist: {
      found: items.filter(i => i.status === 'found').length,
      partial: items.filter(i => i.status === 'partial').length,
      missing: items.filter(i => i.status === 'missing').map(i => i.label),
      unknown: items.filter(i => i.status === 'unknown').length,
    },
    gaps,
    design: design.status === 'ready' ? { template: design.anchor.title || design.anchor.file_name, headings: design.design.headings } : null,
    round,
  }
}

/** The brief's round: which round the deal is in and, in a later round, what to revise. Null before rounds exist. */
async function briefRound(admin: Admin, fundId: string, dealId: string, draft: any | null): Promise<MemoBrief['round']> {
  try {
    const rounds = await loadRounds(admin, fundId, dealId)
    const current = rounds[rounds.length - 1]
    if (!current) return null
    const previous = rounds.length > 1 ? rounds[rounds.length - 2] : null
    const ctx = draft ? await loadRevisionContext(admin, fundId, dealId, draft) : null
    return {
      number: current.round_number,
      label: current.label,
      status: current.status,
      revising: !!ctx,
      prior_round_number: previous?.round_number ?? null,
      changes: ctx ? notableChanges(ctx.changes) : [],
      requested: previous?.request_list ?? [],
      prior_memo: (ctx?.priorParagraphs ?? []).filter(p => !p.hidden).map(p => ({
        id: p.id, section: p.section_id, text: p.prose, sources: (p.sources ?? []).map(sourceRef),
        evidence_changed: paragraphAffected(p, ctx!.affected),
        partner_written: p.origin === 'partner_edited' || p.origin === 'partner_drafted',
      })),
    }
  } catch {
    return null
  }
}

/** Every ref in a brief, with the text it stands for (what the review checks figures against). */
export function briefSources(b: Pick<MemoBrief, 'claims' | 'findings' | 'qa' | 'notes' | 'facts'>): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of b.claims) m.set(c.ref, `${c.field}: ${c.value}${c.context ? ` (${c.context})` : ''}`)
  for (const f of b.findings) m.set(f.ref, `${f.topic}: ${f.evidence}`)
  for (const q of b.qa) m.set(q.ref, `${q.question} ${q.answer}`)
  for (const n of b.notes) m.set(n.ref, n.body)
  for (const f of b.facts) m.set(f.ref, `${f.item}: ${f.fact}`)
  return m
}
