import { describe, expect, it } from 'vitest'
import { buildLetterDocx } from './docx-letter'
import { letterDocument } from './document'
import { compareWithLetter, docxToLetterText, htmlToLetterText } from './word-import'

const letter = {
  period_label: 'Q3 2026',
  content: {
    version: 1,
    sections: [
      { id: 'opening', kind: 'text', heading: null, body: 'Dear partners,\n\nThe fund ended the quarter steady.' },
      { id: 'fund-performance', kind: 'fund', heading: 'Fund performance', body: 'Metric | Value\nTVPI, net | 1.20x' },
      { id: 'company:c1', kind: 'company', heading: 'Acme', company_id: 'c1', body: 'Acme closed its Series A & hired.\n\n- Revenue of $100K in Q3\n- Two new hires' },
    ],
  },
  company_narratives: [{ company_id: 'c1', company_name: 'Acme', narrative: '' }],
}

describe('reading a Word file back', () => {
  it("reads the export's own Word file back to the same letter", async () => {
    const buf = await buildLetterDocx(letterDocument(letter), { fundName: 'Example Fund I', logo: null, address: '1 Example Street', chartBytes: new Map() })
    const text = await docxToLetterText(buf)
    expect(text).not.toContain('Example Fund I') // the letterhead
    expect(text).not.toContain('Q3 2026') // the title
    expect(text).toContain('## Acme')
    expect(text).toContain('- Revenue of $100K in Q3')
    expect(text).toContain('TVPI, net | 1.20x')
    const cmp = compareWithLetter(letter, text)
    expect(cmp.sections).toEqual([])
    expect(cmp.unchanged_sections).toBe(3)
    expect(cmp.diff.added + cmp.diff.removed).toBe(0)
  })

  it('names the sections an edit changes, adds and removes, and keeps Missing information apart', () => {
    const html = [
      '<h1 class="skip">Q3 2026</h1>',
      '<p>Dear partners,</p><p>The fund ended the quarter steady.</p>',
      '<h2>Acme</h2><p>Acme closed its Series A &amp; hired.</p><ul><li>Revenue of $110K in Q3</li><li>Two new hires</li></ul>',
      '<h1>Outlook</h1><p>More to come.</p>',
      '<h1>Missing information</h1><ul><li>Q3 marks</li></ul>',
      '<p class="skip">Figure 1</p>',
    ].join('')
    const cmp = compareWithLetter(letter, htmlToLetterText(html))
    expect(cmp.sections).toEqual([
      { section_id: 'company:c1', heading: 'Acme', change: 'changed' },
      { section_id: 'outlook', heading: 'Outlook', change: 'added' },
      { section_id: 'fund-performance', heading: 'Fund performance', change: 'removed' },
    ])
    expect(cmp.internal).toContain('Q3 marks')
    expect(cmp.text).not.toContain('Q3 marks')
    expect(cmp.diff.changes).toContainEqual({ kind: 'added', line: '- Revenue of $110K in Q3' })
    expect(cmp.text).not.toContain('Figure 1')
  })
})
