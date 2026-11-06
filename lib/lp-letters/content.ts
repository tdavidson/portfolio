// The structured letter: one store for every writer and every view.
//
// A letter is a list of sections in the fund's order. Each has a heading, its text, and the sources
// it was written from (a company's figures, events, KPIs and updates, or the fund's figures), copied
// from the brief at the time, so the letter page shows what the text was based on rather than a
// fresh recalculation. lp_letters.content holds it; full_draft and company_narratives are copies
// made from it for the portal, the PDF, the exports and older tools. A letter saved before this
// existed has no content and is read from its full_draft (fromLetter).
//
// Writers mark each section with a "## Heading" line. Text without the marks (an assistant's draft,
// a pasted or pulled document) is split at lines that name a company of the letter, or a heading
// the letter already had.
//
// Pure: no server imports.

import type { BriefCompany, Figure, LetterBrief } from './brief'
import { splitInternal } from './internal'

export type SectionKind = 'text' | 'company' | 'fund'

export interface SectionSources {
  company?: BriefCompany
  fund?: { figures: Figure[]; basis_notes: string[] }
  /** When the sources were read (the brief's as_of). */
  as_of?: string
}

export interface LetterSection {
  /** Stable within a letter: "company:<id>" for a company, else from the heading. */
  id: string
  kind: SectionKind
  /** Null for the opening, which has none. */
  heading: string | null
  body: string
  company_id?: string
  sources?: SectionSources
}

export interface LetterContent {
  version: 1
  sections: LetterSection[]
}

/** The companies a letter can name, for splitting text into sections. */
export interface KnownCompany { id: string; name: string }

const HEADING_MARK = /^##\s+(.+?)\s*#*\s*$/
const FUND_HEADING = /\b(fund )?performance\b|\bmetrics\b/i

/** Section names letters commonly use: a line that is one of them starts a section in text without marks. */
export const COMMON_HEADINGS = [
  'Market commentary', 'Market update', 'Year in review', 'Fund performance', 'Fund performance metrics', 'Performance',
  'Valuation changes', 'Valuation updates', 'Portfolio summary', 'Portfolio overview', 'New investments',
  'Company updates', 'Portfolio updates', 'Portfolio company updates', 'After the quarter', 'Subsequent events',
  'Closing', 'Closing thoughts',
]

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'

/** A company named by a heading: exactly, or as its start ("Acme (formerly Apex)"). */
function companyOf(heading: string, companies: KnownCompany[]): KnownCompany | null {
  const h = norm(heading)
  let best: KnownCompany | null = null
  for (const c of companies) {
    const n = norm(c.name)
    if (!n) continue
    // The name alone, or the name and a tagline: "Acme (Series A)", "Acme – logistics", "Acme: logistics".
    if (h === n || [' (', ' –', ' —', ' -', ': ', ' |'].some(sep => h.startsWith(`${n}${sep}`))) {
      if (!best || n.length > norm(best.name).length) best = c
    }
  }
  return best
}

export interface ParseOptions {
  companies?: KnownCompany[]
  /** Headings the letter already had, so plain text keeps them as sections. */
  headings?: string[]
  /** Sources from before, kept by section id. */
  previous?: LetterContent | null
}

/**
 * Text into sections. The "Missing information" section is not part of the letter: take it off
 * first (splitInternal), as saveContent does.
 */
export function parseLetterText(text: string, opts: ParseOptions = {}): LetterContent {
  const companies = opts.companies ?? []
  const known = new Set((opts.headings ?? []).map(norm).filter(Boolean))
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const marked = lines.some(l => HEADING_MARK.test(l))

  const raw: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }]
  // In text without marks, a company's name opens its section once. When the name stands on a line
  // of its own more than once (in a valuation list before the company sections, say), the last one
  // opens the section and the earlier ones are part of the text around them.
  const companyLine = (plain: string): KnownCompany | null => {
    if (!plain || plain.length > 120) return null
    // A sentence ("Acme: raised its Series A.") is text; a heading doesn't end like one.
    if (/[.!?]$/.test(plain) && plain.split(/\s+/).length > 3) return null
    return companyOf(plain.replace(/[:.]$/, ''), companies)
  }
  const lastLine = new Map<string, number>()
  if (!marked) lines.forEach((l, i) => { const c = companyLine(l.trim()); if (c) lastLine.set(c.id, i) })
  for (const [i, line] of lines.entries()) {
    const m = line.match(HEADING_MARK)
    const plain = line.trim()
    let isHeading = !!m
    if (!m && !marked && plain.length > 0 && plain.length <= 120) {
      const company = companyLine(plain)
      if (company) isHeading = lastLine.get(company.id) === i
      else if (known.has(norm(plain.replace(/:$/, '')))) isHeading = true
    }
    if (isHeading) raw.push({ heading: (m ? m[1] : plain.replace(/:$/, '')).trim(), lines: [] })
    else raw[raw.length - 1].lines.push(line)
  }

  const used = new Set<string>()
  const prior = new Map((opts.previous?.sections ?? []).map(s => [s.id, s]))
  const sections: LetterSection[] = []
  for (const r of raw) {
    const body = r.lines.join('\n').replace(/^\n+|\s+$/g, '')
    if (r.heading === null && !body) continue
    const company = r.heading ? companyOf(r.heading, companies) : null
    const base = company ? `company:${company.id}` : r.heading ? slug(r.heading) : 'opening'
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    const kind: SectionKind = company ? 'company' : r.heading && FUND_HEADING.test(r.heading) ? 'fund' : 'text'
    const before = prior.get(id)
    sections.push({
      id, kind, heading: r.heading, body,
      ...(company ? { company_id: company.id } : {}),
      ...(before?.sources ? { sources: before.sources } : {}),
    })
  }
  return { version: 1, sections }
}

/** The sources each section was written from, from the brief. */
export function attachSources(content: LetterContent, brief: LetterBrief): LetterContent {
  const byId = new Map(brief.companies.map(c => [c.company_id, c]))
  return {
    ...content,
    sections: content.sections.map(s => {
      if (s.kind === 'company' && s.company_id && byId.has(s.company_id)) {
        return { ...s, sources: { company: byId.get(s.company_id)!, as_of: brief.as_of } }
      }
      if (s.kind === 'fund') {
        return { ...s, sources: { fund: { figures: brief.fund_figures, basis_notes: brief.basis_notes }, as_of: brief.as_of } }
      }
      return s
    }),
  }
}

/** The letter as plain text, the way full_draft has always held it: headings on their own lines. */
export function renderLetterText(content: LetterContent): string {
  return content.sections
    .map(s => [s.heading, s.body].filter(x => x && x.trim()).join('\n\n'))
    .filter(Boolean)
    .join('\n\n')
}

/** The company sections in the shape company_narratives has always had. */
export function narrativesOf(content: LetterContent, updatedBy: string | null, at: string) {
  return content.sections
    .filter(s => s.kind === 'company' && s.company_id)
    .map(s => ({ company_id: s.company_id!, company_name: s.heading ?? '', narrative: s.body, updated_by: updatedBy, updated_at: at }))
}

/** Replace one section's text (and heading, if given). Unknown ids are an error. */
export function replaceSection(content: LetterContent, id: string, change: { body?: string; heading?: string | null }): LetterContent {
  if (!content.sections.some(s => s.id === id)) throw new Error(`No section "${id}" in this letter.`)
  return {
    ...content,
    sections: content.sections.map(s => s.id === id
      ? { ...s, ...(change.body !== undefined ? { body: change.body.replace(/\s+$/, '') } : {}), ...(change.heading !== undefined ? { heading: change.heading } : {}) }
      : s),
  }
}

/** Is this stored JSON a letter's content? */
export function isContent(x: unknown): x is LetterContent {
  return !!x && typeof x === 'object' && (x as any).version === 1 && Array.isArray((x as any).sections)
}

/** The companies a stored letter knows: from its content, else its portfolio summary. */
export function knownCompanies(letter: { content?: unknown; portfolio_summary?: unknown; company_narratives?: unknown }): KnownCompany[] {
  const out = new Map<string, string>()
  for (const n of (Array.isArray(letter.company_narratives) ? letter.company_narratives : []) as any[]) {
    if (n?.company_id && n?.company_name) out.set(String(n.company_id), String(n.company_name))
  }
  for (const r of (Array.isArray(letter.portfolio_summary) ? letter.portfolio_summary : []) as any[]) {
    if (r?.company_id && r?.company_name) out.set(String(r.company_id), String(r.company_name))
  }
  if (isContent(letter.content)) {
    for (const s of letter.content.sections) {
      if (s.company_id && s.sources?.company?.company) out.set(s.company_id, s.sources.company.company)
      else if (s.company_id && s.heading && !out.has(s.company_id)) out.set(s.company_id, s.heading)
    }
  }
  return Array.from(out, ([id, name]) => ({ id, name }))
}

/** A stored letter's content: as saved, or read from its full_draft for a letter saved before content existed. */
export function fromLetter(letter: { content?: unknown; full_draft?: string | null; portfolio_summary?: unknown; company_narratives?: unknown }): LetterContent {
  if (isContent(letter.content)) return letter.content
  const parsed = parseLetterText(splitInternal(letter.full_draft ?? '').body ?? '', { companies: knownCompanies(letter) })
  // An older letter's company sections may be stored only as narratives, never assembled into its text.
  const have = new Set(parsed.sections.map(s => s.id))
  const extra: LetterSection[] = ((Array.isArray(letter.company_narratives) ? letter.company_narratives : []) as any[])
    .filter(n => n?.company_id && typeof n.narrative === 'string' && !have.has(`company:${n.company_id}`))
    .map(n => ({ id: `company:${n.company_id}`, kind: 'company' as const, heading: String(n.company_name ?? ''), body: n.narrative.trim(), company_id: String(n.company_id) }))
  return extra.length ? { ...parsed, sections: [...parsed.sections, ...extra] } : parsed
}

/** Company sections put in the given order, in the places company sections already hold. */
export function orderCompanies(content: LetterContent, companyIds: string[]): LetterContent {
  const rank = (s: LetterSection) => { const i = companyIds.indexOf(s.company_id ?? ''); return i === -1 ? companyIds.length : i }
  const companies = content.sections.filter(s => s.kind === 'company').sort((a, b) => rank(a) - rank(b))
  let k = 0
  return { ...content, sections: content.sections.map(s => (s.kind === 'company' ? companies[k++] : s)) }
}

/**
 * New text for a letter that already has content (an edit of the whole letter, a pulled Google Doc,
 * text from an assistant): split it the same way, keeping each section's sources.
 */
export function reparse(letter: { content?: unknown; full_draft?: string | null; portfolio_summary?: unknown; company_narratives?: unknown }, text: string): LetterContent {
  const previous = fromLetter(letter)
  return parseLetterText(text, {
    companies: knownCompanies(letter),
    headings: previous.sections.map(s => s.heading).filter((h): h is string => !!h),
    previous,
  })
}
