import { describe, expect, it } from 'vitest'
import { investorText, splitInternal } from './internal'

const LETTER = 'Dear Investors,\n\nAcme had a strong quarter.\n\nBest regards,\nJane Doe'

describe("the partners' notes kept apart from a letter", () => {
  it('splits at the "Missing information" heading', () => {
    const { body, internal } = splitInternal(`${LETTER}\n\nMissing information\n- Gross IRR.\n- Birch: no update.`)
    expect(body).toBe(LETTER)
    expect(internal).toBe('Missing information\n- Gross IRR.\n- Birch: no update.')
  })

  it.each([
    '## Missing information', 'MISSING INFORMATION:', '**Missing information**', '  Missing information  ',
  ])('recognizes the heading written as %j', heading => {
    expect(splitInternal(`${LETTER}\n\n${heading}\n- x`).body).toBe(LETTER)
  })

  it('drops a separator line left before it', () => {
    expect(splitInternal(`${LETTER}\n\n──────────\n\nMissing information\n- x`).body).toBe(LETTER)
  })

  it('leaves a letter without the section, and the words in a sentence, alone', () => {
    expect(splitInternal(LETTER)).toEqual({ body: LETTER, internal: null })
    const prose = `${LETTER}\nWe list missing information for the partners separately.`
    expect(investorText(prose)).toBe(prose)
    expect(investorText(null)).toBe('')
  })
})
