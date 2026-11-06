import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { blocksOf, documentJson, documentMarkdown, imageSize, letterDocument, sniffImage, type LetterChart } from './document'
import { buildLetterDocx } from './docx-letter'
import { buildDocumentLetterHtml } from '@/lib/lp-report-pdf'

// A 2x3 PNG: signature, IHDR with width 2 and height 3.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
])

const chart = (over: Partial<LetterChart> = {}): LetterChart => ({
  id: 'chart-1', section_id: 'company:c1', caption: 'Revenue by quarter', path: 'fund-1/l1/abc.png', content_type: 'image/png',
  sha256: 'a'.repeat(64), width: 2, height: 3, uploaded_at: '2026-11-01T00:00:00Z', uploaded_by: 'u1', ...over,
})

const letter = {
  period_label: 'Q3 2026',
  portfolio_group: 'Example Fund I',
  status: 'draft',
  content: {
    version: 1,
    sections: [
      { id: 'opening', kind: 'text', heading: null, body: 'Dear partners,\n\nThe fund ended the quarter steady.' },
      { id: 'fund-performance', kind: 'fund', heading: 'Fund performance', body: 'Metric | Value\n--- | ---\nTVPI, net | 1.20x\nDPI, net | 0.10x' },
      { id: 'company:c1', kind: 'company', heading: 'Acme', company_id: 'c1', body: 'Acme closed its Series A.\n\n- Revenue of $100K in Q3\n- Two new hires' },
      { id: 'missing-information', kind: 'text', heading: 'Missing information', body: '- Q3 marks for Birch' },
    ],
  },
  charts: [chart(), chart({ id: 'chart-2', section_id: 'gone', caption: null })],
}

describe('blocksOf', () => {
  it('reads paragraphs, bullets and tables, and keeps a stray pipe in a sentence', () => {
    expect(blocksOf('One.\n\n- a\n- b\n\nA | B\n1 | 2\n\nEither this | or that.')).toEqual([
      { type: 'paragraph', text: 'One.' },
      { type: 'bullets', items: ['a', 'b'] },
      { type: 'table', header: ['A', 'B'], rows: [['1', '2']] },
      { type: 'paragraph', text: 'Either this | or that.' },
    ])
  })
  it('drops a markdown rule row and pads short rows', () => {
    expect(blocksOf('| A | B | C |\n|---|---|---|\n| 1 | 2 |')).toEqual([{ type: 'table', header: ['A', 'B', 'C'], rows: [['1', '2', '']] }])
  })
})

describe('letterDocument', () => {
  const doc = letterDocument(letter)
  it('leaves out the Missing information section', () => {
    expect(doc.sections.map(s => s.heading)).toEqual([null, 'Fund performance', 'Acme'])
    expect(JSON.stringify(doc)).not.toContain('Birch')
  })
  it('places a chart after its section, and one whose section is gone at the end', () => {
    const acme = doc.sections[2]
    expect(acme.blocks.filter(b => b.type === 'chart').map(b => (b as any).chart.id)).toEqual(['chart-1', 'chart-2'])
  })
  it('exports Markdown with headings, bullets and a pipe table', () => {
    const md = documentMarkdown(doc)
    expect(md).toContain('# Q3 2026')
    expect(md).toContain('## Acme')
    expect(md).toContain('- Revenue of $100K in Q3')
    expect(md).toContain('| Metric | Value |\n| --- | --- |\n| TVPI, net | 1.20x |')
    expect(md).toContain('![Revenue by quarter](chart-aaaaaaaaaaaa.png)')
    expect(md).not.toContain('Missing information')
  })
  it('exports JSON without storage paths', () => {
    const json = JSON.stringify(documentJson(doc))
    expect(json).toContain('"file":"chart-aaaaaaaaaaaa.png"')
    expect(json).not.toContain('fund-1/l1')
  })
})

describe('images', () => {
  it('reads a PNG size and type from its bytes', () => {
    expect(imageSize(PNG)).toEqual({ width: 2, height: 3 })
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(new TextEncoder().encode('<svg></svg>'))).toBeNull()
  })
})

describe('the Word file', () => {
  it('uses real styles, embeds the charts and numbers the pages', async () => {
    const buf = await buildLetterDocx(letterDocument(letter), {
      fundName: 'Example Fund I', logo: null, address: '1 Example Street', chartBytes: new Map([['chart-1', PNG]]),
    })
    const zip = await JSZip.loadAsync(buf)
    const body = await zip.file('word/document.xml')!.async('string')
    expect(body).toContain('w:val="Title"')
    expect(body).toContain('w:val="Heading1"')
    expect(body).toContain('w:val="Heading2"')
    expect(body).toContain('w:val="ListBullet"')
    expect(body).toContain('w:val="Caption"')
    expect(body).toContain('<w:tbl>')
    expect(body).toContain('Revenue by quarter')
    expect(body).not.toContain('Birch')
    const media = Object.keys(zip.files).filter(f => f.startsWith('word/media/') && !zip.files[f].dir)
    expect(media).toHaveLength(1) // chart-2 has no bytes, so it is left out
    const footers = Object.keys(zip.files).filter(f => /^word\/footer\d*\.xml$/.test(f))
    const footer = await zip.file(footers[0])!.async('string')
    expect(footer).toContain('PAGE')
  })
})

describe('the PDF layout', () => {
  it('escapes the text and only takes charts as image data', () => {
    const doc = letterDocument({ ...letter, content: { version: 1, sections: [{ id: 'opening', kind: 'text', heading: '<b>Hi</b>', body: 'A & B <script>' }] }, charts: [chart({ section_id: 'opening' })] })
    const html = buildDocumentLetterHtml({
      doc, fundName: 'Example Fund I', fundLogo: null, fundAddress: null,
      charts: new Map([['chart-1', 'https://evil.example/x.png']]),
    })
    expect(html).toContain('&lt;b&gt;Hi&lt;/b&gt;')
    expect(html).toContain('A &amp; B &lt;script&gt;')
    expect(html).not.toContain('evil.example')
    const ok = buildDocumentLetterHtml({ doc, fundName: 'F', fundLogo: null, fundAddress: null, charts: new Map([['chart-1', 'data:image/png;base64,AAAA']]) })
    expect(ok).toContain('<img src="data:image/png;base64,AAAA"')
    expect(ok).toContain('<figcaption>Revenue by quarter</figcaption>')
  })
})
