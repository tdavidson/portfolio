// A letter's document (document.ts) as a Word file with real styles: Title, Heading 1 and 2, List
// Bullet, Caption and a table style, so the partners can restyle it in Word and Word's outline and
// navigation work. The logo and the charts are embedded, and each page has its number in the footer.

import {
  AlignmentType, BorderStyle, Document, Footer, ImageRun, LevelFormat, Packer, PageNumber, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, HeadingLevel,
} from 'docx'
import { imageSize, type LetterDocument } from './document'

export interface DocxLetterOptions {
  /** The letterhead name over the letter (the vehicle's, else the fund's). */
  fundName: string
  /** A base64 data URI (letterhead logo), or null. Only PNG and JPEG are embedded. */
  logo: string | null
  address: string | null
  /** Each chart's bytes, by chart id. A chart without bytes is left out. */
  chartBytes: Map<string, Uint8Array>
}

const FONT = 'Calibri'
const BODY = 22 // half-points: 11pt
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }
const CELL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER }
const MAX_WIDTH_PX = 600 // 6.25in at 96 dpi: the text width of a letter page with 1.1in margins

function dataUriBytes(uri: string | null): { bytes: Uint8Array; type: 'png' | 'jpg' } | null {
  const m = uri?.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (!m) return null
  return { bytes: new Uint8Array(Buffer.from(m[2], 'base64')), type: m[1].toLowerCase() === 'png' ? 'png' : 'jpg' }
}

function fit(size: { width: number; height: number } | null, maxW: number, maxH: number): { width: number; height: number } {
  if (!size || !size.width || !size.height) return { width: maxW, height: Math.round(maxW * 0.6) }
  const k = Math.min(1, maxW / size.width, maxH / size.height)
  return { width: Math.round(size.width * k), height: Math.round(size.height * k) }
}

/** Plain text runs, keeping single line breaks inside a paragraph. */
function runs(text: string, opts: { bold?: boolean } = {}): TextRun[] {
  return text.split('\n').map((line, i) => new TextRun({ text: line, bold: opts.bold, break: i > 0 ? 1 : undefined }))
}

const NUMERIC = /^[-–(]?[$€£¥]?\s?[\d.,]+\s?(%|x|[KMB])?\)?$|^[-–—]$/

function table(header: string[], rows: string[][]): Table {
  const width = Math.floor(100 / Math.max(1, header.length))
  const cell = (text: string, head: boolean) => new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    borders: CELL_BORDERS,
    ...(head ? { shading: { type: ShadingType.SOLID, color: 'F2F2F2', fill: 'F2F2F2' } } : {}),
    children: [new Paragraph({
      style: 'TableText',
      alignment: !head && NUMERIC.test(text.trim()) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: head })],
    })],
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map(h => cell(h, true)) }),
      ...rows.map(r => new TableRow({ children: r.map(c => cell(c, false)) })),
    ],
  })
}

export async function buildLetterDocx(doc: LetterDocument, opts: DocxLetterOptions): Promise<Buffer> {
  const children: (Paragraph | Table)[] = []

  const logo = dataUriBytes(opts.logo)
  if (logo) {
    const size = fit(imageSize(logo.bytes), 220, 48)
    children.push(new Paragraph({ spacing: { after: 120 }, children: [new ImageRun({ type: logo.type, data: logo.bytes, transformation: size, altText: { name: 'Logo', description: opts.fundName, title: opts.fundName } })] }))
  }
  if (opts.fundName) children.push(new Paragraph({ style: 'Letterhead', children: runs(opts.fundName) }))
  if (opts.address) children.push(new Paragraph({ style: 'LetterheadDetail', children: runs(opts.address) }))
  if (doc.title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(doc.title) }))

  for (const s of doc.sections) {
    if (s.heading) children.push(new Paragraph({ heading: s.kind === 'company' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1, children: runs(s.heading) }))
    for (const b of s.blocks) {
      if (b.type === 'paragraph') children.push(new Paragraph({ children: runs(b.text) }))
      else if (b.type === 'bullets') {
        for (const item of b.items) children.push(new Paragraph({ style: 'ListBullet', numbering: { reference: 'letter-bullets', level: 0 }, children: runs(item) }))
      } else if (b.type === 'table') {
        children.push(table(b.header, b.rows))
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
      } else {
        const bytes = opts.chartBytes.get(b.chart.id)
        // Word takes the PNG export-letter.ts makes of a drawn chart, never the SVG itself.
        if (!bytes || b.chart.content_type === 'image/svg+xml') continue
        const size = fit(b.chart.width && b.chart.height ? { width: b.chart.width, height: b.chart.height } : imageSize(bytes), MAX_WIDTH_PX, 700)
        const caption = b.chart.caption ?? ''
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, keepNext: !!caption,
          children: [new ImageRun({ type: b.chart.content_type === 'image/png' ? 'png' : 'jpg', data: bytes, transformation: size, altText: { name: 'Chart', description: caption || 'Chart', title: caption || 'Chart' } })],
        }))
        if (caption) children.push(new Paragraph({ style: 'Caption', alignment: AlignmentType.CENTER, children: runs(caption) }))
      }
    }
  }

  const document = new Document({
    title: [opts.fundName, doc.title].filter(Boolean).join(' — '),
    creator: opts.fundName || 'Hemrock',
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY }, paragraph: { spacing: { after: 160, line: 276 } } },
        title: { run: { font: FONT, size: 40, color: '111111' }, paragraph: { spacing: { before: 240, after: 240 } } },
        heading1: { run: { font: FONT, size: 30, bold: true, color: '111111' }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: '333333' }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
      },
      paragraphStyles: [
        { id: 'Letterhead', name: 'Letterhead', basedOn: 'Normal', run: { size: 26 }, paragraph: { spacing: { after: 40 } } },
        { id: 'LetterheadDetail', name: 'Letterhead Detail', basedOn: 'Normal', run: { size: 18, color: '767676' }, paragraph: { spacing: { after: 240 } } },
        { id: 'ListBullet', name: 'List Bullet', basedOn: 'Normal', quickFormat: true, paragraph: { spacing: { after: 80 } } },
        { id: 'Caption', name: 'caption', basedOn: 'Normal', quickFormat: true, run: { size: 18, italics: true, color: '595959' }, paragraph: { spacing: { before: 60, after: 240 } } },
        { id: 'TableText', name: 'Table Text', basedOn: 'Normal', run: { size: 18 }, paragraph: { spacing: { before: 20, after: 20 } } },
      ],
    },
    numbering: {
      config: [{
        reference: 'letter-bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1300, left: 1580, right: 1580 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '767676' })] })],
        }),
      },
      children,
    }],
  })
  return Packer.toBuffer(document)
}
