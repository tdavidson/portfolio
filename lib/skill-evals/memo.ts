// Grading an investment memo written by the investment-memo skill: the paragraphs it would pass to
// diligence_draft_memo, run through the same section resolution and review a saved draft gets
// (buildParagraphs, reviewParagraphs), plus the case's expectations.

import { buildParagraphs, reviewParagraphs, type SaveMemoInput } from '@/lib/memo-agent/assistant-memo'
import type { MemoBrief } from '@/lib/memo-agent/brief'
import { figuresIn, type ReviewFlag } from '@/lib/memo-agent/review'
import { caseRegex, type EvalFailure, type EvalResult, type TextExpectation } from './types'

export interface MemoCase {
  id: string
  description: string
  /** What diligence_memo_brief returns for the deal, all invented. */
  brief: MemoBrief
  expect: {
    /** The year the memo is written in, for spotting unlabeled projections. */
    year: number
    /** Review flag kinds this case tolerates. */
    allowed_flags?: ReviewFlag['kind'][]
    /** In the memo's paragraphs; `section` is a section id or title. */
    must_contain?: TextExpectation[]
    must_not_contain?: string[]
    /** In the attention list for the partners. */
    attention_must_contain?: string[]
    /**
     * A paragraph that rests only on data-room claims and gives a figure must attribute it ("the
     * company states", "management reports"): company statements are claims until confirmed.
     */
    attribute_claims?: boolean
  }
}

const ATTRIBUTION = /\b(?:the company|management|the founders?|the ceo|the deck|the data room|the (?:financial )?model|the term sheet|its (?:deck|model|data room))\b[^.]{0,40}\b(?:states?|reports?|says|claims?|shows?|projects?|estimates?|expects?|sets?)\b|\baccording to (?:the|its|management)\b|\b(?:company|management)[- ]reported\b|\bunverified\b/i

/** The memo's JSON from a model's reply: the first {...} object, with or without a code fence. */
export function parseMemoOutput(text: string): SaveMemoInput | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed?.paragraphs) ? parsed : null
  } catch {
    return null
  }
}

export function gradeMemo(text: string, c: MemoCase): EvalResult {
  const failures: EvalFailure[] = []
  const tolerated: EvalFailure[] = []
  const result = (): EvalResult => ({ case: c.id, skill: 'investment-memo', pass: failures.length === 0, failures, tolerated })

  const output = parseMemoOutput(text)
  if (!output) {
    failures.push({ check: 'parse', message: 'The reply has no JSON object with a "paragraphs" list.' })
    return result()
  }
  const { paragraphs, problems } = buildParagraphs(c.brief.sections, output.paragraphs, 'agent_drafted')
  const allowed = new Set(c.expect.allowed_flags ?? [])
  for (const f of [...problems, ...reviewParagraphs(c.brief, paragraphs, c.expect.year)]) {
    const where = f.section ? ` (${f.section})` : ''
    ;(allowed.has(f.kind) ? tolerated : failures).push({ check: f.kind, message: `${f.message}${where}` })
  }

  const written = paragraphs.filter(p => p.origin !== 'partner_only_placeholder')
  const all = written.map(p => p.prose).join('\n\n')
  const sectionIds = (name: string) => {
    const n = name.toLowerCase()
    return new Set(c.brief.sections.filter(s => s.id.toLowerCase() === n || s.title.toLowerCase() === n).map(s => s.id))
  }
  for (const e of c.expect.must_contain ?? []) {
    const ids = e.section ? sectionIds(e.section) : null
    const where = ids ? written.filter(p => ids.has(p.section_id)).map(p => p.prose).join('\n\n') : all
    if (!caseRegex(e.text, c.id).test(where)) {
      failures.push({ check: 'must_contain', message: `${e.section ? `The "${e.section}" section` : 'The memo'} does not say /${e.text}/.` })
    }
  }
  for (const t of c.expect.must_not_contain ?? []) {
    const m = caseRegex(t, c.id).exec(all)
    if (m) failures.push({ check: 'must_not_contain', message: `The memo says "${m[0]}" (/${t}/).` })
  }
  const attention = (output.attention ?? []).map(a => a.body).join('\n')
  for (const t of c.expect.attention_must_contain ?? []) {
    if (!caseRegex(t, c.id).test(attention)) failures.push({ check: 'attention_must_contain', message: `The attention list does not mention /${t}/.` })
  }
  if (c.expect.attribute_claims) {
    for (const p of written) {
      const refs = p.sources.map(s => s.source_type)
      if (refs.length && refs.every(t => t === 'claim') && figuresIn(p.prose).length && !ATTRIBUTION.test(p.prose)) {
        failures.push({ check: 'attribute_claims', message: `A paragraph in "${p.section_id}" gives the company's figures as fact: "${p.prose.slice(0, 100)}…"` })
      }
    }
  }
  return result()
}
