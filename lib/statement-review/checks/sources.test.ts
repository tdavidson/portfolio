import { describe, expect, it } from 'vitest'
import { isPrinted, pagesOf, sources } from './sources'
import { acme, ctx, pkg } from './fixtures'

const doc = {
  name: 'Q3 statements.pdf',
  text: '[Page 1]\nExample Fund I\nStatement of changes\n[Page 4]\nAcme Partners LP\nEnding capital 590,000.00\nIncome 10,000\n[Page 5 (OCR)]\nManagement fee (5,000.00)',
}

describe('pagesOf and isPrinted', () => {
  it('splits text on page markers, OCR pages included', () => {
    const pages = pagesOf(doc.text)
    expect([...pages.keys()]).toEqual([0, 1, 4, 5])
    expect(pages.get(5)).toContain('(5,000.00)')
  })
  it('finds an amount to the cent, or to the dollar where the text prints whole dollars, either sign', () => {
    expect(isPrinted(590_000, 'Ending capital 590,000.00')).toBe(true)
    expect(isPrinted(-5_000, 'Management fee (5,000.00)')).toBe(true)
    expect(isPrinted(10_000.4, 'Income 10,000')).toBe(true)
    expect(isPrinted(590_000.5, 'Ending capital 590,000.00')).toBe(false)
    expect(isPrinted(59_000, 'Ending capital 590,000.00')).toBe(false)
  })
})

describe('sources', () => {
  const cite = (page: number, label: string) => ({ document: 'Q3 statements.pdf', page, label })
  it("doesn't run without documents", () => {
    expect(sources({ pkg: pkg() }, ctx).outcome).toMatchObject({ ran: false })
  })

  it('passes figures printed on the page they cite', () => {
    const p = pkg({ partners: [acme({ cite: { ending: cite(4, 'Ending capital'), 'allocations.managementFee': cite(5, 'Management fee') } })] })
    const r = sources({ pkg: p, sources: [doc] }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 2 })
    expect(r.findings).toEqual([])
  })

  it('warns on a figure not in the document, and notes one on another page', () => {
    const p = pkg({ partners: [acme({ ending: 595_000, cite: { ending: cite(4, 'Ending capital'), 'allocations.income': cite(1, 'Income') } })] })
    const f = sources({ pkg: p, sources: [doc] }, ctx).findings
    expect(f).toHaveLength(2)
    expect(f.find(x => x.severity === 'warning')?.message).toMatch(/595,000.00.*isn't printed anywhere/)
    expect(f.find(x => x.severity === 'info')?.message).toMatch(/page 4 .* not page 1/)
  })

  it('warns on a citation to a document that was not read, and counts figures without one', () => {
    const p = pkg({ partners: [acme({ cite: { ending: { document: 'Other.pdf', page: 1 } } })] })
    const r = sources({ pkg: p, sources: [doc] }, ctx)
    expect(r.findings[0].message).toMatch(/isn't one of the documents read/)
    expect(r.outcome.note).toMatch(/have no citation/)
  })
})
