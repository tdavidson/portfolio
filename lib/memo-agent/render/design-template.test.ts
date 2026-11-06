import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  AlignmentType, Document, Footer, Header, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun,
} from 'docx'
import { analyzeMemoDesign, fieldForLabel, renderWithDesign, sectionsFromHeadings, textOf, topLevelElements } from './design-template'

// An invented sample memo: a firm's letterhead header and footer, a first page with a title, fixed
// text, a labelled line and a fields table, then sections with body text and a bulleted list.
async function sampleMemo(opts: { styledHeadings?: boolean } = {}): Promise<Buffer> {
  const styled = opts.styledHeadings ?? true
  const heading = (t: string) => styled
    ? new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] })
    : new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 28, font: 'Georgia', color: '1F3864' })] })
  const body = (t: string) => new Paragraph({ children: [new TextRun({ text: t, font: 'Georgia', size: 21 })], spacing: { after: 160 } })
  const bullet = (t: string) => new Paragraph({ numbering: { reference: 'dots', level: 0 }, children: [new TextRun({ text: t, font: 'Georgia', size: 21 })] })
  const cell = (t: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold })] })] })
  const doc = new Document({
    numbering: { config: [{ reference: 'dots', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT }] }] },
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun('Example Partners · Acme Robotics')] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('Confidential')] })] }) },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Acme Robotics')] }),
        new Paragraph({ children: [new TextRun({ text: 'Investment Committee Memorandum', italics: true })] }),
        new Paragraph({ children: [new TextRun({ text: 'Prepared by: ', bold: true }), new TextRun('Jane Doe')] }),
        new Paragraph({ children: [new TextRun('March 3, 2025')] }),
        new Paragraph({ children: [new TextRun('Acme Robotics makes warehouse arms and raised 1,000,000 last year from a group of angels, growing revenue quickly.')] }),
        new Table({
          rows: [
            new TableRow({ children: [cell('Round size', true), cell('5,000,000'), cell('Stage', true), cell('Seed')] }),
            new TableRow({ children: [cell('Sector', true), cell('Robotics'), cell('Valuation', true), cell('20,000,000 post')] }),
          ],
        }),
        heading('Summary'),
        body('Acme Robotics builds arms for warehouses. This paragraph is long enough to count as the body text of the memo, which is what we copy.'),
        body('A second body paragraph in the same style, so the body style is the most common one among the long paragraphs in this sample.'),
        heading('Team'),
        bullet('First founder, previously an engineer.'),
        bullet('Second founder, previously in sales.'),
        heading('Key Risks'),
        body('The risks paragraph is also long enough to be body text, and it is formatted the same way as the other body paragraphs.'),
        heading('Market & Why Now'),
        body('Market text that is long enough to be counted as a body paragraph for the purpose of finding the body prototype.'),
      ],
    }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

async function documentXml(buf: Buffer): Promise<string> {
  return (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')
}

describe('fieldForLabel', () => {
  it('maps the labels memos use to header fields', () => {
    expect(fieldForLabel('Round size')).toBe('round_size')
    expect(fieldForLabel('Prepared by:')).toBe('deal_lead')
    expect(fieldForLabel('Post-money')).toBe('valuation')
    expect(fieldForLabel('Date')).toBe('memo_date')
    expect(fieldForLabel('The company builds arms')).toBeNull()
  })
})

describe('topLevelElements', () => {
  it('splits a body into its top-level paragraphs and tables, keeping nested paragraphs inside', () => {
    const els = topLevelElements('<w:p><w:r><w:t>a</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/>')
    expect(els.map(e => e.name)).toEqual(['w:p', 'w:tbl', 'w:p'])
    expect(textOf(els[0].xml)).toBe('a')
  })
})

describe('analyzeMemoDesign', () => {
  it('reads the section headings, title and first-page fields', async () => {
    const d = await analyzeMemoDesign(await sampleMemo())
    expect(d.headings).toEqual(['Summary', 'Team', 'Key Risks', 'Market & Why Now'])
    expect(d.title).toBe('Acme Robotics')
    expect(d.fields.map(f => f.field)).toEqual(['deal_lead', 'round_size', 'stage', 'sector', 'valuation'])
    expect(d.warnings).toEqual([])
  })

  it('finds headings made by hand (bold, larger) when the sample uses no heading styles', async () => {
    const d = await analyzeMemoDesign(await sampleMemo({ styledHeadings: false }))
    expect(d.headings).toEqual(['Summary', 'Team', 'Key Risks', 'Market & Why Now'])
  })

  it('refuses a file that is not a .docx', async () => {
    await expect(analyzeMemoDesign(Buffer.from('%PDF-1.4'))).rejects.toThrow(/not a Word/)
  })
})

describe('renderWithDesign', () => {
  const memo = {
    header: { company_name: 'Northwind Labs', round_size: '2,000,000', stage: 'Series A', sector: 'Logistics', memo_date: '2026-01-15', deal_lead: 'John Roe', valuation: null },
    sections: [
      { title: 'Summary', paragraphs: ['Northwind Labs routes freight.'] },
      { title: 'Team', paragraphs: ['- A founder who ran operations.\n- A founder who built the software.'] },
    ],
  }

  it("fills the sample's first page with this memo's facts and drops the sample's own", async () => {
    const out = await renderWithDesign(await sampleMemo(), memo)
    const xml = await documentXml(out)
    const text = textOf(xml)
    expect(text).toContain('Northwind Labs')
    expect(text).toContain('Investment Committee Memorandum')
    expect(text).toContain('Prepared by: John Roe')
    expect(text).toContain('2026-01-15')
    for (const v of ['2,000,000', 'Series A', 'Logistics']) expect(text).toContain(v)
    // Nothing of the sample's company survives: name, figures, prose, sections.
    for (const gone of ['Acme', '5,000,000', '20,000,000', 'Robotics', 'Jane Doe', 'warehouse', 'Key Risks', 'March 3, 2025']) {
      expect(text).not.toContain(gone)
    }
  })

  it("writes each section with the sample's heading, body and bullet formatting", async () => {
    const sample = await sampleMemo()
    const xml = await documentXml(await renderWithDesign(sample, memo))
    const paras = topLevelElements(/<w:body>([\s\S]*)<\/w:body>/.exec(xml)![1]).filter(e => e.name === 'w:p')
    const byText = (t: string) => paras.find(p => textOf(p.xml) === t)!.xml
    expect(byText('Summary')).toMatch(/<w:pStyle w:val="Heading1"\/>/)
    expect(byText('Northwind Labs routes freight.')).toMatch(/w:ascii="Georgia"/)
    expect(byText('A founder who ran operations.')).toMatch(/<w:numPr>/)
    // The page setup (sectPr) and the header and footer parts are the sample's.
    expect(xml).toMatch(/<w:sectPr[\s\S]*<\/w:sectPr><\/w:body>/)
    const zip = await JSZip.loadAsync(await renderWithDesign(sample, memo))
    const headers = await Promise.all(Object.keys(zip.files).filter(n => /^word\/header\d*\.xml$/.test(n)).map(n => zip.file(n)!.async('string')))
    expect(headers.join('')).toContain('Example Partners · Northwind Labs')
    const footers = await Promise.all(Object.keys(zip.files).filter(n => /^word\/footer\d*\.xml$/.test(n)).map(n => zip.file(n)!.async('string')))
    expect(footers.join('')).toContain('Confidential')
  })

  it('escapes text', async () => {
    const xml = await documentXml(await renderWithDesign(await sampleMemo(), { header: { company_name: 'A & B <Co>' }, sections: [] }))
    expect(xml).toContain('A &amp; B &lt;Co&gt;')
  })
})

describe('sectionsFromHeadings', () => {
  const schema = [
    { id: 'executive_summary', title: 'Executive Summary' }, { id: 'team', title: 'Team' },
    { id: 'market', title: 'Market' }, { id: 'risks_and_open_questions', title: 'Risks and Open Questions' },
  ]
  it("matches the sample's headings to schema sections, keeping the sample's titles and order", () => {
    const out = sectionsFromHeadings(['1. Summary', 'Team', 'Key Risks', 'Market & Why Now', 'Portfolio Fit'], schema)
    expect(out.map(s => [s.id, s.title])).toEqual([
      ['executive_summary', '1. Summary'], ['team', 'Team'], ['risks_and_open_questions', 'Key Risks'],
      ['market', 'Market & Why Now'], ['custom_portfolio_fit', 'Portfolio Fit'],
    ])
    expect(out[4].custom).toBe(true)
  })
})
