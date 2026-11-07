// Diligence rounds, the pure part: what changed in the evidence from one round to the next, which
// of the prior memo's sources those changes touch, the follow-up request list a closing round
// leaves, and where the memo's "What changed" section goes. No server imports.
//
// A round's evidence is its latest memo draft row (ingestion_output, research_output, qa_answers).
// Item ids are not stable across runs (a re-analyzed document gets new claim ids, a research run
// renumbers its findings), so items are matched on what they are about: a claim on its document and
// field, a finding or contradiction on its topic, a gap on what is missing, a Q&A answer on its
// question. Partner-dismissed items count as gone.

import type { IngestionOutput } from '@/lib/memo-agent/stages/ingest'
import type { ResearchOutput } from '@/lib/memo-agent/stages/research'
import type { QARecord } from '@/lib/memo-agent/prompts/draft'

export const ROUND_OUTCOMES = ['advance', 'hold', 'pass', 'invest'] as const
export type RoundOutcome = typeof ROUND_OUTCOMES[number]

export const ROUND_OUTCOME_LABEL: Record<RoundOutcome, string> = {
  advance: 'Advance to next round',
  hold: 'Hold',
  pass: 'Pass',
  invest: 'Invest',
}

/** Default names for a deal's rounds; partners rename them freely. */
export function defaultRoundLabel(roundNumber: number): string {
  if (roundNumber <= 1) return 'Initial data room'
  if (roundNumber === 2) return 'Follow-up request'
  return 'Continued diligence'
}

export interface EvidenceSnapshot {
  ingestion_output?: unknown
  research_output?: unknown
  qa_answers?: unknown
}

export type ChangeKind = 'claim' | 'finding' | 'contradiction' | 'gap' | 'cross_doc_flag' | 'qa'
export type ChangeStatus = 'new' | 'changed' | 'confirmed' | 'resolved'

export const CHANGE_KINDS: ChangeKind[] = ['claim', 'finding', 'contradiction', 'gap', 'cross_doc_flag', 'qa']
export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  claim: 'Data room claims',
  finding: 'Research findings',
  contradiction: 'Contradictions',
  gap: 'Gaps',
  cross_doc_flag: 'Cross-document flags',
  qa: 'Partner Q&A',
}

export interface RoundItemChange {
  kind: ChangeKind
  /** What the item is matched on across rounds. */
  key: string
  status: ChangeStatus
  /** The item's brief ref in this round (claim:…, finding:…, qa:…), null when resolved or it has none. */
  ref: string | null
  /** Its ref in the previous round, null when new. */
  prior_ref: string | null
  label: string
  detail: string
  /** What it said in the previous round, when it changed. */
  prior_detail?: string | null
}

export interface RoundChanges {
  items: RoundItemChange[]
  counts: Record<ChangeKind, Record<ChangeStatus, number>>
  /** True when there is no previous round to compare with (round 1). */
  first_round: boolean
}

interface Indexed {
  key: string
  ref: string | null
  label: string
  detail: string
  /** What has to differ for the item to count as changed. */
  fingerprint: string
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}%$.]+/gu, ' ').replace(/\s+/g, ' ').trim()

function asIngestion(v: unknown): IngestionOutput | null {
  return v && typeof v === 'object' ? v as IngestionOutput : null
}
function asResearch(v: unknown): ResearchOutput | null {
  return v && typeof v === 'object' ? v as ResearchOutput : null
}
function asQA(v: unknown): QARecord[] {
  return Array.isArray(v) ? v as QARecord[] : []
}

/** Keys made unique within a round: a second claim on the same field gets "#2", and so on. */
function uniquify(rows: Indexed[]): Indexed[] {
  const seen = new Map<string, number>()
  return rows.map(r => {
    const n = (seen.get(r.key) ?? 0) + 1
    seen.set(r.key, n)
    return n === 1 ? r : { ...r, key: `${r.key}#${n}` }
  })
}

/** Every item of one kind in a round's evidence, by its match key. */
export function indexEvidence(snapshot: EvidenceSnapshot | null): Record<ChangeKind, Map<string, Indexed>> {
  const out = Object.fromEntries(CHANGE_KINDS.map(k => [k, new Map<string, Indexed>()])) as Record<ChangeKind, Map<string, Indexed>>
  if (!snapshot) return out
  const ingestion = asIngestion(snapshot.ingestion_output)
  const research = asResearch(snapshot.research_output)
  const qa = asQA(snapshot.qa_answers)

  const put = (kind: ChangeKind, rows: Indexed[]) => {
    for (const r of uniquify(rows)) if (r.key) out[kind].set(r.key, r)
  }

  put('claim', (ingestion?.documents ?? []).flatMap(doc => (doc.claims ?? []).map(c => ({
    key: `${doc.document_id}|${norm(c.field)}`,
    ref: c.id ? `claim:${c.id}` : null,
    label: c.field,
    detail: c.value,
    fingerprint: norm(c.value),
  }))))

  put('finding', (research?.findings ?? []).filter(f => !f.dismissed).map(f => ({
    key: norm(f.topic),
    ref: f.id ? `finding:${f.id}` : null,
    label: f.topic,
    detail: `${humanize(f.verification_status)}: ${f.evidence}`,
    // Research rewords its evidence on every run; only a new verdict is a change.
    fingerprint: f.verification_status,
  })))

  put('contradiction', (research?.contradictions ?? []).filter(c => !c.dismissed).map(c => ({
    key: norm(c.topic),
    ref: null,
    label: c.topic,
    detail: `${humanize(c.severity)}: ${c.description}`,
    fingerprint: c.severity,
  })))

  const gaps: Indexed[] = []
  for (const [bucket, list] of [['missing', ingestion?.gap_analysis?.missing ?? []], ['inadequate', ingestion?.gap_analysis?.inadequate ?? []]] as const) {
    for (const g of list) {
      if (g.dismissed) continue
      const what = g.expected_type ?? g.document_id ?? g.rationale
      gaps.push({
        key: `${bucket}|${norm(what)}`,
        ref: null,
        label: `${bucket === 'missing' ? 'Missing' : 'Inadequate'}: ${humanize(g.expected_type ?? 'document')}`,
        detail: g.rationale,
        fingerprint: g.criticality,
      })
    }
  }
  for (const g of research?.research_gaps ?? []) {
    if (g.dismissed) continue
    gaps.push({ key: `research|${norm(g.topic)}`, ref: null, label: `Research gap: ${g.topic}`, detail: g.rationale, fingerprint: g.criticality })
  }
  put('gap', gaps)

  put('cross_doc_flag', (ingestion?.cross_doc_flags ?? []).filter(f => !f.dismissed).map(f => ({
    key: norm(f.description),
    ref: null,
    label: 'Cross-document flag',
    detail: f.description,
    fingerprint: f.severity ?? '',
  })))

  put('qa', qa.filter(r => !r.excluded && String(r.answer_text ?? '').trim()).map(r => ({
    key: r.question_text ? `q|${norm(r.question_text)}` : `id|${r.question_id}`,
    ref: r.question_id ? `qa:${r.question_id}` : null,
    label: r.question_text ?? r.question_id,
    detail: r.answer_text,
    fingerprint: norm(r.answer_text),
  })))

  return out
}

function humanize(id: string): string {
  const s = id.replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function emptyCounts(): RoundChanges['counts'] {
  return Object.fromEntries(CHANGE_KINDS.map(k => [k, { new: 0, changed: 0, confirmed: 0, resolved: 0 }])) as RoundChanges['counts']
}

/**
 * What changed in the evidence from the previous round to this one. Without a previous round
 * (round 1) everything is new.
 */
export function diffRoundEvidence(prev: EvidenceSnapshot | null, curr: EvidenceSnapshot | null): RoundChanges {
  const before = indexEvidence(prev)
  const after = indexEvidence(curr)
  const items: RoundItemChange[] = []
  const counts = emptyCounts()

  for (const kind of CHANGE_KINDS) {
    for (const [key, now] of after[kind]) {
      const was = before[kind].get(key)
      const status: ChangeStatus = !was ? 'new' : was.fingerprint === now.fingerprint ? 'confirmed' : 'changed'
      items.push({
        kind, key, status, ref: now.ref, prior_ref: was?.ref ?? null, label: now.label, detail: now.detail,
        ...(status === 'changed' ? { prior_detail: was!.detail } : {}),
      })
      counts[kind][status] += 1
    }
    for (const [key, was] of before[kind]) {
      if (after[kind].has(key)) continue
      items.push({ kind, key, status: 'resolved', ref: null, prior_ref: was.ref, label: was.label, detail: was.detail })
      counts[kind].resolved += 1
    }
  }

  return { items, counts, first_round: prev === null }
}

/** The changes worth reading: everything but what was simply confirmed. */
export function notableChanges(changes: RoundChanges): RoundItemChange[] {
  return changes.items.filter(i => i.status !== 'confirmed')
}

/** Brief refs (in the previous round's id space) whose item changed or went away this round. */
export function affectedPriorRefs(changes: RoundChanges): Set<string> {
  const out = new Set<string>()
  for (const i of changes.items) {
    if ((i.status === 'changed' || i.status === 'resolved') && i.prior_ref) out.add(i.prior_ref)
  }
  return out
}

/** A memo paragraph source as a brief ref. */
export function sourceRef(s: { source_type: string; source_id: string }): string {
  const type = s.source_type === 'qa_answer' ? 'qa' : s.source_type
  return `${type}:${s.source_id}`
}

/** A one-paragraph-per-line account of the changes, for the memo agent's revision prompt. */
export function describeChangesForPrompt(changes: RoundChanges, priorRoundNumber: number): string {
  const notable = notableChanges(changes)
  if (notable.length === 0) return `Nothing in the evidence changed since round ${priorRoundNumber}.`
  const lines: string[] = []
  for (const kind of CHANGE_KINDS) {
    const rows = notable.filter(i => i.kind === kind)
    if (rows.length === 0) continue
    lines.push(`# ${CHANGE_KIND_LABEL[kind]}`)
    for (const r of rows) {
      const ref = r.ref ?? r.prior_ref
      const tag = ref ? ` (${ref})` : ''
      if (r.status === 'changed') lines.push(`  • CHANGED${tag} ${r.label}: was "${clip(r.prior_detail)}", now "${clip(r.detail)}"`)
      else if (r.status === 'resolved') lines.push(`  • RESOLVED / NO LONGER PRESENT${tag} ${r.label}: ${clip(r.detail)}`)
      else lines.push(`  • NEW${tag} ${r.label}: ${clip(r.detail)}`)
    }
  }
  return lines.join('\n')
}

const clip = (s: unknown, n = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ---------------------------------------------------------------------------
// The follow-up request list
// ---------------------------------------------------------------------------

export type RequestPriority = 'high' | 'medium' | 'low'

export interface RequestItem {
  source: 'checklist' | 'attention' | 'gap'
  label: string
  detail: string | null
  priority: RequestPriority
}

export interface RequestListInput {
  checklist: Array<{ kind: string; label: string; status: string; section?: string | null }>
  attention: Array<{ urgency: string; status: string; body: string }>
  ingestion_output?: unknown
  research_output?: unknown
}

const PRIORITY_RANK: Record<RequestPriority, number> = { high: 0, medium: 1, low: 2 }
const GAP_PRIORITY: Record<string, RequestPriority> = { blocker: 'high', important: 'medium', nice_to_have: 'low' }

/**
 * What to ask the company for next, when a round closes: checklist items still missing or partial,
 * open attention items a partner must or should address, and the data room's and research's gaps.
 */
export function buildRequestList(input: RequestListInput): RequestItem[] {
  const out: RequestItem[] = []
  for (const c of input.checklist) {
    if (c.kind !== 'item') continue
    if (c.status === 'missing') out.push({ source: 'checklist', label: c.label, detail: c.section ?? null, priority: 'high' })
    else if (c.status === 'partial') out.push({ source: 'checklist', label: c.label, detail: c.section ? `${c.section} (partly covered)` : 'Partly covered', priority: 'medium' })
  }
  for (const a of input.attention) {
    if (a.status !== 'open') continue
    if (a.urgency === 'must_address') out.push({ source: 'attention', label: a.body, detail: null, priority: 'high' })
    else if (a.urgency === 'should_address') out.push({ source: 'attention', label: a.body, detail: null, priority: 'medium' })
  }
  const ingestion = asIngestion(input.ingestion_output)
  for (const g of [...(ingestion?.gap_analysis?.missing ?? []), ...(ingestion?.gap_analysis?.inadequate ?? [])]) {
    if (g.dismissed) continue
    out.push({ source: 'gap', label: humanize(g.expected_type ?? 'Document'), detail: g.rationale, priority: GAP_PRIORITY[g.criticality] ?? 'medium' })
  }
  const research = asResearch(input.research_output)
  for (const g of research?.research_gaps ?? []) {
    if (g.dismissed) continue
    out.push({ source: 'gap', label: g.topic, detail: g.rationale, priority: GAP_PRIORITY[g.criticality] ?? 'medium' })
  }

  // One line per thing asked for: the first (most specific) source of a label wins.
  const seen = new Set<string>()
  const unique = out.filter(r => {
    const k = norm(r.label)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique
    .map((r, i) => ({ r, i }))
    .sort((a, b) => PRIORITY_RANK[a.r.priority] - PRIORITY_RANK[b.r.priority] || a.i - b.i)
    .map(x => x.r)
}

/** The request list as plain text, to paste into an email to the company. */
export function requestListText(items: RequestItem[]): string {
  if (items.length === 0) return ''
  const group = (p: RequestPriority, title: string) => {
    const rows = items.filter(i => i.priority === p)
    if (rows.length === 0) return []
    return [title, ...rows.map(r => `- ${r.label}${r.detail && r.source !== 'attention' ? ` (${r.detail})` : ''}`), '']
  }
  return [...group('high', 'Needed'), ...group('medium', 'Helpful'), ...group('low', 'If available')].join('\n').trim()
}

// ---------------------------------------------------------------------------
// The memo's "What changed" section
// ---------------------------------------------------------------------------

export const ROUND_CHANGES_SECTION_ID = 'round_changes'

export function roundChangesTitle(priorRoundNumber: number): string {
  return `What changed since Round ${priorRoundNumber}`
}

/** A memo revision marker, stored on memo_draft_output when a later round revises the memo. */
export interface MemoRevision {
  round_number: number
  prior_round_number: number
  title: string
}

/** The section order with the "What changed" section first (after a leading header, if any). */
export function withRoundChangesFirst<T extends string | { id: string }>(order: T[]): T[] {
  const id = (x: T) => (typeof x === 'string' ? x : x.id)
  const idx = order.findIndex(x => id(x) === ROUND_CHANGES_SECTION_ID)
  if (idx <= 0) return order
  const rest = order.filter((_, i) => i !== idx)
  const at = rest.length > 0 && id(rest[0]) === 'header' ? 1 : 0
  return [...rest.slice(0, at), order[idx], ...rest.slice(at)]
}

/** The "What changed" section's title for a memo, or null when the memo has no revision marker. */
export function memoRevisionTitle(memo: unknown): string | null {
  const rev = (memo as { revision?: Partial<MemoRevision> } | null)?.revision
  if (!rev) return null
  if (typeof rev.title === 'string' && rev.title.trim()) return rev.title.trim()
  return typeof rev.prior_round_number === 'number' ? roundChangesTitle(rev.prior_round_number) : null
}
