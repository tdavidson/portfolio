// A partner's edited Word memo, back into the app: matched to the draft it came from, section by
// section and paragraph by paragraph, so unchanged paragraphs keep their citations and the changes
// can be listed. Pure: no server imports.

import type { MemoParagraph } from './stages/draft'
import { sourceToRef } from './review'
import type { BriefSection } from './brief'
import type { ParagraphInput } from './assistant-memo'

export interface ImportChange {
  section: string
  kind: 'added' | 'removed' | 'edited'
  before?: string
  after?: string
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9%.]+/g, ' ').split(' ').filter(w => w.length > 2))

export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return a.trim() === b.trim() ? 1 : 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/^\s*(?:\d+|[ivx]+)[.)]\s+/i, '').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The imported memo as paragraphs to save, each section matched to the memo's sections by title (the
 * export writes the section titles as headings), each paragraph to the most similar one the draft had
 * in that section, whose citations it keeps.
 */
export function matchImported(
  imported: Array<{ title: string; paragraphs: string[] }>,
  sections: BriefSection[],
  prior: MemoParagraph[],
): { paragraphs: ParagraphInput[]; changes: ImportChange[]; unmatched: string[] } {
  const out: ParagraphInput[] = []
  const changes: ImportChange[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()
  for (const sec of imported) {
    const s = sections.find(x => norm(x.title) === norm(sec.title) || norm(x.id) === norm(sec.title))
    if (!s) unmatched.push(sec.title)
    const sectionKey = s?.id ?? sec.title
    seen.add(sectionKey)
    const old = prior.filter(p => p.section_id === s?.id && !p.hidden && p.origin !== 'partner_only_placeholder')
    const used = new Set<string>()
    for (const text of sec.paragraphs) {
      let best: MemoParagraph | null = null
      let score = 0
      for (const p of old) {
        if (used.has(p.id)) continue
        const sc = similarity(p.prose, text)
        if (sc > score) { score = sc; best = p }
      }
      if (best && score >= 0.4) {
        used.add(best.id)
        if (best.prose.trim() !== text.trim()) changes.push({ section: s?.title ?? sec.title, kind: 'edited', before: best.prose, after: text })
        out.push({ section: sectionKey, text, sources: best.sources.map(sourceToRef) })
      } else {
        if (!(s?.partner_only && /^\[partner to complete\]$/i.test(text.trim()))) changes.push({ section: s?.title ?? sec.title, kind: 'added', after: text })
        out.push({ section: sectionKey, text, sources: [] })
      }
    }
    for (const p of old) if (!used.has(p.id)) changes.push({ section: s?.title ?? sec.title, kind: 'removed', before: p.prose })
  }
  for (const p of prior) {
    if (p.hidden || p.origin === 'partner_only_placeholder' || seen.has(p.section_id)) continue
    changes.push({ section: sections.find(s => s.id === p.section_id)?.title ?? p.section_id, kind: 'removed', before: p.prose })
  }
  return { paragraphs: out.filter(p => !/^\[partner to complete\]$/i.test(p.text.trim())), changes, unmatched }
}
