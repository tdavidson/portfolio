// The letter as a document: what every export lays out (Word, PDF, Markdown, JSON).
//
// A letter's sections (content.ts) hold plain text with a few marks: "- " bullets and tables as
// "Column | Column" rows. Here each section becomes blocks a renderer can style: paragraphs,
// bullet lists, tables, and the charts the partners placed after it. The "Missing information"
// section is never part of it: every export is what investors may read.
//
// Pure: no server imports. The Word file is docx-letter.ts; the PDF is lp-report-pdf.ts.

import { fromLetter, type SectionKind } from './content'
import { MISSING_HEADING } from './internal'

/** A chart the partners uploaded, placed after a section (or at the end, when its section is gone). */
export interface LetterChart {
  id: string
  /** The section it follows; null puts it at the end of the letter. */
  section_id: string | null
  caption: string | null
  /** Storage path in lp-letter-charts. Named by the image's hash: an upload never replaces another. */
  path: string
  /** SVG only for charts drawn from the letter's figures (fund-charts.ts), never an upload. */
  content_type: 'image/png' | 'image/jpeg' | 'image/svg+xml'
  sha256: string
  width: number | null
  height: number | null
  uploaded_at: string
  uploaded_by: string | null
  /** A chart drawn from the letter's figures (fund-charts.ts), not uploaded: which, and as of when. */
  generated?: { kind: string; as_of: string | null; options: Record<string, unknown> } | null
}

export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'chart'; chart: LetterChart }

export interface DocumentSection {
  id: string
  kind: SectionKind
  heading: string | null
  company_id?: string
  blocks: Block[]
}

export interface LetterDocument {
  version: 1
  title: string
  period: string
  /** The vehicle the letter is for. */
  entity: string | null
  status: string | null
  sections: DocumentSection[]
}

const BULLET = /^\s*[-•*]\s+(.*)$/
const isTableRow = (l: string) => l.includes(' | ') || /^\s*\|.*\|\s*$/.test(l)
const isRule = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())

/** One section's text as blocks: blank lines end paragraphs; runs of bullets or table rows group. */
export function blocksOf(body: string): Block[] {
  const out: Block[] = []
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  const flush = () => {
    const t = para.join('\n').trim()
    if (t) out.push({ type: 'paragraph', text: t })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { flush(); continue }
    if (BULLET.test(line)) {
      flush()
      const items: string[] = []
      while (i < lines.length && BULLET.test(lines[i])) items.push(lines[i++].match(BULLET)![1].trim())
      i--
      out.push({ type: 'bullets', items })
      continue
    }
    // A table needs two rows at least, so a sentence with a stray " | " stays a sentence.
    if (isTableRow(line) && i + 1 < lines.length && isTableRow(lines[i + 1])) {
      flush()
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isRule(lines[i])) rows.push(cells(lines[i]))
        i++
      }
      i--
      const width = Math.max(...rows.map(r => r.length))
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
      out.push({ type: 'table', header: pad(rows[0]), rows: rows.slice(1).map(pad) })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

export interface DocumentLetter {
  content?: unknown
  full_draft?: string | null
  portfolio_summary?: unknown
  company_narratives?: unknown
  charts?: unknown
  period_label?: string | null
  portfolio_group?: string | null
  status?: string | null
}

/** The letter's charts as stored, the ones that look right only. */
export function chartsOf(letter: { charts?: unknown }): LetterChart[] {
  return ((Array.isArray(letter.charts) ? letter.charts : []) as any[])
    .filter(c => c && typeof c.id === 'string' && typeof c.path === 'string' && (c.content_type === 'image/png' || c.content_type === 'image/jpeg' || (c.content_type === 'image/svg+xml' && !!c.generated)))
}

export function letterDocument(letter: DocumentLetter, opts: { title?: string } = {}): LetterDocument {
  const content = fromLetter(letter)
  const charts = chartsOf(letter)
  const ids = new Set(content.sections.map(s => s.id))
  const sections: DocumentSection[] = content.sections
    .filter(s => (s.heading ?? '').trim().toLowerCase() !== MISSING_HEADING.toLowerCase())
    .map(s => ({
      id: s.id, kind: s.kind, heading: s.heading,
      ...(s.company_id ? { company_id: s.company_id } : {}),
      blocks: [...blocksOf(s.body), ...charts.filter(c => c.section_id === s.id).map(c => ({ type: 'chart' as const, chart: c }))],
    }))
  const loose = charts.filter(c => !c.section_id || !ids.has(c.section_id))
  if (loose.length) {
    const last = sections[sections.length - 1]
    if (last) last.blocks.push(...loose.map(c => ({ type: 'chart' as const, chart: c })))
    else sections.push({ id: 'charts', kind: 'text', heading: null, blocks: loose.map(c => ({ type: 'chart' as const, chart: c })) })
  }
  const period = letter.period_label ?? ''
  return {
    version: 1,
    title: opts.title ?? period,
    period,
    entity: letter.portfolio_group ?? null,
    status: letter.status ?? null,
    sections,
  }
}

/** Markdown with "## " headings, bullets and pipe tables. A chart is its caption and file name. */
export function documentMarkdown(doc: LetterDocument): string {
  const out: string[] = []
  if (doc.title) out.push(`# ${doc.title}`)
  for (const s of doc.sections) {
    if (s.heading) out.push(`## ${s.heading}`)
    for (const b of s.blocks) {
      if (b.type === 'paragraph') out.push(b.text)
      else if (b.type === 'bullets') out.push(b.items.map(i => `- ${i}`).join('\n'))
      else if (b.type === 'table') {
        const row = (r: string[]) => `| ${r.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`
        out.push([row(b.header), `| ${b.header.map(() => '---').join(' | ')} |`, ...b.rows.map(row)].join('\n'))
      } else out.push(`![${b.chart.caption ?? 'Chart'}](${chartFileName(b.chart)})`)
    }
  }
  return out.join('\n\n') + '\n'
}

export function chartFileName(c: LetterChart): string {
  return `chart-${c.sha256.slice(0, 12)}.${c.content_type === 'image/png' ? 'png' : c.content_type === 'image/svg+xml' ? 'svg' : 'jpg'}`
}

/** The JSON export: the document, without storage paths. */
export function documentJson(doc: LetterDocument): unknown {
  return {
    ...doc,
    sections: doc.sections.map(s => ({
      ...s,
      blocks: s.blocks.map(b => (b.type === 'chart'
        ? { type: 'chart', id: b.chart.id, caption: b.chart.caption, file: chartFileName(b.chart), sha256: b.chart.sha256, width: b.chart.width, height: b.chart.height }
        : b)),
    })),
  }
}

/** Does this letter have structured content, so the document layout applies? */
export function hasStructuredContent(letter: { content?: unknown }): boolean {
  const c = letter.content as any
  return !!c && c.version === 1 && Array.isArray(c.sections) && c.sections.length > 0
}

/** Width and height of a PNG or JPEG, from its bytes; null when they can't be read. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]
      const len = (bytes[i + 2] << 8) | bytes[i + 3]
      // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
      }
      i += 2 + len
    }
  }
  return null
}

/** The image's type from its bytes, never from the name or the browser's word for it. */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}
