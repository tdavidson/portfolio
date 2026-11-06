// A fund's memo design, read from one of its own sample memos (a .docx), and a memo written into it.
//
// Partners want an exported memo to look exactly like the memos they already write: the same fonts,
// heading and body styles, margins, header, footer and logo, and the same first page. The generic
// renderer (docx.ts) can't do that, so when a fund picks a sample memo as its design template the
// export starts from that file instead: its styles, theme, numbering, headers, footers, media and page
// setup are kept as they are, and only the body is replaced.
//
// The body is rebuilt from the sample's own paragraphs used as prototypes:
//   - the section heading paragraph (its paragraph and run formatting) for each section title,
//   - the body paragraph for prose, and its bulleted paragraph for list lines,
//   - the first page (everything before the first section heading) is kept, with the sample's own
//     facts swapped for this memo's: the title, labelled fields ("Company:", "Round size" cells in a
//     table), and dates. Fixed text such as "Investment Memorandum" or "Confidential" stays.
//
// Nothing here names or stores a fund's memo: the sample is the fund's own file, read from storage
// at export time. Pure: no server imports, so it is testable with invented files.

import JSZip from 'jszip'

export interface MemoDesignField {
  /** The memo header field it fills. */
  field: DesignFieldName
  label: string
}

export type DesignFieldName =
  | 'company_name' | 'sector' | 'stage' | 'round_size' | 'valuation' | 'deal_lead' | 'memo_date' | 'location' | 'website'

export interface MemoDesign {
  /** Section headings in the sample, in order (the memo's structure). */
  headings: string[]
  /** The labelled fields on the sample's first page that this memo fills. */
  fields: MemoDesignField[]
  /** The sample's title on its first page (usually its company's name), or null. */
  title: string | null
  /** What could not be found, for the settings page to show. */
  warnings: string[]
}

export interface DesignMemoInput {
  header: Partial<Record<DesignFieldName, string | null>>
  sections: Array<{ title: string; paragraphs: string[] }>
}

/** A field's label as memos write it, by field. Matched case-insensitively against the start of a label. */
const LABELS: Array<[DesignFieldName, RegExp]> = [
  ['company_name', /^(company|company name|name of company|target|issuer)$/],
  ['sector', /^(sector|industry|vertical|category|market)$/],
  ['round_size', /^(round size|round|raise|raising|amount raised|amount|total raise|financing|investment size|check size|our investment|proposed investment|allocation)$/],
  ['stage', /^(stage|series|round type|financing stage)$/],
  ['valuation', /^(valuation|pre-money|pre money|post-money|post money|pre-money valuation|post-money valuation|cap|valuation cap)$/],
  ['deal_lead', /^(deal lead|lead|lead partner|partner|sponsor|deal team|prepared by|author|from)$/],
  ['memo_date', /^(date|memo date|ic date|meeting date|as of)$/],
  ['location', /^(location|hq|headquarters|based in|geography)$/],
  ['website', /^(website|url|web)$/],
]

export function fieldForLabel(label: string): DesignFieldName | null {
  const l = label.replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!l || l.length > 40) return null
  // "Round" alone is a size more often than a stage, except "Round type"; the order of LABELS settles it.
  for (const [field, re] of LABELS) if (re.test(l)) return field
  return null
}

// ---------------------------------------------------------------------------
// XML helpers. WordprocessingML is regular enough to walk with a tag scanner: we only ever cut the
// body into its top-level elements and read or rebuild single paragraphs.
// ---------------------------------------------------------------------------

const TAG = /<(\/?)([A-Za-z][\w.-]*:[\w.-]+|[A-Za-z][\w.-]*)((?:\s[^>]*?)?)(\/?)>/g

/** The top-level children of an element's inner XML, as raw strings, in order. */
export function topLevelElements(inner: string): Array<{ name: string; xml: string }> {
  const out: Array<{ name: string; xml: string }> = []
  let depth = 0
  let start = -1
  let name = ''
  TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(inner))) {
    const closing = m[1] === '/'
    const selfClosing = m[4] === '/'
    if (!closing && depth === 0) { start = m.index; name = m[2] }
    if (selfClosing) {
      if (depth === 0) { out.push({ name, xml: inner.slice(start, TAG.lastIndex) }); start = -1 }
      continue
    }
    if (closing) {
      depth--
      if (depth === 0 && start >= 0) { out.push({ name, xml: inner.slice(start, TAG.lastIndex) }); start = -1 }
    } else {
      depth++
    }
  }
  return out
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The visible text of a paragraph (or any fragment). */
export function textOf(xml: string): string {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[0] === '<w:tab/>') out += '\t'
    else if (m[0] === '<w:br/>') out += '\n'
    else out += decode(m[1])
  }
  return out
}

function pPrOf(p: string): string {
  return /<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/.exec(p)?.[0] ?? ''
}

/** Each text run's properties, in order (runs with no text are skipped). */
function runPrs(p: string): string[] {
  const out: string[] = []
  for (const r of topLevelElements(innerOf(p, 'w:p'))) {
    if (r.name !== 'w:r' && r.name !== 'w:hyperlink') continue
    const runs = r.name === 'w:hyperlink' ? topLevelElements(innerOf(r.xml, 'w:hyperlink')).filter(x => x.name === 'w:r') : [r]
    for (const run of runs) {
      if (!/<w:t[\s>]/.test(run.xml)) continue
      out.push(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run.xml)?.[0] ?? '')
    }
  }
  return out
}

function innerOf(xml: string, name: string): string {
  const open = new RegExp(`^<${name}(?:\\s[^>]*)?>`).exec(xml)
  if (!open) return ''
  const end = xml.lastIndexOf(`</${name}>`)
  return end > open[0].length ? xml.slice(open[0].length, end) : ''
}

function styleIdOf(p: string): string | null {
  return /<w:pStyle w:val="([^"]+)"/.exec(pPrOf(p))?.[1] ?? null
}

function isBold(rPr: string): boolean {
  const m = /<w:b(?:\s+w:val="([^"]*)")?\s*\/>/.exec(rPr)
  return !!m && !(m[1] === '0' || m[1] === 'false')
}

function sizeOf(rPr: string): number | null {
  const m = /<w:sz w:val="(\d+)"/.exec(rPr)
  return m ? Number(m[1]) : null
}

/** A paragraph that carries this text, formatted as `proto` is: its paragraph properties and its first run's. */
export function paragraphLike(proto: string, text: string, opts: { runPr?: string } = {}): string {
  const pPr = pPrOf(proto)
  const rPr = opts.runPr ?? runPrs(proto)[0] ?? ''
  const lines = text.split('\n')
  const runs = lines.map((line, i) =>
    `<w:r>${rPr}${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`).join('')
  return `<w:p>${pPr}${runs}</w:p>`
}

/** Replace the text of a paragraph, keeping its paragraph properties and its first and last run's formatting. */
function retext(p: string, text: string): string {
  return paragraphLike(p, text)
}

/** "Label: value" in one paragraph, the label keeping its own run's formatting and the value the last run's. */
function relabel(p: string, label: string, value: string): string {
  const prs = runPrs(p)
  const labelPr = prs[0] ?? ''
  const valuePr = prs.length > 1 ? prs[prs.length - 1] : labelPr
  const sep = /[:：]\s*$/.test(label) ? ' ' : ': '
  return `<w:p>${pPrOf(p)}<w:r>${labelPr}<w:t xml:space="preserve">${escapeXml(label + sep)}</w:t></w:r>` +
    (value ? `<w:r>${valuePr}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>` : '') + '</w:p>'
}

// ---------------------------------------------------------------------------
// Reading the sample
// ---------------------------------------------------------------------------

interface StyleInfo { name: string; level: number | null }

function parseStyles(stylesXml: string): Map<string, StyleInfo> {
  const out = new Map<string, StyleInfo>()
  const re = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stylesXml))) {
    const name = /<w:name w:val="([^"]+)"/.exec(m[2])?.[1] ?? m[1]
    const outline = /<w:outlineLvl w:val="(\d+)"/.exec(m[2])?.[1]
    const h = /^heading\s*(\d)$/i.exec(name) ?? /^Heading(\d)$/.exec(m[1])
    const level = /^title$/i.test(name) ? 0 : h ? Number(h[1]) : outline != null ? Number(outline) + 1 : null
    out.set(m[1], { name, level })
  }
  return out
}

interface Block {
  kind: 'p' | 'tbl' | 'other'
  xml: string
  text: string
  /** Heading level: 0 title, 1.. headings; null for body text. */
  level: number | null
  bullet: boolean
}

function classify(el: { name: string; xml: string }, styles: Map<string, StyleInfo>, bodySize: number | null): Block {
  if (el.name === 'w:tbl') return { kind: 'tbl', xml: el.xml, text: textOf(el.xml), level: null, bullet: false }
  if (el.name !== 'w:p') return { kind: 'other', xml: el.xml, text: textOf(el.xml), level: null, bullet: false }
  const text = textOf(el.xml).trim()
  const bullet = /<w:numPr>/.test(pPrOf(el.xml))
  const sid = styleIdOf(el.xml)
  const styled = sid ? styles.get(sid)?.level ?? null : null
  let level: number | null = styled
  if (level == null && text && !bullet) {
    // A heading made by hand: a short line, all bold (or set larger than the body), not a sentence.
    const prs = runPrs(el.xml)
    const allBold = prs.length > 0 && prs.every(isBold)
    const size = prs.map(sizeOf).find(s => s != null) ?? null
    const larger = size != null && bodySize != null && size > bodySize
    const short = text.length <= 80 && !/[.;,]$/.test(text) && text.split(/\s+/).length <= 10
    if (short && (allBold || larger) && !/[:：]\s*\S/.test(text)) level = larger && size! >= (bodySize ?? 0) + 8 ? 1 : 2
  }
  return { kind: 'p', xml: el.xml, text, level, bullet }
}

/** The run size most long paragraphs use: the body text size, for telling hand-made headings apart. */
function bodyRunSize(els: Array<{ name: string; xml: string }>): number | null {
  const counts = new Map<number, number>()
  for (const el of els) {
    if (el.name !== 'w:p' || textOf(el.xml).length < 120) continue
    for (const pr of runPrs(el.xml)) {
      const s = sizeOf(pr)
      if (s != null) counts.set(s, (counts.get(s) ?? 0) + 1)
    }
  }
  let best: number | null = null
  for (const [s, n] of counts) if (best == null || n > counts.get(best)!) best = s
  return best
}

interface Parsed {
  zip: JSZip
  documentXml: string
  bodyOpen: string
  blocks: Block[]
  sectPr: string
  /** Index of the first section heading; blocks before it are the first page. */
  firstSection: number
  sectionLevel: number | null
  headingProto: string | null
  bodyProto: string | null
  bulletProto: string | null
  titleIndex: number
}

async function parse(bytes: Uint8Array | Buffer): Promise<Parsed> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error('The design template is not a Word (.docx) file.')
  }
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('The design template is not a Word (.docx) file.')
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? ''
  const styles = parseStyles(stylesXml)

  const bodyMatch = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/.exec(documentXml)
  if (!bodyMatch) throw new Error('The design template has no body.')
  const bodyOpen = /<w:body(?:\s[^>]*)?>/.exec(documentXml)![0]
  const els = topLevelElements(bodyMatch[1])
  const sectEl = els.length && els[els.length - 1].name === 'w:sectPr' ? els.pop()! : null
  const bodySize = bodyRunSize(els)
  const blocks = els.map(el => classify(el, styles, bodySize))

  // Section headings are the most common heading level below the title.
  const levels = new Map<number, number>()
  for (const b of blocks) if (b.level != null && b.level > 0 && b.text) levels.set(b.level, (levels.get(b.level) ?? 0) + 1)
  let sectionLevel: number | null = null
  for (const [l, n] of [...levels].sort((a, b) => a[0] - b[0])) {
    if (sectionLevel == null || n >= 2 && n > (levels.get(sectionLevel) ?? 0)) sectionLevel = l
  }
  // Prefer the shallowest level used at least twice: memos have a handful of top sections.
  const twice = [...levels].filter(([, n]) => n >= 2).map(([l]) => l).sort((a, b) => a - b)
  if (twice.length) sectionLevel = twice[0]

  const firstSection = sectionLevel == null ? blocks.length : blocks.findIndex(b => b.level === sectionLevel && b.text)
  const after = blocks.slice(firstSection)
  const headingProto = after.find(b => b.level === sectionLevel && b.text)?.xml ?? null
  // Body: the most common formatting among long, unbulleted paragraphs after the first page.
  const sig = (b: Block) => pPrOf(b.xml) + '|' + (runPrs(b.xml)[0] ?? '')
  const bodyCandidates = after.filter(b => b.kind === 'p' && b.level == null && !b.bullet && b.text.length >= 60)
  const sigCount = new Map<string, number>()
  for (const b of bodyCandidates) sigCount.set(sig(b), (sigCount.get(sig(b)) ?? 0) + 1)
  const bodyProto = bodyCandidates.sort((a, b) => (sigCount.get(sig(b)) ?? 0) - (sigCount.get(sig(a)) ?? 0))[0]?.xml
    ?? after.find(b => b.kind === 'p' && b.level == null && !b.bullet && b.text)?.xml ?? null
  const bulletProto = after.find(b => b.kind === 'p' && b.bullet && b.text)?.xml ?? null

  const head = blocks.slice(0, Math.max(0, firstSection))
  let titleIndex = head.findIndex(b => b.kind === 'p' && b.level === 0 && b.text)
  if (titleIndex < 0) titleIndex = head.findIndex(b => b.kind === 'p' && b.level != null && b.text && !fieldForLabel(b.text))

  return {
    zip, documentXml, bodyOpen, blocks, sectPr: sectEl?.xml ?? '', firstSection: Math.max(0, firstSection),
    sectionLevel, headingProto, bodyProto, bulletProto, titleIndex,
  }
}

/** Each [label, value] pair a first-page table holds: label-value rows, or a row of labels over a row of values. */
function tableFields(tbl: string): Array<{ row: number; cell: number; field: DesignFieldName; label: string }> {
  const rows = topLevelElements(innerOf(tbl, 'w:tbl')).filter(e => e.name === 'w:tr').map(r =>
    topLevelElements(innerOf(r.xml, 'w:tr')).filter(c => c.name === 'w:tc').map(c => textOf(c.xml).trim()))
  const out: Array<{ row: number; cell: number; field: DesignFieldName; label: string }> = []
  rows.forEach((cells, r) => {
    for (let c = 0; c + 1 < cells.length; c++) {
      const f = fieldForLabel(cells[c])
      if (f) { out.push({ row: r, cell: c + 1, field: f, label: cells[c] }); c++ }
    }
  })
  if (out.length === 0 && rows.length >= 2) {
    rows[0].forEach((label, c) => {
      const f = fieldForLabel(label)
      if (f && c < rows[1].length) out.push({ row: 1, cell: c, field: f, label })
    })
  }
  return out
}

function labelledLine(text: string): { label: string; value: string; field: DesignFieldName } | null {
  const m = /^([^:：\n]{1,40}[:：])\s*(.*)$/.exec(text)
  if (!m) return null
  const field = fieldForLabel(m[1])
  return field ? { label: m[1].trim(), value: m[2], field } : null
}

const DATE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:q[1-4]|h[12])\s+\d{4})\b/i

/** Read a sample memo's design: its section headings and the fields its first page holds. */
export async function analyzeMemoDesign(bytes: Uint8Array | Buffer): Promise<MemoDesign> {
  const p = await parse(bytes)
  const warnings: string[] = []
  if (p.sectionLevel == null) warnings.push('No section headings were found, so the memo keeps its own section names and the body text keeps the sample\'s style.')
  if (!p.bodyProto) warnings.push('No body paragraph was found to copy the text style from.')
  const headings = p.blocks.slice(p.firstSection).filter(b => b.level === p.sectionLevel && b.text).map(b => b.text)
  const fields: MemoDesignField[] = []
  for (const b of p.blocks.slice(0, p.firstSection)) {
    if (b.kind === 'tbl') for (const f of tableFields(b.xml)) fields.push({ field: f.field, label: f.label.replace(/[:：]\s*$/, '') })
    else if (b.kind === 'p') { const l = labelledLine(b.text); if (l) fields.push({ field: l.field, label: l.label.replace(/[:：]\s*$/, '') }) }
  }
  const title = p.titleIndex >= 0 ? p.blocks[p.titleIndex].text : null
  return { headings, fields, title, warnings }
}

function fillTable(tbl: string, header: DesignMemoInput['header']): string {
  const fields = tableFields(tbl)
  if (fields.length === 0) return tbl
  const inner = innerOf(tbl, 'w:tbl')
  const open = /^<w:tbl(?:\s[^>]*)?>/.exec(tbl)![0]
  let r = -1
  const rebuilt = topLevelElements(inner).map(el => {
    if (el.name !== 'w:tr') return el.xml
    r++
    const rowFields = fields.filter(f => f.row === r)
    if (rowFields.length === 0) return el.xml
    const rowOpen = /^<w:tr(?:\s[^>]*)?>/.exec(el.xml)![0]
    let c = -1
    const cells = topLevelElements(innerOf(el.xml, 'w:tr')).map(cel => {
      if (cel.name !== 'w:tc') return cel.xml
      c++
      const f = rowFields.find(x => x.cell === c)
      if (!f) return cel.xml
      const tcOpen = /^<w:tc(?:\s[^>]*)?>/.exec(cel.xml)![0]
      const parts = topLevelElements(innerOf(cel.xml, 'w:tc'))
      const tcPr = parts.find(x => x.name === 'w:tcPr')?.xml ?? ''
      const firstP = parts.find(x => x.name === 'w:p')?.xml ?? '<w:p/>'
      return `${tcOpen}${tcPr}${paragraphLike(firstP, header[f.field] ?? '')}</w:tc>`
    })
    return `${rowOpen}${cells.join('')}</w:tr>`
  })
  return `${open}${rebuilt.join('')}</w:tbl>`
}

/**
 * The first page with this memo's facts: the title, labelled lines, table fields and dates replaced;
 * lines that mention the sample's company are rewritten for this one, and any other prose (the sample's
 * own summary, which would carry another company's facts) is dropped. Short fixed lines are kept.
 */
function fillFirstPage(p: Parsed, header: DesignMemoInput['header']): string[] {
  const out: string[] = []
  const sampleTitle = p.titleIndex >= 0 ? p.blocks[p.titleIndex].text : null
  const company = header.company_name ?? ''
  const date = header.memo_date ?? ''
  p.blocks.slice(0, p.firstSection).forEach((b, i) => {
    if (b.kind === 'tbl') { out.push(fillTable(b.xml, header)); return }
    if (b.kind === 'other') { out.push(b.xml); return }
    if (!b.text) { out.push(b.xml); return }
    if (i === p.titleIndex) { out.push(retext(b.xml, company)); return }
    const l = labelledLine(b.text)
    if (l) { out.push(relabel(b.xml, l.label, header[l.field] ?? '')); return }
    let text = b.text
    const mentionsSample = !!sampleTitle && sampleTitle.length >= 2 && text.toLowerCase().includes(sampleTitle.toLowerCase())
    if (mentionsSample) text = text.split(new RegExp(escapeRegExp(sampleTitle!), 'gi')).join(company)
    if (DATE.test(text)) text = text.replace(DATE, date)
    const fixed = text.length <= 80 && !/\d/.test(text.replace(company, '').replace(date, ''))
    if (fixed || DATE.test(b.text) && text.length <= 80) {
      out.push(text === b.text ? b.xml : retext(b.xml, text))
    }
    // Anything else is the sample's own content: left out.
  })
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const FALLBACK_P = '<w:p/>'

/** The memo written into the sample's design, as a .docx. */
export async function renderWithDesign(bytes: Uint8Array | Buffer, memo: DesignMemoInput): Promise<Buffer> {
  const p = await parse(bytes)
  const parts: string[] = fillFirstPage(p, memo.header)
  const headingProto = p.headingProto ?? p.bodyProto ?? FALLBACK_P
  const bodyProto = p.bodyProto ?? FALLBACK_P
  const bulletProto = p.bulletProto
  const headingRun = p.headingProto ? undefined : '<w:rPr><w:b/></w:rPr>'
  for (const s of memo.sections) {
    if (s.title) parts.push(paragraphLike(headingProto, s.title, headingRun ? { runPr: headingRun } : {}))
    for (const para of s.paragraphs) {
      const lines = para.split('\n')
      const isList = bulletProto && lines.length > 0 && lines.every(l => /^\s*[-•*]\s+/.test(l))
      if (isList) for (const l of lines) parts.push(paragraphLike(bulletProto!, l.replace(/^\s*[-•*]\s+/, '')))
      else parts.push(paragraphLike(bodyProto, para))
    }
  }
  const sampleTitle = p.titleIndex >= 0 ? p.blocks[p.titleIndex].text : null
  const body = `${p.bodyOpen}${parts.join('')}${p.sectPr}</w:body>`
  const doc = p.documentXml.replace(/<w:body(?:\s[^>]*)?>[\s\S]*<\/w:body>/, () => body)
  p.zip.file('word/document.xml', doc)

  // Headers and footers are the firm's (logo, "Confidential", page numbers) and stay, except a mention
  // of the sample's company, which becomes this memo's.
  if (sampleTitle && sampleTitle.length >= 2 && memo.header.company_name) {
    for (const name of Object.keys(p.zip.files).filter(n => /^word\/(header|footer)\d*\.xml$/.test(n))) {
      const xml = await p.zip.file(name)!.async('string')
      const re = new RegExp(escapeRegExp(escapeXml(sampleTitle)), 'g')
      if (re.test(xml)) p.zip.file(name, xml.replace(re, escapeXml(memo.header.company_name)))
    }
  }
  await dropSampleNotes(p.zip)
  return Buffer.from(await p.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

/**
 * The sample's comments, footnotes and endnotes are about the sample's company, and the body that
 * pointed at them is gone, so their text goes too. The parts themselves stay (Word expects the
 * separator notes), emptied of everything but those.
 */
async function dropSampleNotes(zip: JSZip): Promise<void> {
  const comments = zip.file('word/comments.xml')
  if (comments) {
    const xml = await comments.async('string')
    zip.file('word/comments.xml', xml.replace(/<w:comment\b[\s\S]*?<\/w:comment>/g, ''))
  }
  for (const [part, tag] of [['word/footnotes.xml', 'w:footnote'], ['word/endnotes.xml', 'w:endnote']] as const) {
    const f = zip.file(part)
    if (!f) continue
    const xml = await f.async('string')
    const re = new RegExp(`<${tag}\\b([^>]*)>[\\s\\S]*?<\\/${tag}>`, 'g')
    zip.file(part, xml.replace(re, (whole, attrs: string) => /w:type="/.test(attrs) ? whole : ''))
  }
}

/**
 * The memo's sections laid out as the sample's headings: each heading becomes a section, matched to
 * the fund's schema section with the same or a close title (so the agent knows what to write there),
 * otherwise a custom section to cover what its title says.
 */
export function sectionsFromHeadings(
  headings: string[],
  schemaSections: Array<{ id: string; title: string }>,
): Array<{ id: string; title: string; included: true; custom?: true; cover?: string }> {
  const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const SYNONYMS: Record<string, string[]> = {
    executive_summary: ['summary', 'executive summary', 'overview', 'investment summary', 'tl dr', 'tldr', 'snapshot'],
    recommendation: ['recommendation', 'proposal', 'the ask', 'ask', 'decision'],
    company_overview: ['company', 'company overview', 'business overview', 'about', 'background', 'description'],
    product: ['product', 'product and technology', 'technology', 'solution'],
    market: ['market', 'market opportunity', 'opportunity', 'tam', 'market size', 'why now'],
    traction: ['traction', 'metrics', 'kpis', 'performance', 'financials', 'financial overview'],
    business_model: ['business model', 'unit economics', 'revenue model', 'pricing', 'go to market', 'gtm'],
    team: ['team', 'founders', 'management', 'founding team', 'people'],
    competition_moat: ['competition', 'competitive landscape', 'competitors', 'moat', 'differentiation'],
    outcomes_analysis: ['outcomes', 'returns', 'exit', 'return analysis', 'outcomes analysis', 'valuation'],
    deal_terms: ['terms', 'deal terms', 'the deal', 'round', 'financing', 'transaction', 'investment terms'],
    risks_and_open_questions: ['risks', 'key risks', 'risks and mitigants', 'open questions', 'concerns', 'diligence questions'],
  }
  const used = new Set<string>()
  const out: Array<{ id: string; title: string; included: true; custom?: true; cover?: string }> = []
  for (const h of headings) {
    const n = norm(h.replace(/^\s*(?:\d+|[ivx]+|[a-z])[.)]\s+/i, ''))
    let match = schemaSections.find(s => !used.has(s.id) && norm(s.title) === n)
    if (!match) {
      for (const [id, words] of Object.entries(SYNONYMS)) {
        const s = schemaSections.find(x => x.id === id)
        if (s && !used.has(id) && words.some(w => n === w || n.startsWith(w + ' ') || n.endsWith(' ' + w))) { match = s; break }
      }
    }
    if (match) { used.add(match.id); out.push({ id: match.id, title: h.trim(), included: true }); continue }
    let id = 'custom_' + n.replace(/ /g, '_').slice(0, 40)
    while (out.some(o => o.id === id)) id += '_x'
    out.push({ id, title: h.trim(), included: true, custom: true, cover: `What the fund's memos cover under "${h.trim()}".` })
  }
  return out
}

/**
 * A memo's text from a Word file, by section: the same heading detection as the design reader, so a
 * memo exported (in the fund's design or the standard layout) and edited in Word reads back under the
 * same headings. Bulleted lines come back as "- " lines of one paragraph.
 */
export async function readMemoDocx(bytes: Uint8Array | Buffer): Promise<{ sections: Array<{ title: string; paragraphs: string[] }> }> {
  const p = await parse(bytes)
  const sections: Array<{ title: string; paragraphs: string[] }> = []
  let current: { title: string; paragraphs: string[] } | null = null
  let list: string[] = []
  const flush = () => { if (current && list.length) current.paragraphs.push(list.map(l => `- ${l}`).join('\n')); list = [] }
  for (const b of p.blocks.slice(p.firstSection)) {
    if (b.kind === 'p' && b.level === p.sectionLevel && b.text) {
      flush()
      current = { title: b.text, paragraphs: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    if (b.kind === 'tbl') { flush(); const t = textOf(b.xml).trim(); if (t) current.paragraphs.push(t); continue }
    if (b.kind !== 'p' || !b.text) continue
    if (b.bullet) { list.push(b.text); continue }
    flush()
    // A sub-heading inside a section is kept as its own short paragraph.
    current.paragraphs.push(b.text)
  }
  flush()
  return { sections }
}
