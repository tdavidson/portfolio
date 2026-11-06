// The review of a structured letter: each flag tied to the section it is about, so the letter page
// can show it where it sits. The same checks as checkLetterDraft (brief.ts), run per section.
//
// Pure: no server imports.

import { MISSING_HEADING, investorsNamed, unlabeledPerformance, unstatedEvents, unsupportedNumbers, type LetterBrief } from './brief'
import type { LetterContent } from './content'

export interface LetterFlag {
  /** The section it is about; null for the letter as a whole. */
  section_id: string | null
  kind: 'unsupported_number' | 'unlabeled_performance' | 'unstated_event' | 'investor_named' | 'missing_information'
  message: string
  /** The text it points at, to find it in the section. */
  quote?: string
}

export function reviewLetter(content: LetterContent, brief: LetterBrief, investorNames: string[] = [], internalNotes?: string | null): LetterFlag[] {
  const flags: LetterFlag[] = []
  if (!internalNotes?.trim() && brief.missing_information.length) {
    flags.push({
      section_id: null, kind: 'missing_information',
      message: `The brief lists ${brief.missing_information.length} missing ${brief.missing_information.length === 1 ? 'item' : 'items'}, and the letter has no "${MISSING_HEADING}" notes.`,
    })
  }
  const byId = new Map(brief.companies.map(c => [c.company_id, c]))
  for (const s of content.sections) {
    const text = [s.heading, s.body].filter(Boolean).join('\n')
    for (const raw of unsupportedNumbers(text, brief).slice(0, 15)) {
      flags.push({ section_id: s.id, kind: 'unsupported_number', message: `"${raw}" does not appear in the sources.`, quote: raw })
    }
    for (const q of unlabeledPerformance(text).slice(0, 10)) {
      flags.push({ section_id: s.id, kind: 'unlabeled_performance', message: 'Performance figure without "gross" or "net".', quote: q })
    }
    for (const n of investorsNamed(text, brief, investorNames)) {
      flags.push({ section_id: s.id, kind: 'investor_named', message: `Names an investor in the fund (${n}).`, quote: n })
    }
    const company = s.company_id ? byId.get(s.company_id) : undefined
    if (company) for (const m of unstatedEvents(text, company)) flags.push({ section_id: s.id, kind: 'unstated_event', message: m })
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
