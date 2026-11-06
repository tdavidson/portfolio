// A letter's Word file, edited by the partners, read back against the letter it came from.
//
// The Word file the export gives (docx-letter.ts) marks its structure with styles: the title, a
// heading per section, list bullets, tables and chart captions. Read back, each heading becomes a
// "## " line so the text splits into the same sections, lists become "- " lines and tables
// "Column | Column" rows; the letterhead, the title, the images and their captions are the export's
// own and are left out. A Word file from elsewhere reads the same way, its headings by their styles.
//
// The comparison is by section (which changed, which are new, which are gone) and by line, so the
// partners see what replacing the draft would do before it does it.

import mammoth from 'mammoth'
import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element } from 'domhandler'
import { fromLetter, reparse, type LetterContent } from './content'
import { splitInternal } from './internal'
import { diffDraft, type DraftDiff } from './pull'

const STYLE_MAP = [
  "p[style-name='Title'] => h1.skip:fresh",
  "p[style-name='Subtitle'] => p.skip:fresh",
  "p[style-name='caption'] => p.skip:fresh",
  "p[style-name='Caption'] => p.skip:fresh",
  "p[style-name='Letterhead'] => p.skip:fresh",
  "p[style-name='Letterhead Detail'] => p.skip:fresh",
  "p[style-name='List Bullet'] => ul > li:fresh",
  "p[style-name='Table Text'] => p:fresh",
]

const isEl = (n: ChildNode): n is Element => (n as Element).type === 'tag'

function textOf(n: ChildNode): string {
  if (n.type === 'text') return (n as any).data as string
  if (!isEl(n)) return ''
  if (n.name === 'br') return '\n'
  if (n.name === 'img') return ''
  return n.children.map(textOf).join('')
}

// htmlparser2 has already decoded the entities.
const clean = (s: string) => s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim()

/** Mammoth's HTML as the letter's plain text with "## " headings, "- " bullets and "A | B" rows. */
export function htmlToLetterText(html: string): string {
  const blocks: string[] = []
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isEl(n)) {
        const t = clean(textOf(n))
        if (t) blocks.push(t)
        continue
      }
      if ((n.attribs.class ?? '').split(/\s+/).includes('skip')) continue
      if (/^h[1-6]$/.test(n.name)) {
        const t = clean(textOf(n)).replace(/\n+/g, ' ')
        if (t) blocks.push(`## ${t}`)
      } else if (n.name === 'p') {
        const t = clean(textOf(n))
        if (t) blocks.push(t)
      } else if (n.name === 'ul' || n.name === 'ol') {
        const items = n.children.filter(isEl).filter(c => c.name === 'li').map(li => clean(textOf(li)).replace(/\n+/g, ' ')).filter(Boolean)
        if (items.length) blocks.push(items.map(i => `- ${i}`).join('\n'))
      } else if (n.name === 'table') {
        const rows: string[] = []
        const collect = (el: Element) => {
          for (const c of el.children.filter(isEl)) {
            if (c.name === 'tr') rows.push(c.children.filter(isEl).filter(x => x.name === 'td' || x.name === 'th').map(td => clean(textOf(td)).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/')).join(' | '))
            else collect(c)
          }
        }
        collect(n)
        if (rows.length) blocks.push(rows.join('\n'))
      } else walk(n.children)
    }
  }
  walk(parseDocument(html).children)
  return blocks.join('\n\n')
}

/** A Word file's text, marked as a letter is. */
export async function docxToLetterText(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml(
    { buffer },
    { styleMap: STYLE_MAP, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  )
  return htmlToLetterText(value)
}

/** A letter as marked text: what a Word file of it reads back as. */
export function markedText(content: LetterContent): string {
  return content.sections
    .map(s => [s.heading ? `## ${s.heading}` : null, s.body].filter(x => x && x.trim()).join('\n\n'))
    .filter(Boolean)
    .join('\n\n')
}

export interface SectionChange {
  section_id: string
  heading: string | null
  change: 'changed' | 'added' | 'removed'
}

export interface WordComparison {
  /** The investor text the file would put in the letter ("Missing information" taken off). */
  text: string
  /** A "Missing information" section in the file, which would go to the internal notes. */
  internal: string | null
  sections: SectionChange[]
  unchanged_sections: number
  diff: DraftDiff
}

const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/** What replacing the letter's text with a Word file's would change. */
export function compareWithLetter(letter: Parameters<typeof fromLetter>[0], fileText: string): WordComparison {
  const { body, internal } = splitInternal(fileText)
  const text = (body ?? '').trim()
  const before = fromLetter(letter)
  const after = reparse(letter, text)
  const was = new Map(before.sections.map(s => [s.id, s]))
  const now = new Map(after.sections.map(s => [s.id, s]))
  const sections: SectionChange[] = []
  let unchanged = 0
  for (const s of after.sections) {
    const old = was.get(s.id)
    if (!old) sections.push({ section_id: s.id, heading: s.heading, change: 'added' })
    else if (!same(old.body, s.body) || (old.heading ?? '') !== (s.heading ?? '')) sections.push({ section_id: s.id, heading: s.heading, change: 'changed' })
    else unchanged++
  }
  for (const s of before.sections) if (!now.has(s.id)) sections.push({ section_id: s.id, heading: s.heading, change: 'removed' })
  return { text, internal, sections, unchanged_sections: unchanged, diff: diffDraft(markedText(before), markedText(after)) }
}
