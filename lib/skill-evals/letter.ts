// Grading an investor letter written by the lp-quarterly-letter skill: Hemrock's own review
// (reviewLetter, the flags a saved draft gets) plus the case's expectations.

import type { LetterBrief } from '@/lib/lp-letters/brief'
import { contentFromText } from '@/lib/lp-letters/draft-from-brief'
import { splitInternal } from '@/lib/lp-letters/internal'
import { reviewLetter, type LetterFlag } from '@/lib/lp-letters/review'
import { caseRegex, words, type EvalFailure, type EvalResult, type TextExpectation } from './types'

export interface LetterCase {
  id: string
  description: string
  /** What lp_letter_brief returns for the letter, all invented. */
  brief: LetterBrief
  expect: {
    /** "Today" for the date checks, so a case doesn't start failing as the calendar moves. */
    today: string
    /** Investors in the fund: none may be named. */
    investor_names?: string[]
    /** Companies the firm holds through other entities only: none may be named. */
    other_companies?: string[]
    /** Words the fund's house rules say to avoid. */
    avoid?: string[]
    /** Review flag kinds this case tolerates. */
    allowed_flags?: LetterFlag['kind'][]
    must_contain?: TextExpectation[]
    /** Never in the investor-facing text. */
    must_not_contain?: string[]
    /** In the "Missing information" notes. */
    internal_must_contain?: string[]
    /** Most words a section's body may have, by its heading or company name. */
    max_words?: Record<string, number>
  }
}

export function gradeLetter(text: string, c: LetterCase): EvalResult {
  const failures: EvalFailure[] = []
  const tolerated: EvalFailure[] = []
  const { body, internal } = splitInternal(text)
  const content = contentFromText(body, c.brief)
  const allowed = new Set(c.expect.allowed_flags ?? [])

  const flags = reviewLetter(content, c.brief, c.expect.investor_names ?? [], internal, {
    today: c.expect.today,
    avoid: c.expect.avoid ?? [],
    otherCompanies: c.expect.other_companies ?? [],
  })
  for (const f of flags) {
    const where = f.section_id ? ` (${headingOf(content.sections, f.section_id)})` : ''
    ;(allowed.has(f.kind) ? tolerated : failures).push({ check: f.kind, message: `${f.message}${where}` })
  }

  const sectionText = (name: string) => {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    const s = content.sections.find(x => x.heading && re.test(x.heading.trim()))
    return s ? s.body : null
  }
  for (const e of c.expect.must_contain ?? []) {
    const where = e.section ? sectionText(e.section) : body
    if (where === null) {
      failures.push({ check: 'must_contain', message: `No "${e.section}" section, which should say /${e.text}/.` })
    } else if (!caseRegex(e.text, c.id).test(where)) {
      failures.push({ check: 'must_contain', message: `${e.section ? `The "${e.section}" section` : 'The letter'} does not say /${e.text}/.` })
    }
  }
  for (const t of c.expect.must_not_contain ?? []) {
    const m = caseRegex(t, c.id).exec(body)
    if (m) failures.push({ check: 'must_not_contain', message: `The letter says "${m[0]}" (/${t}/).` })
  }
  for (const t of c.expect.internal_must_contain ?? []) {
    if (!internal || !caseRegex(t, c.id).test(internal)) {
      failures.push({ check: 'internal_must_contain', message: `The "Missing information" notes do not mention /${t}/.` })
    }
  }
  for (const [name, max] of Object.entries(c.expect.max_words ?? {})) {
    const s = sectionText(name)
    if (s !== null && words(s) > max) failures.push({ check: 'max_words', message: `"${name}" has ${words(s)} words; at most ${max}.` })
  }
  return { case: c.id, skill: 'lp-quarterly-letter', pass: failures.length === 0, failures, tolerated }
}

function headingOf(sections: { id: string; heading: string | null }[], id: string): string {
  return sections.find(s => s.id === id)?.heading ?? id
}
