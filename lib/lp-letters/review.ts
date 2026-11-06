// The review of a structured letter: each flag tied to the section it is about, so the letter page
// can show it where it sits. The same checks as checkLetterDraft (brief.ts), run per section.
//
// Pure: no server imports.

import { MISSING_HEADING, investorsNamed, unlabeledPerformance, unstatedEvents, unsupportedNumbers, type LetterBrief } from './brief'
import type { LetterContent } from './content'
import { formerNamesUsed, type LetterProfile } from './profile'

export interface LetterFlag {
  /** The section it is about; null for the letter as a whole. */
  section_id: string | null
  kind:
    | 'unsupported_number' | 'unlabeled_performance' | 'unstated_event' | 'investor_named' | 'missing_information'
    | 'invalid_date' | 'avoided_term' | 'stale_copy' | 'confidential_quoted'
    | 'former_name' | 'copied_from_last_letter' | 'other_entity_company'
  message: string
  /** The text it points at, to find it in the section. */
  quote?: string
}

export interface ReviewOptions {
  /** Words and phrases the fund's house rules say never to use (avoidTerms). */
  avoid?: string[]
  /** Today, for dates in the future; defaults to the real today. */
  today?: string
  /** The entity's letter profile: display names, signatories, fixed text. */
  profile?: LetterProfile | null
  /** Companies the fund holds through other entities only: a letter about this one shouldn't name them. */
  otherCompanies?: string[]
}

/** Sections where naming companies outside the entity is expected: the market and the outlook. */
const MARKET_HEADING = /\b(market|outlook|environment|landscape|macro|industry)\b/i
const LAST_LETTER_RUN = 25

/** The review's options from a loaded brief: the house rules' words to avoid, the profile, the other entities' companies. */
export function reviewOptions(loaded: { voice: { houseRules?: string | null }; profile?: LetterProfile | null; otherCompanies?: string[] }): ReviewOptions {
  return { avoid: avoidTerms(loaded.voice.houseRules), profile: loaded.profile ?? null, otherCompanies: loaded.otherCompanies ?? [] }
}

export function reviewLetter(
  content: LetterContent, brief: LetterBrief, investorNames: string[] = [], internalNotes?: string | null, opts: ReviewOptions = {},
): LetterFlag[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const flags: LetterFlag[] = []
  if (!internalNotes?.trim() && brief.missing_information.length) {
    flags.push({
      section_id: null, kind: 'missing_information',
      message: `The brief lists ${brief.missing_information.length} missing ${brief.missing_information.length === 1 ? 'item' : 'items'}, and the letter has no "${MISSING_HEADING}" notes.`,
    })
  }
  const byId = new Map(brief.companies.map(c => [c.company_id, c]))
  const signers = new Set((opts.profile?.signatories ?? []).map(sg => sg.name.trim().toLowerCase()))
  const fixedHeadings = new Set((opts.profile?.fixed_text ?? []).map(f => f.heading.trim().toLowerCase()))
  const lastSection = content.sections[content.sections.length - 1]?.id
  const others = (opts.otherCompanies ?? []).filter(n => !brief.companies.some(c => c.company.toLowerCase() === n.toLowerCase()))
  const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const s of content.sections) {
    const text = [s.heading, s.body].filter(Boolean).join('\n')
    for (const raw of unsupportedNumbers(text, brief).slice(0, 15)) {
      flags.push({ section_id: s.id, kind: 'unsupported_number', message: `"${raw}" does not appear in the sources.`, quote: raw })
    }
    for (const q of unlabeledPerformance(text).slice(0, 10)) {
      flags.push({ section_id: s.id, kind: 'unlabeled_performance', message: 'Performance figure without "gross" or "net".', quote: q })
    }
    for (const n of investorsNamed(text, brief, investorNames)) {
      // A partner who is also an investor signs the letter: their name belongs in its last section.
      if (s.id === lastSection && signers.has(n.trim().toLowerCase())) continue
      flags.push({ section_id: s.id, kind: 'investor_named', message: `Names an investor in the fund (${n}).`, quote: n })
    }
    const company = s.company_id ? byId.get(s.company_id) : undefined
    if (company) for (const m of unstatedEvents(text, company)) flags.push({ section_id: s.id, kind: 'unstated_event', message: m })
    for (const d of badDates(text, today)) flags.push({ section_id: s.id, kind: 'invalid_date', message: d.message, quote: d.raw })
    for (const t of termsUsed(text, opts.avoid ?? [])) {
      flags.push({ section_id: s.id, kind: 'avoided_term', message: `Uses "${t}", which the house rules say to avoid.`, quote: t })
    }
    // Text lifted from the company's stored update, when that update is older than the quarter.
    if (company?.stored_business_update && company.stored_business_update_stale) {
      const run = sharedRun(s.body, company.stored_business_update, 10)
      if (run) flags.push({
        section_id: s.id, kind: 'stale_copy', quote: run,
        message: `Repeats the stored business update from ${company.stored_business_update_at}, which is older than this quarter.`,
      })
    }
    if (opts.profile) {
      // The body, not the heading: a company section's heading is always its display name.
      for (const f of formerNamesUsed(s.body, opts.profile)) {
        flags.push({ section_id: s.id, kind: 'former_name', quote: f.former, message: `Calls the company "${f.former}"; the letter's name for it is "${f.display}".` })
      }
    }
    // Last quarter's words, outside the paragraphs the profile says repeat.
    if (brief.last_final_letter && !(s.heading && fixedHeadings.has(s.heading.trim().toLowerCase()))) {
      const run = sharedRun(s.body, brief.last_final_letter.text, LAST_LETTER_RUN)
      if (run) flags.push({
        section_id: s.id, kind: 'copied_from_last_letter', quote: run,
        message: `Repeats the ${brief.last_final_letter.period} letter word for word; check it is still true.`,
      })
    }
    if (!(s.heading && MARKET_HEADING.test(s.heading))) {
      for (const n of others) {
        if (new RegExp(`\\b${escRe(n)}\\b`, 'i').test(text)) {
          flags.push({ section_id: s.id, kind: 'other_entity_company', quote: n, message: `Names ${n}, which this entity does not hold.` })
        }
      }
    }
    // Wording from an update its sender marked confidential.
    for (const c of company ? [company] : brief.companies) {
      for (const u of c.updates_this_quarter.filter(u => u.confidential)) {
        const run = sharedRun(s.body, u.text, 8)
        if (run) flags.push({
          section_id: s.id, kind: 'confidential_quoted', quote: run,
          message: `Quotes ${c.company}'s update of ${u.received}, which is marked confidential.`,
        })
      }
    }
  }
  // A company with an event and no section of its own is a flag on the letter.
  const sectioned = new Set(content.sections.map(s => s.company_id).filter(Boolean))
  for (const c of brief.companies) {
    if (sectioned.has(c.company_id)) continue
    const whole = content.sections.map(s => s.body).join('\n')
    for (const m of unstatedEvents(whole, c)) flags.push({ section_id: null, kind: 'unstated_event', message: m })
  }
  return flags
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const monthOf = (m: string) => MONTHS.findIndex(x => x.startsWith(m.toLowerCase().replace('.', '').slice(0, 3))) + 1

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Dates in the text that cannot exist (February 30) or are in the future, and quarters that cannot exist. */
export function badDates(text: string, today: string): { raw: string; message: string }[] {
  const out: { raw: string; message: string }[] = []
  const seen = new Set<string>()
  const check = (raw: string, y: number, m: number, d: number) => {
    if (seen.has(raw)) return
    seen.add(raw)
    if (!validDate(y, m, d)) out.push({ raw, message: `"${raw}" is not a real date.` })
    else {
      const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      if (iso > today) out.push({ raw, message: `"${raw}" is in the future.` })
    }
  }
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) check(m[0], +m[3], monthOf(m[1]), +m[2])
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\s+(\\d{4})\\b`, 'gi'))) check(m[0], +m[3], monthOf(m[2]), +m[1])
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) check(m[0], +m[1], +m[2], +m[3])
  for (const m of text.matchAll(/\bQ([05-9])\s?(?:'|20)?\d{2}\b/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push({ raw: m[0], message: `"${m[0]}" is not a quarter.` }) }
  }
  return out
}

/**
 * The words and phrases a fund's house rules say never to use. The rules name them on a line of
 * their own: "Avoid: synergy, best-in-class" (also "Never use:", "Do not use:", "Don't use:").
 */
export function avoidTerms(houseRules: string | null | undefined): string[] {
  const out = new Set<string>()
  for (const line of (houseRules ?? '').split('\n')) {
    const m = line.match(/^\s*(?:[-*\u2022]\s*)?(?:avoid|never use|do not use|don't use)(?:\s+(?:the\s+)?(?:words?|terms?|phrases?))?\s*:\s*(.+)$/i)
    if (!m) continue
    for (const t of m[1].split(/[,;]/)) {
      const term = t.trim().replace(/^["\u201c\u2018']+|["\u201d\u2019'.]+$/g, '').trim()
      if (term.length >= 2 && term.length <= 60) out.add(term)
    }
  }
  return Array.from(out)
}

function termsUsed(text: string, terms: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return terms.filter(t => new RegExp(`(?<![\\w-])${esc(t)}(?![\\w-])`, 'i').test(text))
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean)

/** The first run of at least n words the text shares with the source, or null. */
export function sharedRun(text: string, source: string, n: number): string | null {
  const src = words(source)
  if (src.length < n) return null
  const grams = new Set<string>()
  for (let i = 0; i + n <= src.length; i++) grams.add(src.slice(i, i + n).join(' '))
  const w = words(text)
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n).join(' ')
    if (grams.has(g)) return g
  }
  return null
}
