import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, BorderStyle, WidthType, TableLayoutType, VerticalAlign } from 'docx'
import yaml from 'js-yaml'
import type { MemoDraftOutput } from '@/lib/memo-agent/stages/draft'
import type { DimensionScore } from '@/lib/memo-agent/stages/score'
import type { DesignMemoInput } from './design-template'
import { SCORE_TABLE_HEADERS, confidenceLabel, dimensionLabel, scoreLabel } from './scores-table'

interface RenderInput {
  memo: MemoDraftOutput & { scores?: DimensionScore[] }
  memoOutputYaml: string
  isDraft: boolean
  dealName: string
  draftVersion: string
  /** Base font family for the export. Defaults to DM Sans. */
  fontFamily?: string
  /** Base font size in points. Defaults to 11. */
  fontSize?: number
  /** Partner-defined section order/titles (incl. custom sections). Overrides the schema order when set. */
  sectionConfig?: Array<{ id: string; title: string; included?: boolean }>
}

const DEFAULT_FONT_FAMILY = 'DM Sans'
const DEFAULT_FONT_SIZE = 11

const FALLBACK_ORDER = [
  'header', 'executive_summary', 'recommendation', 'company_overview', 'product', 'market',
  'traction', 'business_model', 'team', 'competition_moat', 'outcomes_analysis', 'deal_terms',
  'risks_and_open_questions', 'scoring_summary', 'appendix',
  // Backward-compat for drafts produced under v0.1 of memo_output.yaml.
  'product_technology',
]

/**
 * The memo's sections in the order and with the titles the export uses: the partner's section config
 * when set (authoritative, incl. custom and renamed sections), else the schema order, then any section
 * that still has paragraphs. Shared by the generic render and the fund design-template render.
 */
export function memoSectionOrder(input: Pick<RenderInput, 'memo' | 'memoOutputYaml' | 'sectionConfig'>): {
  order: string[]
  sectionMeta: Map<string, SectionMeta>
  paragraphsBySection: Map<string, MemoDraftOutput['paragraphs']>
} {
  const sections = parseSections(input.memoOutputYaml)
  const sectionMeta = new Map(sections.map(s => [s.id, s]))

  // Section order + titles: partner section config when present (authoritative,
  // incl. custom + renamed sections), else the schema order. The structured tail
  // (scoring_summary, appendix) is always appended.
  let baseOrder: string[]
  if (input.sectionConfig && input.sectionConfig.length > 0) {
    const included = input.sectionConfig.filter(s => s.included !== false)
    baseOrder = included.map(s => s.id)
    for (const s of included) {
      const meta = sectionMeta.get(s.id)
      sectionMeta.set(s.id, { id: s.id, title: s.title || meta?.title || humanizeSectionId(s.id), kind: meta?.kind ?? 'prose' })
    }
    for (const tail of ['scoring_summary', 'appendix']) {
      if (!baseOrder.includes(tail) && sectionMeta.has(tail)) baseOrder.push(tail)
    }
  } else {
    baseOrder = sections.length ? sections.map(s => s.id) : FALLBACK_ORDER
  }

  // Append any section_ids on paragraphs not in baseOrder so no content is hidden
  // (e.g. a section removed from the config that still has paragraphs).
  const paragraphSectionIds = Array.from(new Set(input.memo.paragraphs.map(p => p.section_id)))
  const extras = paragraphSectionIds.filter(id => !baseOrder.includes(id))
  const order = [...baseOrder, ...extras]
  // Fill in fallback meta for any section id in the order that wasn't defined
  // above — keeps the doc non-empty when the schema is empty or stale.
  for (const id of order) {
    if (!sectionMeta.has(id)) {
      sectionMeta.set(id, { id, title: humanizeSectionId(id), kind: id === 'scoring_summary' || id === 'appendix' ? 'structured' : 'prose' })
    }
  }

  const paragraphsBySection = new Map<string, MemoDraftOutput['paragraphs']>()
  for (const p of input.memo.paragraphs) {
    if (!paragraphsBySection.has(p.section_id)) paragraphsBySection.set(p.section_id, [])
    paragraphsBySection.get(p.section_id)!.push(p)
  }

  return { order, sectionMeta, paragraphsBySection }
}

/**
 * Word doc render. Reuses the docx library already in package.json (used by
 * lib/lp-letters/export.ts). Returns a Buffer suitable for upload to storage
 * or direct download.
 */
/**
 * The memo as the fund's design template takes it: the header fields, and each section's title and
 * visible paragraphs in order. Only the memo's own content goes in. The app's working marks (the draft
 * banner, version and agent lines, the projection and unverified tags, the scores table and the
 * citation appendix) stay out, because the fund's memos have none of them.
 */
export function designMemoInput(input: Pick<RenderInput, 'memo' | 'memoOutputYaml' | 'sectionConfig' | 'dealName'>): DesignMemoInput {
  const { order, sectionMeta, paragraphsBySection } = memoSectionOrder(input)
  const h = (input.memo.header ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const header: DesignMemoInput['header'] = {
    company_name: str(h.company_name) ?? input.dealName,
    sector: str(h.sector), stage: str(h.stage), round_size: str(h.round_size), valuation: str(h.valuation),
    deal_lead: str(h.deal_lead), memo_date: str(h.memo_date), location: str(h.location), website: str(h.website),
  }
  const sections: DesignMemoInput['sections'] = []
  for (const id of order) {
    if (id === 'header' || id === 'appendix' || id === 'scoring_summary') continue
    const meta = sectionMeta.get(id)
    if (!meta || meta.kind === 'structured' || meta.kind === 'metadata') continue
    const paragraphs = (paragraphsBySection.get(id) ?? []).filter(p => !p.hidden)
      .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(p => p.prose.trim()).filter(Boolean)
    if (paragraphs.length === 0) continue
    sections.push({ title: meta.title, paragraphs })
  }
  return { header, sections }
}

export async function renderDocx(input: RenderInput): Promise<Buffer> {
  const { order, sectionMeta, paragraphsBySection } = memoSectionOrder(input)

  const fontFamily = input.fontFamily?.trim() || DEFAULT_FONT_FAMILY
  const fontSizePt = input.fontSize && input.fontSize > 0 ? input.fontSize : DEFAULT_FONT_SIZE

  const children: (Paragraph | Table)[] = []

  if (input.isDraft) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'DRAFT — not finalized', bold: true, color: 'B8860B', size: 28 })],
    }))
    children.push(new Paragraph({ text: '' }))
  }

  // Header
  const header = input.memo.header ?? {}
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: header.company_name ?? input.dealName, bold: true })],
  }))
  const subBits = [header.sector, header.stage, header.round_size].filter(Boolean) as string[]
  if (subBits.length) {
    children.push(new Paragraph({
      children: [new TextRun({ text: subBits.join(' · '), italics: true })],
    }))
  }
  children.push(new Paragraph({ text: '' }))
  children.push(new Paragraph({
    children: [new TextRun({ text: `Deal lead: ${header.deal_lead ?? '[Partner to complete]'}` })],
  }))
  if (header.memo_date) children.push(new Paragraph({ children: [new TextRun({ text: `Date: ${header.memo_date}` })] }))
  children.push(new Paragraph({
    children: [new TextRun({ text: `Version: ${input.draftVersion} · Agent: ${header.agent_version ?? 'memo-agent v0.1'}`, color: '888888', size: 18 })],
  }))
  children.push(new Paragraph({ text: '' }))

  for (const sectionId of order) {
    if (sectionId === 'header') continue
    // The appendix is the citation list — intentionally omitted from the
    // Word / Google Doc export per fund preference.
    if (sectionId === 'appendix') continue
    const meta = sectionMeta.get(sectionId)
    if (!meta) continue

    if (meta.kind === 'structured' && sectionId === 'scoring_summary') {
      children.push(headingPara(meta.title))
      children.push(buildScoresTable(input.memo.scores ?? [], fontSizePt))
      children.push(new Paragraph({ text: '' }))
      continue
    }

    // Partner-hidden paragraphs are excluded from the render.
    const paragraphs = (paragraphsBySection.get(sectionId) ?? []).filter(p => !p.hidden)
    if (paragraphs.length === 0) continue

    children.push(headingPara(meta.title))

    paragraphs
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach(p => {
        const runs: TextRun[] = []
        const isPlaceholder = p.origin === 'partner_only_placeholder'
        runs.push(new TextRun({ text: p.prose, italics: isPlaceholder }))

        const markers: string[] = []
        if (p.contains_projection) markers.push('projection')
        if (p.contains_unverified_claim) markers.push('unverified')
        if (p.contains_contradiction) markers.push('contradiction')
        if (markers.length > 0) {
          runs.push(new TextRun({ text: ` (${markers.join(' · ')})`, italics: true, color: 'B8860B', size: 18 }))
        }

        children.push(new Paragraph({ children: runs }))
        children.push(new Paragraph({ text: '' }))
      })
  }

  const doc = new Document({
    // Document-default run style. Body paragraphs inherit this; headings keep
    // their own sizes but inherit the font family. Size is in half-points.
    styles: {
      default: {
        document: {
          run: { font: fontFamily, size: fontSizePt * 2 },
        },
      },
    },
    sections: [{ children }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

function headingPara(title: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: title, bold: true })],
  })
}

// Column widths in twentieths of a point. The export uses the docx default page (A4, 1" margins), whose
// text block is 9026 wide; these sum to just under it so the table fits Letter paper too. Explicit grid
// widths and a fixed layout matter beyond Word: the PDF export and Google Doc are converted by Google
// Drive, which sizes columns from the grid and ignores per-cell percentages.
const SCORE_COLUMN_WIDTHS = [2050, 1000, 1450, 4500] as const
const SCORE_TABLE_WIDTH = SCORE_COLUMN_WIDTHS.reduce((a, b) => a + b, 0)
const CELL_MARGINS = { top: 60, bottom: 60, left: 100, right: 100 }

export function buildScoresTable(scores: DimensionScore[], bodySizePt: number = DEFAULT_FONT_SIZE): Table {
  // One point under the body text, as tables in a memo usually are.
  const size = Math.max(8, bodySizePt - 1) * 2
  const cell = (text: string, col: number, opts: { bold?: boolean; italics?: boolean; center?: boolean; shade?: boolean } = {}) =>
    new TableCell({
      width: { size: SCORE_COLUMN_WIDTHS[col], type: WidthType.DXA },
      margins: CELL_MARGINS,
      verticalAlign: VerticalAlign.TOP,
      shading: opts.shade ? { fill: 'F3F3F3' } : undefined,
      children: [new Paragraph({
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: text, bold: opts.bold, italics: opts.italics, size })],
      })],
    })

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: SCORE_TABLE_HEADERS.map((t, i) => cell(t, i, { bold: true, center: i === 1, shade: true })),
  })
  const rows = scores.length === 0
    ? [headerRow, new TableRow({ children: [new TableCell({
        columnSpan: SCORE_COLUMN_WIDTHS.length,
        width: { size: SCORE_TABLE_WIDTH, type: WidthType.DXA },
        margins: CELL_MARGINS,
        children: [new Paragraph({ children: [new TextRun({ text: 'No scores yet.', italics: true, size })] })],
      })] })]
    : [headerRow, ...scores.map(s => new TableRow({
        children: [
          cell(dimensionLabel(s.dimension_id), 0),
          cell(scoreLabel(s), 1, { center: true, bold: s.score !== null, italics: s.score === null }),
          cell(confidenceLabel(s.confidence), 2),
          cell((s.rationale ?? '').replace(/\s*\n\s*/g, ' ').trim(), 3),
        ],
      }))]
  return new Table({
    rows,
    width: { size: SCORE_TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: [...SCORE_COLUMN_WIDTHS],
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
    },
  })
}

function humanizeSectionId(id: string): string {
  return id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

interface SectionMeta { id: string; title: string; kind?: string }
function parseSections(yamlText: string): SectionMeta[] {
  try {
    const parsed = yaml.load(yamlText) as any
    const sections = parsed?.memo_structure?.sections
    if (!Array.isArray(sections)) return []
    return sections.map((s: any) => ({ id: s.id, title: s.title ?? s.id, kind: s.kind }))
  } catch {
    return []
  }
}
