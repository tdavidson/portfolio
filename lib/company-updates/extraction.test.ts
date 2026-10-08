import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Document, Packer, Paragraph } from 'docx'
import * as XLSX from 'xlsx'
import { detectContentType, extractArtifact, extractEmailBody, withoutForwardHeaders } from './extraction'

describe('Company Update body extraction', () => {
  it('prefers plain text, preserves the original, and separates conservative reply cleaning', () => {
    const body = extractEmailBody({
      TextBody: 'Current update\r\n\r\nRevenue grew.\r\n\r\nOn Tue, Sep 1, 2026 Alice wrote:\r\nOld update',
      HtmlBody: '<p>This should not replace supplied plain text.</p>',
    })

    expect(body.original).toContain('Old update')
    expect(body.current).toBe('Current update\n\nRevenue grew.')
    expect(body.cleaningStatus).toBe('complete')
  })

  it('retains HTML paragraph/list boundaries and forwarded attribution', () => {
    const body = extractEmailBody({
      HtmlBody: '<p>FYI</p><p>--- Forwarded message ---</p><p>From: Ada Founder &lt;ada@acme.test&gt;</p><ul><li>Cash is stable</li><li>Retention rose</li></ul>',
    })

    expect(body.original).toContain('FYI\n\n--- Forwarded message ---')
    expect(body.original).toContain('- Cash is stable\n- Retention rose')
    expect(body.forwardedSender).toEqual({ name: 'Ada Founder', email: 'ada@acme.test' })
    expect(body.warnings[0]).toContain('derived from HTML')
  })
})

describe('Company Update artifact extraction contract', () => {
  it('does not silently truncate long text and emits bounded chunks', async () => {
    const text = Array.from({ length: 7_000 }, (_, index) => `Line ${index}: retained evidence`).join('\n')
    const extracted = await extractArtifact({
      filename: 'update',
      declaredContentType: 'application/octet-stream',
      content: Buffer.from(text).toString('base64'),
    })

    expect(extracted.detectedContentType).toBe('text/plain')
    expect(extracted.result.status).toBe('complete')
    expect(extracted.result.text).toContain('Line 6999: retained evidence')
    expect(extracted.result.text.length).toBeGreaterThan(50_000)
    expect(extracted.result.chunks.every(chunk => chunk.text.length <= 12_000)).toBe(true)
  })

  it('detects OOXML from archive entries and preserves DOCX paragraphs', async () => {
    const document = new Document({
      sections: [{ children: [new Paragraph('First paragraph'), new Paragraph('Second paragraph')] }],
    })
    const buffer = await Packer.toBuffer(document)

    expect(await detectContentType(buffer, 'attachment.bin', 'application/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const extracted = await extractArtifact({
      filename: 'attachment.bin',
      declaredContentType: 'application/octet-stream',
      content: buffer.toString('base64'),
    })
    expect(extracted.result.status).toBe('complete')
    expect(extracted.result.text).toContain('First paragraph')
    expect(extracted.result.text).toContain('Second paragraph')
  })

  it('preserves spreadsheet values, formulas, hidden sheets, and row/range locators', async () => {
    const workbook = XLSX.utils.book_new()
    const operating = XLSX.utils.aoa_to_sheet([
      ['Month', 'ARR', 'Retention'],
      ['Aug 2026', 1_200_000, 0.94],
      ['Sep 2026', 1_350_000, 0.96],
    ])
    operating.C4 = { t: 'n', v: 2_550_000, f: 'SUM(B2:B3)', w: '2550000' }
    operating['!ref'] = 'A1:C4'
    XLSX.utils.book_append_sheet(workbook, operating, 'Operating')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Board note'], ['Do not omit me']]), 'Notes')
    workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const extracted = await extractArtifact({
      filename: 'report.dat',
      declaredContentType: 'application/octet-stream',
      content: buffer.toString('base64'),
    })

    expect(extracted.detectedContentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(extracted.result.status).toBe('complete')
    expect(extracted.result.text).toContain('[Sheet: Operating | Visibility: visible]')
    expect(extracted.result.text).toContain('[formula: =SUM(B2:B3)]')
    expect(extracted.result.text).toContain('[Sheet: Notes | Visibility: hidden]')
    expect(extracted.result.text).toContain('Do not omit me')
    expect(extracted.result.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ locator: expect.objectContaining({ sheet: 'Operating', rowStart: 1, columnStart: 'A' }) }),
      expect.objectContaining({ locator: expect.objectContaining({ sheet: 'Notes', visibility: 'hidden' }) }),
    ]))
  })

  it('preserves slide boundaries and decodes slide text', async () => {
    const zip = new JSZip()
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"/>')
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Customer &amp; product</a:t></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Retention rose</a:t></p:sld>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const extracted = await extractArtifact({
      filename: 'deck',
      declaredContentType: 'application/octet-stream',
      content: buffer.toString('base64'),
    })
    expect(extracted.result.text).toContain('[Slide 1]\nCustomer & product')
    expect(extracted.result.text).toContain('[Slide 2]\nRetention rose')
    expect(extracted.result.chunks.map(chunk => chunk.locator.slide)).toEqual([1, 2])
  })

  it('extracts selectable PDF text with page locators', async () => {
    const buffer = minimalPdf('Customer retention rose to 96 percent')
    const extracted = await extractArtifact({
      filename: 'update.pdf',
      declaredContentType: 'application/pdf',
      content: buffer.toString('base64'),
    })

    expect(extracted.result.status).toBe('complete')
    expect(extracted.result.text).toContain('Customer retention rose to 96 percent')
    expect(extracted.result.chunks[0].locator).toMatchObject({ page: 1 })
    expect(extracted.result.metadata).toMatchObject({ pageCount: 1, pagesWithText: 1 })
  })

  it('makes unsupported OCR work visible instead of treating an image as empty success', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const extracted = await extractArtifact({
      filename: 'dashboard.png',
      declaredContentType: 'image/png',
      content: pngHeader.toString('base64'),
    })

    expect(extracted.result.status).toBe('not_applicable')
    expect(extracted.result.warnings[0]).toContain('requires OCR')
    expect(extracted.result.metadata).toMatchObject({ ocrNeeded: true, ocrUsed: false })
  })

  it('returns a failed result when bytes are unavailable', async () => {
    const extracted = await extractArtifact({ filename: 'missing.pdf', declaredContentType: 'application/pdf' })
    expect(extracted.result.status).toBe('failed')
    expect(extracted.result.warnings).toEqual(['Attachment bytes were unavailable.'])
  })
})

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

describe('the current message of a forwarded update', () => {
  const forward = [
    '---------- Forwarded message ---------',
    'From: Lizzie Matusov <lizzie@getquotient.com>',
    'Date: Tue, Oct 6, 2026 at 2:09 PM',
    'Subject: 09/2026 Quotient Stakeholder Update',
    'To: Joe Mukai <joe@getquotient.com>,',
    '  Ada Founder <ada@acme.test>',
    '',
    'To our stakeholders,',
    '',
    'Happy October! This month we started procurement with two enterprises. More below.',
    '',
    '--',
    '',
    '*Our latest blurb:* Quotient helps engineering organizations prove ROI.',
    '',
    '*Key metrics:*',
    ...Array.from({ length: 20 }, (_, i) => `- Metric ${i}: steady growth this month across the board`),
  ].join('\n')

  it('starts at the forwarded text, not the header block', () => {
    const body = extractEmailBody({ TextBody: forward })
    expect(body.current.startsWith('To our stakeholders,')).toBe(true)
    expect(body.current).not.toMatch(/Forwarded message|^From:|^Subject:|ada@acme\.test/m)
    expect(body.original).toContain('From: Lizzie Matusov')
  })

  it('keeps a newsletter section divider "--" in the message instead of filing the rest as quoted history', () => {
    const body = extractEmailBody({ TextBody: forward })
    expect(body.current).toContain('Our latest blurb')
    expect(body.current).toContain('Metric 19')
    expect(body.originalChunks).toEqual([])
  })

  it('still cuts a real signature', () => {
    const body = extractEmailBody({ TextBody: 'Revenue grew 20% this quarter and we hired two engineers.\n\n--\nAda Founder\nCEO, Acme\n+1 555 0100' })
    expect(body.current).toBe('Revenue grew 20% this quarter and we hired two engineers.')
  })

  it('keeps a note the forwarder wrote above the forward', () => {
    expect(withoutForwardHeaders('FYI — strong quarter.\n\n--- Forwarded message ---\nFrom: Ada <ada@acme.test>\nSubject: Q3\n\nRevenue grew.'))
      .toBe('FYI — strong quarter.\n\nRevenue grew.')
  })
})
