import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { scanFileAsync } from '@/lib/security/scan-file'

export type ExtractionStatus = 'complete' | 'partial' | 'failed' | 'not_applicable'

export interface ExtractedArtifact {
  text: string
  status: ExtractionStatus
  parser: string
  parserVersion: string
  warnings: string[]
  metadata: Record<string, unknown>
  chunks: Array<{
    ordinal: number
    locator: Record<string, unknown>
    text: string
  }>
}

export interface ExtractedBody {
  original: string
  current: string
  status: 'complete' | 'partial' | 'failed'
  cleaningStatus: 'complete' | 'uncertain' | 'not_applicable'
  cleanerVersion: string
  warnings: string[]
  forwardedSender: { name: string | null; email: string } | null
  originalChunks: ExtractedArtifact['chunks']
  currentChunks: ExtractedArtifact['chunks']
}

export interface ExtractedAttachment {
  contentSha256: string | null
  detectedContentType: string | null
  byteSize: number | null
  result: ExtractedArtifact
}

export const ARTIFACT_PARSER_VERSION = 'company-updates-artifact-v2'
export const BODY_CLEANER_VERSION = 'company-updates-body-v2'
/**
 * Version of the whole capture (body cleaner + every artifact parser). Stored on the update row so
 * a backfill can tell "captured by an older release" from "captured by this one". Bump whenever
 * either constituent version changes.
 */
export const CAPTURE_VERSION = `${BODY_CLEANER_VERSION}+${ARTIFACT_PARSER_VERSION}`

const MAX_CHUNK_CHARS = 10_000
/** Matches the inbound attachment cap; larger bytes are refused with an explicit reason. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_WORKBOOK_SHEETS = 100
const MAX_SHEET_ROWS = 20_000
const MAX_SHEET_COLUMNS = 200
/** Cells rendered across the whole workbook before the rest is recorded as skipped. */
const MAX_WORKBOOK_CELLS = 400_000
/** Characters of extracted text per artifact before further structure is recorded as skipped. */
const MAX_ARTIFACT_TEXT_CHARS = 5_000_000
/** A PDF page with fewer alphanumeric characters than this is treated as image-only. */
const MIN_PAGE_TEXT_CHARS = 25

type EmailBodyPayload = { TextBody?: string; HtmlBody?: string }

type ArtifactInput = {
  filename: string
  declaredContentType?: string | null
  content?: string | null
  contentError?: string | null
}

export type ParsedContent = Omit<ExtractedArtifact, 'parserVersion'>

/** Fewer non-whitespace characters than this left over is a separator, not history worth indexing. */
const MIN_HISTORY_CHARS = 40

/**
 * The text to index as `body_original`: only the quoted history the current message does not
 * already contain. Forwards and uncertain cleanings keep the whole body in `current`, so chunking
 * `original` too would index every passage twice and search would return both. The stored
 * `original` column is unchanged; only what gets chunked differs.
 */
function quotedHistory(original: string, current: string): string {
  const needle = current.trim()
  if (!needle) return original
  const tokens = needle.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const match = new RegExp(tokens.join('\\s+')).exec(original)
  if (!match) return original // no containment: keep indexing the whole original
  const rest = (original.slice(0, match.index) + '\n' + original.slice(match.index + match[0].length))
    .replace(/^[\s\-_=*>]*(?:-{2,}\s*)?(?:forwarded message|original message)?[\s\-_=*]*$/gim, '')
    .trim()
  return rest.replace(/\s/g, '').length > MIN_HISTORY_CHARS ? rest : ''
}

/** Normalize both faithful and retrieval-oriented email body representations. */
export function extractEmailBody(payload: EmailBodyPayload): ExtractedBody {
  const plain = normalizePlainText(payload.TextBody ?? '')
  const html = payload.HtmlBody ? htmlToText(payload.HtmlBody) : ''
  const original = plain || html
  const warnings: string[] = []

  if (!plain && html) warnings.push('Plain-text body was unavailable; normalized text was derived from HTML.')

  const cleaned = cleanCurrentMessage(original)
  warnings.push(...cleaned.warnings)

  return {
    original,
    current: cleaned.text,
    status: 'complete',
    cleaningStatus: original ? cleaned.status : 'not_applicable',
    cleanerVersion: BODY_CLEANER_VERSION,
    warnings,
    forwardedSender: findForwardedSender(original),
    originalChunks: chunkText(quotedHistory(original, cleaned.text), { section: 'email_body', representation: 'original' }),
    currentChunks: chunkText(cleaned.text, { section: 'email_body', representation: 'current' }),
  }
}

/**
 * Extract one attachment into the common evidence contract. Exceptions and safety failures are
 * returned as durable failed results rather than being confused with empty documents.
 */
export async function extractArtifact(input: ArtifactInput): Promise<ExtractedAttachment> {
  if (!input.content) {
    return {
      contentSha256: null,
      detectedContentType: null,
      byteSize: null,
      result: failed('content-loader', input.contentError || 'Attachment bytes were unavailable.'),
    }
  }

  let buffer: Buffer
  try {
    const compact = input.content.replace(/\s/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
      throw new Error('invalid base64 encoding')
    }
    buffer = Buffer.from(compact, 'base64')
    if (compact && buffer.length === 0) throw new Error('invalid base64 encoding')
  } catch (error) {
    return {
      contentSha256: null,
      detectedContentType: null,
      byteSize: null,
      result: failed('base64-decoder', `Attachment content could not be decoded: ${errorMessage(error)}`),
    }
  }

  const contentSha256 = createHash('sha256').update(buffer).digest('hex')
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    return {
      contentSha256,
      detectedContentType: normalizeContentType(input.declaredContentType) ?? typeFromExtension(input.filename),
      byteSize: buffer.length,
      result: failed('size-limit', `Attachment is ${buffer.length} bytes; the extraction limit is ${MAX_ARTIFACT_BYTES} bytes.`),
    }
  }
  if (buffer.length === 0) {
    return {
      contentSha256,
      detectedContentType: normalizeContentType(input.declaredContentType) ?? typeFromExtension(input.filename),
      byteSize: 0,
      result: failed('content-loader', 'Attachment is empty (0 bytes).'),
    }
  }
  const detectedContentType = await detectContentType(buffer, input.filename, input.declaredContentType)
  const warnings: string[] = []
  const declared = normalizeContentType(input.declaredContentType)
  if (declared && detectedContentType && declared !== detectedContentType) {
    warnings.push(`Declared content type ${declared} differs from detected type ${detectedContentType}.`)
  }

  const scan = await scanFileAsync(buffer, input.filename, detectedContentType ?? declared ?? '')
  if (!scan.safe) {
    return {
      contentSha256,
      detectedContentType,
      byteSize: buffer.length,
      result: failed('safety-scan', scan.reason ?? 'Attachment did not pass the safety scan.', warnings),
    }
  }

  try {
    const parsed = await parseDetected(buffer, input.filename, detectedContentType)
    return {
      contentSha256,
      detectedContentType,
      byteSize: buffer.length,
      result: { ...parsed, warnings: [...warnings, ...parsed.warnings], parserVersion: ARTIFACT_PARSER_VERSION },
    }
  } catch (error) {
    return {
      contentSha256,
      detectedContentType,
      byteSize: buffer.length,
      result: failed('parser', `Extraction failed: ${errorMessage(error)}`, warnings),
    }
  }
}

export async function detectContentType(
  buffer: Buffer,
  filename: string,
  declaredContentType?: string | null,
): Promise<string | null> {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])) {
    return extension(filename) === 'xls' ? 'application/vnd.ms-excel' : 'application/x-ole-storage'
  }

  if (startsWith(buffer, [0x50, 0x4b])) {
    try {
      const zip = await JSZip.loadAsync(buffer)
      const entries = new Set(Object.keys(zip.files))
      if (entries.has('word/document.xml')) {
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
      if (entries.has('xl/workbook.xml')) {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
      if (entries.has('ppt/presentation.xml')) {
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      }
      return 'application/zip'
    } catch {
      // The format-aware safety scan will fail closed for an unreadable claimed archive.
      return normalizeContentType(declaredContentType) ?? typeFromExtension(filename) ?? 'application/zip'
    }
  }

  const declared = normalizeContentType(declaredContentType)
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') return declared
  return typeFromExtension(filename) ?? (looksLikeText(buffer) ? 'text/plain' : null)
}

async function parseDetected(buffer: Buffer, filename: string, detected: string | null): Promise<ParsedContent> {
  if (detected === 'application/pdf') return extractPdf(buffer)
  if (detected === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(buffer)
  }
  if (detected === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return extractPptx(buffer)
  }
  if (
    detected === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    detected === 'application/vnd.ms-excel'
  ) {
    return extractWorkbook(buffer, detected === 'application/vnd.ms-excel' ? 'sheetjs-xls' : 'sheetjs-xlsx')
  }
  if (detected === 'text/csv' || detected === 'application/csv') return extractCsv(buffer)
  if (detected?.startsWith('text/')) return extractPlainFile(buffer)
  if (detected?.startsWith('image/')) {
    return {
      text: '',
      status: 'not_applicable',
      parser: 'ocr-pending',
      warnings: ['Image text extraction requires OCR; queued for the OCR worker, no searchable text yet.'],
      metadata: { ocrNeeded: true, ocrUsed: false },
      chunks: [],
    }
  }

  return {
    text: '',
    status: 'not_applicable',
    parser: 'unsupported',
    warnings: [`No deterministic text parser is available for ${detected ?? (extension(filename) || 'this file type')}.`],
    metadata: {},
    chunks: [],
  }
}

async function extractPdf(buffer: Buffer): Promise<ParsedContent> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(new Uint8Array(buffer))
  const extracted = await extractText(doc)
  const pages = extracted.text.map(normalizePlainText)
  return assemblePdfPages(pages, extracted.totalPages)
}

/**
 * Build the PDF representation from per-page text. Shared by the local parser and the OCR merge so
 * both produce identical text, chunks, locators and status rules. `ocrPages` marks pages whose
 * text came from OCR rather than the PDF's own text layer.
 */
export function assemblePdfPages(
  pages: string[],
  pageCount: number,
  options: { ocrPages?: number[]; ocrEngine?: string } = {},
): ParsedContent {
  const ocrPages = new Set(options.ocrPages ?? [])
  // A page OCR has already read is read: its transcription IS the page's text, however short
  // (a chart title), so it is neither queued again nor dropped from the chunks.
  const unread = (page: string, index: number) => !ocrPages.has(index + 1) && isNearlyTextless(page)
  const textless = pages.flatMap((page, index) => (unread(page, index) ? [index + 1] : []))
  const pagesWithText = pages.length - textless.length
  const text = pages
    .map((page, index) => {
      const number = index + 1
      const label = ocrPages.has(number) ? `[Page ${number} (OCR)]` : `[Page ${number}]`
      return `${label}\n${page}`
    })
    .join('\n\n')
    .trim()
  const chunks = pages.flatMap((page, index) => {
    if (unread(page, index) || !page) return []
    const number = index + 1
    const locator: Record<string, unknown> = { page: number }
    if (ocrPages.has(number)) locator.ocr = true
    return chunkText(page, locator).map(chunk => ({ ...chunk, ordinal: 0 }))
  })
  renumber(chunks)

  const metadata: Record<string, unknown> = {
    pageCount,
    pagesWithText,
    textCoverage: pageCount ? pagesWithText / pageCount : 0,
    ocrNeededPages: textless,
    ocrNeeded: textless.length > 0,
    ocrUsed: ocrPages.size > 0,
    ocrPages: Array.from(ocrPages).sort((a, b) => a - b),
  }
  if (options.ocrEngine) metadata.ocrEngine = options.ocrEngine

  if (pagesWithText === 0) {
    return {
      text: '',
      status: 'failed',
      parser: options.ocrEngine ?? 'unpdf',
      warnings: ['PDF contained no selectable text; all pages require OCR.'],
      metadata,
      chunks: [],
    }
  }

  return {
    text,
    status: textless.length ? 'partial' : 'complete',
    parser: options.ocrEngine ? `unpdf+${options.ocrEngine}` : 'unpdf',
    warnings: textless.length ? [`PDF pages requiring OCR: ${textless.join(', ')}.`] : [],
    metadata,
    chunks,
  }
}

function isNearlyTextless(page: string): boolean {
  // Letters and digits across Latin, Latin-extended, Greek and Cyrillic; the build targets ES5, so
  // no `\p{L}` here.
  return (page.match(/[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g) ?? []).length < MIN_PAGE_TEXT_CHARS
}

async function extractDocx(buffer: Buffer): Promise<ParsedContent> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.files['word/document.xml']
  if (!entry) throw new Error('DOCX archive has no word/document.xml')
  const xml = await entry.async('string')
  const blocks = parseDocxBlocks(xml)
  if (blocks.length === 0 && /<w:t\b/.test(xml)) {
    // Structure we could not walk but text we can still keep: fall back to a flat extraction and
    // say so, rather than returning an empty "complete" document.
    const result = await mammoth.extractRawText({ buffer })
    const text = normalizePlainText(result.value ?? '')
    return {
      text,
      status: 'partial',
      parser: 'mammoth',
      warnings: ['DOCX structure could not be walked; paragraph and heading boundaries were not preserved.'],
      metadata: { paragraphCount: text ? text.split(/\n{2,}/).length : 0 },
      chunks: chunkText(text, { section: 'document' }),
    }
  }

  const lines = blocks.map(block => block.text)
  const text = normalizePlainText(lines.join('\n\n'))
  const chunks = chunkBlocks(blocks.map(block => ({ text: block.text, heading: block.heading, kind: block.kind, index: block.index })))
  return {
    text,
    status: 'complete',
    parser: 'docx-xml',
    warnings: [],
    metadata: {
      paragraphCount: blocks.filter(block => block.kind === 'paragraph').length,
      headingCount: blocks.filter(block => block.kind === 'heading').length,
      tableCount: new Set(blocks.filter(block => block.kind === 'table_row').map(block => block.table)).size,
    },
    chunks,
  }
}

interface DocBlock {
  kind: 'heading' | 'paragraph' | 'table_row'
  text: string
  /** The nearest preceding heading, repeated into each chunk so it stands alone. */
  heading: string | null
  /** Ordinal of the block in document order (paragraphs and table rows alike). */
  index: number
  table?: number
}

/** Walk word/document.xml in order: headings, paragraphs (with list markers) and table rows. */
function parseDocxBlocks(xml: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let heading: string | null = null
  let tableCounter = 0
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml)
  const body = bodyMatch?.[1] ?? xml
  const tokens = Array.from(body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g))
  for (const token of tokens) {
    const fragment = token[0]
    if (fragment.startsWith('<w:tbl')) {
      tableCounter++
      for (const row of Array.from(fragment.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g))) {
        const cells = Array.from(row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g))
          .map(cell => docxRunText(cell[0]).replace(/\s*\n\s*/g, ' ').trim())
        const text = cells.join(' | ').trim()
        if (text.replace(/[\s|]/g, '')) {
          blocks.push({ kind: 'table_row', text, heading, index: blocks.length, table: tableCounter })
        }
      }
      continue
    }
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(fragment)?.[1] ?? ''
    const isHeading = /^(heading|title|subtitle)/i.test(style)
    const isList = /<w:numPr\b/.test(fragment)
    const runText = docxRunText(fragment).trim()
    if (!runText) continue
    if (isHeading) {
      heading = runText
      blocks.push({ kind: 'heading', text: runText, heading: runText, index: blocks.length })
    } else {
      blocks.push({ kind: 'paragraph', text: isList ? `- ${runText}` : runText, heading, index: blocks.length })
    }
  }
  return blocks
}

function docxRunText(fragment: string): string {
  return fragment
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, inner: string) => decodeXml(inner))
    .replace(/<[^>]+>/g, '')
}

/**
 * Chunk a sequence of structural blocks on block boundaries, never mid-paragraph unless one block
 * alone exceeds the limit. The governing heading is repeated at the top of every chunk.
 */
function chunkBlocks(
  blocks: Array<{ text: string; heading: string | null; kind: string; index: number }>,
): ExtractedArtifact['chunks'] {
  const chunks: ExtractedArtifact['chunks'] = []
  let group: typeof blocks = []
  let chars = 0
  const flush = () => {
    if (!group.length) return
    const heading = group[0].heading
    const prefix = heading && group[0].text !== heading ? `${heading}\n\n` : ''
    const body = group.map(block => block.text).join('\n\n')
    const locator = { blockStart: group[0].index, blockEnd: group[group.length - 1].index, heading }
    for (const part of chunkText(`${prefix}${body}`, locator)) chunks.push({ ...part, ordinal: 0 })
    group = []
    chars = 0
  }
  for (const block of blocks) {
    // A heading opens a new chunk so every locator names exactly one section.
    if (group.length && (block.kind === 'heading' || chars + block.text.length + 2 > MAX_CHUNK_CHARS)) flush()
    group.push(block)
    chars += block.text.length + 2
  }
  flush()
  renumber(chunks)
  return chunks
}

async function extractPptx(buffer: Buffer): Promise<ParsedContent> {
  const zip = await JSZip.loadAsync(buffer)
  const slideEntries = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  if (slideEntries.length === 0) throw new Error('PPTX archive has no slides')
  const slides: Array<{ number: number; text: string; notes: string }> = []

  for (const entry of slideEntries) {
    const number = slideNumber(entry)
    const xml = await zip.files[entry].async('string')
    const notesEntry = zip.files[`ppt/notesSlides/notesSlide${number}.xml`]
    const notesXml = notesEntry ? await notesEntry.async('string') : ''
    slides.push({ number, text: pptxSlideText(xml), notes: notesXml ? pptxSlideText(notesXml) : '' })
  }

  const sections = slides.map(slide => {
    const parts = [`[Slide ${slide.number}]`]
    if (slide.text) parts.push(slide.text)
    if (slide.notes) parts.push(`[Speaker notes]\n${slide.notes}`)
    return parts.join('\n')
  })
  const text = sections.join('\n\n').trim()
  const chunks = slides.flatMap(slide => [
    ...chunkText(slide.text, { slide: slide.number }).map(chunk => ({ ...chunk, ordinal: 0 })),
    ...chunkText(slide.notes, { slide: slide.number, section: 'notes' }).map(chunk => ({ ...chunk, ordinal: 0 })),
  ])
  renumber(chunks)
  return {
    text,
    status: 'complete',
    parser: 'jszip-pptx',
    warnings: [],
    metadata: {
      slideCount: slideEntries.length,
      slidesWithText: slides.filter(slide => slide.text).length,
      slidesWithNotes: slides.filter(slide => slide.notes).length,
    },
    chunks,
  }
}

/** Slide text with paragraph boundaries kept: runs inside one <a:p> join with nothing between. */
function pptxSlideText(xml: string): string {
  // Table rows render as one line per row so a KPI table stays intelligible.
  const withRows = xml.replace(/<a:tr\b[\s\S]*?<\/a:tr>/g, row => {
    const cells = Array.from(row.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g))
      .map(cell => Array.from(cell[0].matchAll(/<a:t(?:\\s[^>]*)?>([\s\S]*?)<\/a:t>/g)).map(m => decodeXml(m[1])).join('').trim())
    return `<a:p><a:t>${cells.join(' | ')}</a:t></a:p>`
  })
  const paragraphs = Array.from(withRows.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)).map(match =>
    Array.from(match[0].matchAll(/<a:t(?:\\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g))
      .map(run => (run[0].startsWith('<a:br') ? '\n' : decodeXml(run[1] ?? '')))
      .join('')
      .trim(),
  )
  if (paragraphs.length === 0) {
    // No <a:p> wrappers (a hand-built or unusual file): keep every run rather than losing the slide.
    return normalizePlainText(
      Array.from(withRows.matchAll(/<a:t(?:\\s[^>]*)?>([\s\S]*?)<\/a:t>/g)).map(m => decodeXml(m[1]).trim()).filter(Boolean).join('\n'),
    )
  }
  return normalizePlainText(paragraphs.filter(Boolean).join('\n'))
}

function extractCsv(buffer: Buffer): ParsedContent {
  const workbook = XLSX.read(buffer.toString('utf8'), { type: 'string', cellFormula: true, cellText: true })
  return extractWorkbookValue(workbook, 'sheetjs-csv')
}

function extractWorkbook(buffer: Buffer, parser: string): ParsedContent {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellText: true, cellDates: true })
  return extractWorkbookValue(workbook, parser)
}

function extractWorkbookValue(workbook: XLSX.WorkBook, parser: string): ParsedContent {
  const sections: string[] = []
  const chunks: ExtractedArtifact['chunks'] = []
  const warnings: string[] = []
  const sheetMetadata: Array<Record<string, unknown>> = []
  const sheetNames = workbook.SheetNames.slice(0, MAX_WORKBOOK_SHEETS)
  if (workbook.SheetNames.length > MAX_WORKBOOK_SHEETS) {
    warnings.push(`Skipped sheets ${MAX_WORKBOOK_SHEETS + 1}-${workbook.SheetNames.length}; workbook limit is ${MAX_WORKBOOK_SHEETS} sheets.`)
  }
  let cellBudget = MAX_WORKBOOK_CELLS
  let charBudget = MAX_ARTIFACT_TEXT_CHARS

  for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex++) {
    const name = sheetNames[sheetIndex]
    const sheet = workbook.Sheets[name]
    const visibility = sheetVisibility(workbook, sheetIndex)
    const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null
    if (!range) {
      sheetMetadata.push({ name, visibility, nonEmpty: false })
      continue
    }
    if (cellBudget <= 0 || charBudget <= 0) {
      warnings.push(`Sheet "${name}" was skipped; the workbook exceeded the extraction budget before it.`)
      sheetMetadata.push({ name, visibility, nonEmpty: null, skipped: true, sourceRange: sheet['!ref'] })
      continue
    }

    let lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1)
    const lastColumn = Math.min(range.e.c, range.s.c + MAX_SHEET_COLUMNS - 1)
    const columns = lastColumn - range.s.c + 1
    const affordableRows = Math.floor(cellBudget / columns)
    if (lastRow - range.s.r + 1 > affordableRows) lastRow = range.s.r + Math.max(affordableRows, 1) - 1
    cellBudget -= (lastRow - range.s.r + 1) * columns
    if (lastRow < range.e.r) warnings.push(`Sheet "${name}" was limited to rows ${range.s.r + 1}-${lastRow + 1}; rows ${lastRow + 2}-${range.e.r + 1} were skipped.`)
    if (lastColumn < range.e.c) warnings.push(`Sheet "${name}" was limited to columns ${columnName(range.s.c)}-${columnName(lastColumn)}; columns ${columnName(lastColumn + 1)}-${columnName(range.e.c)} were skipped.`)

    const rows: Array<{ row: number; text: string }> = []
    for (let rowIndex = range.s.r; rowIndex <= lastRow; rowIndex++) {
      const cells: string[] = []
      for (let column = range.s.c; column <= lastColumn; column++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })]
        if (!cell || (cell.v === undefined && !cell.f)) continue
        const display = cell.w ?? String(cell.v ?? '')
        const formula = cell.f ? `${display}${display ? ' ' : ''}[formula: =${cell.f}]` : display
        cells.push(`${columnName(column)}=${formula}`)
      }
      if (cells.length) {
        const rowText = `Row ${rowIndex + 1}: ${cells.join(' | ')}`
        charBudget -= rowText.length + 1
        if (charBudget < 0) {
          warnings.push(`Sheet "${name}" was cut at row ${rowIndex + 1}; the workbook exceeded ${MAX_ARTIFACT_TEXT_CHARS} characters of extracted text.`)
          lastRow = rowIndex
          break
        }
        rows.push({ row: rowIndex + 1, text: rowText })
      }
    }

    const heading = `[Sheet: ${name} | Visibility: ${visibility}]`
    if (rows.length) sections.push([heading, ...rows.map(row => row.text)].join('\n'))
    sheetMetadata.push({
      name,
      visibility,
      nonEmpty: rows.length > 0,
      sourceRange: sheet['!ref'],
      extractedRange: `${columnName(range.s.c)}${range.s.r + 1}:${columnName(lastColumn)}${lastRow + 1}`,
    })

    const header = rows[0]?.text ?? ''
    let group: Array<{ row: number; text: string }> = []
    let chars = heading.length
    const flush = () => {
      if (!group.length) return
      const repeatedHeader = group[0].row === rows[0]?.row ? '' : `\nHeader: ${header}`
      const chunkTextValue = `${heading}${repeatedHeader}\n${group.map(row => row.text).join('\n')}`
      chunks.push(...chunkText(chunkTextValue, {
        sheet: name,
        visibility,
        rowStart: group[0].row,
        rowEnd: group[group.length - 1].row,
        columnStart: columnName(range.s.c),
        columnEnd: columnName(lastColumn),
      }).map(chunk => ({ ...chunk, ordinal: 0 })))
      group = []
      chars = heading.length + header.length + 10
    }
    for (const row of rows) {
      if (group.length && chars + row.text.length + 1 > MAX_CHUNK_CHARS) flush()
      group.push(row)
      chars += row.text.length + 1
    }
    flush()
  }

  renumber(chunks)
  return {
    text: sections.join('\n\n').trim(),
    status: warnings.length ? 'partial' : 'complete',
    parser,
    warnings,
    metadata: { sheetCount: workbook.SheetNames.length, sheets: sheetMetadata },
    chunks,
  }
}

function extractPlainFile(buffer: Buffer): ParsedContent {
  const decoded = buffer.toString('utf8')
  let text = normalizePlainText(decoded)
  const replacementCount = Array.from(decoded).filter(char => char === '\ufffd').length
  const warnings = replacementCount ? [`UTF-8 decoding produced ${replacementCount} replacement character(s).`] : []
  if (text.length > MAX_ARTIFACT_TEXT_CHARS) {
    warnings.push(`Text was cut at ${MAX_ARTIFACT_TEXT_CHARS} of ${text.length} characters.`)
    text = text.slice(0, MAX_ARTIFACT_TEXT_CHARS)
  }
  return {
    text,
    status: warnings.length ? 'partial' : 'complete',
    parser: 'utf8',
    warnings,
    metadata: { encoding: 'utf-8', characters: decoded.length },
    chunks: chunkText(text, { section: 'text' }),
  }
}

function cleanCurrentMessage(original: string): {
  text: string
  status: 'complete' | 'uncertain'
  warnings: string[]
} {
  if (!original) return { text: '', status: 'complete', warnings: [] }
  const replyMarkers = [
    /^On .{1,300}wrote:\s*$/im,
    /^From:\s*[^\n]+\nSent:\s*[^\n]+\n(?:To|Subject):/im,
  ]
  let cut = original.length
  for (const marker of replyMarkers) {
    const match = marker.exec(original)
    if (match?.index !== undefined) cut = Math.min(cut, match.index)
  }
  const signature = /\n--\s*\n/.exec(original)
  if (signature?.index !== undefined) cut = Math.min(cut, signature.index)
  if (cut === original.length) return { text: original, status: 'complete', warnings: [] }

  const candidate = original.slice(0, cut).trim()
  if (candidate.length < Math.min(40, Math.floor(original.length * 0.05))) {
    return {
      text: original,
      status: 'uncertain',
      warnings: ['Quoted-history cleaning was uncertain and retained the complete body as current-message text.'],
    }
  }
  return { text: candidate, status: 'complete', warnings: [] }
}

function findForwardedSender(body: string): { name: string | null; email: string } | null {
  const marker = /(?:-{3,}\s*forwarded message\s*-{3,}|begin forwarded message)/i.exec(body)
  if (!marker?.index && marker?.index !== 0) return null
  const window = body.slice(marker.index, marker.index + 1_000)
  const from = /^\s*>?\s*from:\s*([^\n]+)/im.exec(window)?.[1]
  if (!from) return null
  const email = (/<([^>\s]+@[^>\s]+)>/.exec(from)?.[1] ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from)?.[1])
  if (!email) return null
  const name = from.replace(/<[^>]+>/, '').replace(email, '').trim().replace(/^["']|["']$/g, '') || null
  return { name, email: email.toLowerCase() }
}

function htmlToText(html: string): string {
  return normalizePlainText(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      .replace(/<\/(?:p|div|ul|ol|blockquote|h[1-6]|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => decodeEntity(entity)),
  )
}

export function normalizePlainText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function chunkText(text: string, locator: Record<string, unknown>): ExtractedArtifact['chunks'] {
  if (!text) return []
  const chunks: ExtractedArtifact['chunks'] = []
  let remaining = text
  let offset = 0
  while (remaining.length) {
    let end = Math.min(MAX_CHUNK_CHARS, remaining.length)
    if (end < remaining.length) {
      const boundary = Math.max(remaining.lastIndexOf('\n\n', end), remaining.lastIndexOf('\n', end))
      if (boundary >= Math.floor(MAX_CHUNK_CHARS * 0.6)) end = boundary
    }
    const part = remaining.slice(0, end).trim()
    if (part) chunks.push({ ordinal: chunks.length, locator: { ...locator, charStart: offset, charEnd: offset + end }, text: part })
    remaining = remaining.slice(end)
    offset += end
  }
  return chunks
}

function failed(parser: string, warning: string, priorWarnings: string[] = []): ExtractedArtifact {
  return {
    text: '',
    status: 'failed',
    parser,
    parserVersion: ARTIFACT_PARSER_VERSION,
    warnings: [...priorWarnings, warning],
    metadata: {},
    chunks: [],
  }
}

function normalizeContentType(value?: string | null): string | null {
  return value?.split(';', 1)[0].trim().toLowerCase() || null
}

function typeFromExtension(filename: string): string | null {
  const ext = extension(filename)
  const types: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  return types[ext] ?? null
}

function extension(filename: string): string {
  return filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
}

function looksLikeText(buffer: Buffer): boolean {
  if (!buffer.length) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_096))
  let suspicious = 0
  for (let index = 0; index < sample.length; index++) {
    const byte = sample[index]
    if (byte === 0 || (byte < 9 || (byte > 13 && byte < 32))) suspicious++
  }
  return suspicious / sample.length < 0.02
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte)
}

function decodeEntity(entity: string): string {
  if (entity[0] === '#') {
    const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10
    const value = Number.parseInt(entity.slice(radix === 16 ? 2 : 1), radix)
    return Number.isFinite(value) ? String.fromCodePoint(value) : ''
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? ''
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => decodeEntity(entity))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function slideNumber(path: string): number {
  return Number.parseInt(/slide(\d+)\.xml$/.exec(path)?.[1] ?? '0', 10)
}

function sheetVisibility(workbook: XLSX.WorkBook, index: number): 'visible' | 'hidden' | 'very_hidden' {
  const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden
  return hidden === 2 ? 'very_hidden' : hidden === 1 ? 'hidden' : 'visible'
}

function columnName(index: number): string {
  return XLSX.utils.encode_col(index)
}

function renumber(chunks: ExtractedArtifact['chunks']): void {
  chunks.forEach((chunk, index) => { chunk.ordinal = index })
}
