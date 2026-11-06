// Reviewing a memo draft against the investment-memo skill's checklist, the same way whoever wrote it:
// the memo agent's draft stage, an assistant saving a memo over MCP, or a partner's Word re-import.
// The flags are stored on the draft and shown in the memo editor and to the assistant.
//
// Pure: no server imports.

export type ReviewSeverity = 'must_fix' | 'check'

export interface ReviewFlag {
  kind:
    | 'uncited' | 'unknown_source' | 'number_not_in_sources' | 'number_not_cited'
    | 'recommendation_outside_section' | 'team_judgment' | 'unlabeled_projection'
    | 'empty_section' | 'unknown_section'
  severity: ReviewSeverity
  message: string
  paragraph_id?: string
  section?: string
}

export interface ReviewParagraph {
  id: string
  section_id: string
  prose: string
  /** Citation refs, "<type>:<id>" (claim:…, finding:…, qa:…, note:…, fact:…). */
  refs: string[]
  placeholder?: boolean
}

export interface ReviewInput {
  paragraphs: ReviewParagraph[]
  /** Every ref the memo may cite, with the text it stands for. */
  sources: Map<string, string>
  /** The sections the memo should have, in order (ids), and their titles. */
  sections?: Array<{ id: string; title: string }>
  /** Partner-only sections (the recommendation). */
  partnerOnlySections?: string[]
  /** The year the memo is written in, for spotting projections. */
  year?: number
}

/** Figures worth checking: amounts, percentages, multiples and counts of 2+ digits. Years and ordinals are not. */
const FIGURE = /(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|[kKmMbB]\b|bn\b|mm\b|million\b|billion\b|thousand\b)?/g

/** A figure in a canonical form, so "1,400,000", "1.4M" and "1.4 million" compare equal. */
export function normalizeFigure(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[$€£\s]/g, '')
  const m = /^(\d[\d,]*(?:\.\d+)?)(%|x|k|m|b|bn|mm|million|billion|thousand)?$/.exec(s)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const unit = m[2] ?? ''
  if (unit === '%') return `${n}%`
  if (unit === 'x') return `${n}x`
  const mult = unit === 'k' || unit === 'thousand' ? 1e3 : unit === 'm' || unit === 'mm' || unit === 'million' ? 1e6 : unit === 'b' || unit === 'bn' || unit === 'billion' ? 1e9 : 1
  return String(Math.round(n * mult * 100) / 100)
}

/** The figures in a text that are worth checking against its sources. */
export function figuresIn(text: string): Array<{ raw: string; norm: string }> {
  const out: Array<{ raw: string; norm: string }> = []
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0].trim()
    const digits = raw.replace(/[^\d]/g, '')
    const hasUnit = /[%x]|[kmb]n?\b|mm|million|billion|thousand|[$€£]/i.test(raw)
    // Bare small numbers ("two of three", "3 customers") and four-digit years are prose, not figures.
    if (!hasUnit && (digits.length < 2 || /^(19|20)\d\d$/.test(digits) && !raw.includes(','))) continue
    const norm = normalizeFigure(raw)
    if (norm) out.push({ raw, norm })
  }
  return out
}

const RECOMMENDS = /\b(?:we|i|the (?:deal )?team) (?:recommend|propose to invest|support (?:an|the) investment|should invest|should pass)\b|\brecommend(?:ation)? (?:is )?to (?:invest|pass|proceed)\b|\bwe (?:would|will) (?:invest|pass)\b/i
const JUDGES_TEAM = /\b(?:team score|score (?:for|of) the team)\b|\bthe (?:founders?|ceo|team) (?:is|are) (?:a |an )?(?:visionary|trustworthy|honest|brilliant|world[- ]class|exceptional|weak|untrustworthy)\b/i
const PROJECTION_WORDS = /\b(?:project|projects|projected|projection|forecast|expects?|expected|plans?|planned|targets?|budget|estimate[sd]?|aims?|guidance|anticipates?)\b/i

export function reviewMemo(input: ReviewInput): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  const partnerOnly = new Set(input.partnerOnlySections ?? ['recommendation'])
  const year = input.year ?? new Date().getFullYear()
  const allSourceFigures = new Set<string>()
  for (const text of input.sources.values()) for (const f of figuresIn(text)) allSourceFigures.add(f.norm)
  const known = new Set((input.sections ?? []).map(s => s.id))

  for (const p of input.paragraphs) {
    if (p.placeholder || partnerOnly.has(p.section_id)) continue
    const at = { paragraph_id: p.id, section: p.section_id }
    if (known.size && !known.has(p.section_id)) {
      flags.push({ kind: 'unknown_section', severity: 'check', message: `"${p.section_id}" is not one of the memo's sections.`, ...at })
    }
    const unknown = p.refs.filter(r => !input.sources.has(r))
    const cited = p.refs.filter(r => input.sources.has(r))
    if (unknown.length) {
      flags.push({ kind: 'unknown_source', severity: 'must_fix', message: `Cites ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the brief.`, ...at })
    }
    if (cited.length === 0) {
      flags.push({ kind: 'uncited', severity: 'must_fix', message: 'Cites nothing from the brief.', ...at })
    }
    const citedFigures = new Set<string>()
    for (const r of cited) for (const f of figuresIn(input.sources.get(r) ?? '')) citedFigures.add(f.norm)
    const notInSources: string[] = []
    const notCited: string[] = []
    for (const f of figuresIn(p.prose)) {
      if (citedFigures.has(f.norm)) continue
      if (allSourceFigures.has(f.norm)) notCited.push(f.raw)
      else notInSources.push(f.raw)
    }
    if (notInSources.length) {
      flags.push({ kind: 'number_not_in_sources', severity: 'must_fix', message: `${unique(notInSources).join(', ')} ${notInSources.length === 1 ? 'is' : 'are'} not in any source. Check the figure, or say how it was worked out.`, ...at })
    }
    if (notCited.length) {
      flags.push({ kind: 'number_not_cited', severity: 'check', message: `${unique(notCited).join(', ')} come${notCited.length === 1 ? 's' : ''} from a source this paragraph does not cite.`, ...at })
    }
    if (RECOMMENDS.test(p.prose)) {
      flags.push({ kind: 'recommendation_outside_section', severity: 'must_fix', message: 'Reads as a recommendation. The recommendation is the partners\' to write.', ...at })
    }
    if (JUDGES_TEAM.test(p.prose)) {
      flags.push({ kind: 'team_judgment', severity: 'must_fix', message: 'Scores the team or judges a founder\'s character, which is the partners\' call.', ...at })
    }
    const futureYear = (p.prose.match(/\b20\d\d\b/g) ?? []).some(y => Number(y) > year)
    if (futureYear && figuresIn(p.prose).length && !PROJECTION_WORDS.test(p.prose)) {
      flags.push({ kind: 'unlabeled_projection', severity: 'check', message: 'Gives figures for a future year without saying they are projections.', ...at })
    }
  }

  for (const s of input.sections ?? []) {
    if (partnerOnly.has(s.id)) continue
    if (!input.paragraphs.some(p => p.section_id === s.id && p.prose.trim())) {
      flags.push({ kind: 'empty_section', severity: 'check', message: `"${s.title}" has no paragraphs.`, section: s.id })
    }
  }
  return flags
}

function unique(xs: string[]): string[] {
  return Array.from(new Set(xs))
}

// ---------------------------------------------------------------------------
// Refs: the brief's citation keys, and the memo draft's { source_type, source_id } pairs.
// ---------------------------------------------------------------------------

const TYPE_OF_PREFIX: Record<string, string> = { claim: 'claim', finding: 'finding', qa: 'qa_answer', note: 'partner_note', fact: 'partner_fact' }
const PREFIX_OF_TYPE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_OF_PREFIX).map(([k, v]) => [v, k]))

export function refToSource(ref: string): { source_type: string; source_id: string } | null {
  const i = ref.indexOf(':')
  if (i <= 0) return null
  const type = TYPE_OF_PREFIX[ref.slice(0, i).trim().toLowerCase()]
  const id = ref.slice(i + 1).trim()
  return type && id ? { source_type: type, source_id: id } : null
}

export function sourceToRef(s: { source_type: string; source_id: string }): string {
  return `${PREFIX_OF_TYPE[s.source_type] ?? s.source_type}:${s.source_id}`
}
