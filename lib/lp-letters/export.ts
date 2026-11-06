import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ShadingType,
} from 'docx'
import type { CompanyNarrative } from '@/lib/types/database'
import { getCurrencySymbol } from '@/lib/currency'

interface PortfolioCompany {
  companyName: string
  status: string
  stage: string | null
  totalInvested: number
  fmv: number
  moic: number | null
}

interface ExportLetterData {
  period_label: string
  full_draft: string | null
  company_narratives: CompanyNarrative[]
  portfolio_companies?: PortfolioCompany[]
  fund_currency?: string
}

function fmt(value: number, currency: string): string {
  const sym = getCurrencySymbol(currency)
  if (Math.abs(value) >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${sym}${(value / 1_000).toFixed(0)}K`
  return `${sym}${value.toLocaleString()}`
}

const TABLE_BORDER = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: 'CCCCCC',
}

const BORDERS_ALL = {
  top: TABLE_BORDER,
  bottom: TABLE_BORDER,
  left: TABLE_BORDER,
  right: TABLE_BORDER,
}

function headerCell(text: string, widthPct: number, align?: (typeof AlignmentType)[keyof typeof AlignmentType]): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    borders: BORDERS_ALL,
    shading: { type: ShadingType.SOLID, color: 'F3F4F6', fill: 'F3F4F6' },
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text, bold: true, size: 18, font: 'Calibri' })],
      }),
    ],
  })
}

function dataCell(text: string, widthPct: number, options?: { bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType] }): TableCell {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    borders: BORDERS_ALL,
    children: [
      new Paragraph({
        alignment: options?.align,
        children: [new TextRun({ text, bold: options?.bold, size: 18, font: 'Calibri' })],
      }),
    ],
  })
}

function buildPortfolioTable(companies: PortfolioCompany[], currency: string): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      headerCell('Company', 30),
      headerCell('Status', 14),
      headerCell('Stage', 14),
      headerCell('Invested', 14, AlignmentType.RIGHT),
      headerCell('Gross FMV', 14, AlignmentType.RIGHT),
      headerCell('Gross MOIC', 14, AlignmentType.RIGHT),
    ],
  })

  const dataRows = companies.map(
    c =>
      new TableRow({
        children: [
          dataCell(c.companyName, 30),
          dataCell(c.status, 14),
          dataCell(c.stage ?? '—', 14),
          dataCell(fmt(c.totalInvested, currency), 14, { align: AlignmentType.RIGHT }),
          dataCell(fmt(c.fmv, currency), 14, { align: AlignmentType.RIGHT }),
          dataCell(c.moic ? `${c.moic.toFixed(2)}x` : '—', 14, { align: AlignmentType.RIGHT }),
        ],
      })
  )

  // Compute totals from stored company data
  const totalInvested = companies.reduce((s, c) => s + c.totalInvested, 0)
  const totalFmv = companies.reduce((s, c) => s + c.fmv, 0)
  const portfolioMoic = totalInvested > 0 ? totalFmv / totalInvested : null

  const rows = [headerRow, ...dataRows]
  rows.push(
    new TableRow({
      children: [
        dataCell('Total', 30, { bold: true }),
        dataCell('', 14),
        dataCell('', 14),
        dataCell(fmt(totalInvested, currency), 14, { bold: true, align: AlignmentType.RIGHT }),
        dataCell(fmt(totalFmv, currency), 14, { bold: true, align: AlignmentType.RIGHT }),
        dataCell(portfolioMoic ? `${portfolioMoic.toFixed(2)}x` : '—', 14, { bold: true, align: AlignmentType.RIGHT }),
      ],
    })
  )

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  })
}

function textParagraphs(text: string): Paragraph[] {
  return text.split('\n\n').map(
    block =>
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({ text: block.trim(), size: 22, font: 'Calibri' })],
      })
  )
}

/**
 * Build a DOCX buffer from letter data.
 */
export async function buildDocxBuffer(
  letter: ExportLetterData,
  fundName: string
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = []
  const currency = letter.fund_currency ?? 'USD'

  // Title
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 100 },
      children: [new TextRun({ text: fundName, size: 32, font: 'Calibri', bold: true })],
    })
  )

  // Subtitle — period
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 100 },
      children: [new TextRun({ text: `Quarterly Report — ${letter.period_label}`, size: 26, font: 'Calibri' })],
    })
  )

  // Date
  children.push(
    new Paragraph({
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          size: 20,
          font: 'Calibri',
          color: '666666',
        }),
      ],
    })
  )

  // Greeting
  children.push(
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: 'Dear Limited Partners,', size: 22, font: 'Calibri' })],
    })
  )

  // Portfolio table section
  if (letter.portfolio_companies && letter.portfolio_companies.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 },
        children: [new TextRun({ text: 'Portfolio Summary', size: 26, font: 'Calibri', bold: true })],
      })
    )
    children.push(buildPortfolioTable(letter.portfolio_companies, currency))
    children.push(new Paragraph({ spacing: { after: 200 }, children: [] }))
  }

  // Company narratives
  if (letter.company_narratives && letter.company_narratives.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 },
        children: [new TextRun({ text: 'Portfolio Company Updates', size: 26, font: 'Calibri', bold: true })],
      })
    )

    for (const n of letter.company_narratives) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 300, after: 100 },
          children: [new TextRun({ text: n.company_name, size: 24, font: 'Calibri', bold: true })],
        })
      )
      children.push(...textParagraphs(n.narrative))
    }
  }

  // Closing
  children.push(
    new Paragraph({
      spacing: { before: 400, after: 200 },
      children: [new TextRun({ text: 'Sincerely,', size: 22, font: 'Calibri' })],
    })
  )
  children.push(
    new Paragraph({
      children: [new TextRun({ text: fundName, size: 22, font: 'Calibri', bold: true })],
    })
  )

  const doc = new Document({
    title: `${fundName} — ${letter.period_label}`,
    creator: fundName,
    sections: [{ children }],
  })

  return Packer.toBuffer(doc)
}

/**
 * A letter's Word file uploaded to the fund's Drive as a Google Doc (Drive converts it), in an
 * "LP Letters" folder. The Word file is the one the export gives (export-letter.ts).
 */
export async function uploadLetterToGoogleDocs(
  buffer: Buffer,
  title: string,
  accessToken: string,
  driveFolderId: string
): Promise<string> {
  const { findOrCreateFolder, uploadFile } = await import('@/lib/google/drive')
  const lpFolderId = await findOrCreateFolder(accessToken, driveFolderId, 'LP Letters')
  const fileId = await uploadFile(
    accessToken,
    lpFolderId,
    `${title}.docx`,
    buffer,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { convert: true }
  )
  return `https://docs.google.com/document/d/${fileId}/edit`
}
