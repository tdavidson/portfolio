import { describe, it, expect, vi } from 'vitest'
import { EXTRACTION_PROMPT, parseJsonLoosely, readManagerDocument, validateExtraction } from './fof-extract'
import type { CreateMessageParams } from '@/lib/ai/types'

const good = {
  rows: [
    {
      fundName: 'Acme Ventures III', navAsOf: '2025-09-30', reportedNav: 4000000,
      calls: 500000, distributions: 0, confidence: 'high', sourceText: 'Ending capital 4,000,000',
    },
  ],
}

describe('validateExtraction', () => {
  it('accepts a well-formed response', () => {
    const { rows, warnings } = validateExtraction(good)
    expect(warnings).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fundName: 'Acme Ventures III', navAsOf: '2025-09-30',
      reportedNav: 4_000_000, calls: 500_000, distributions: 0, confidence: 'high',
    })
  })

  it('coerces a formatted-string amount the model echoed from the page', () => {
    const { rows } = validateExtraction({ rows: [{ ...good.rows[0], reportedNav: '4,000,000.00', calls: '$500,000' }] })
    expect(rows[0].reportedNav).toBe(4_000_000)
    expect(rows[0].calls).toBe(500_000)
  })

  it('normalizes a US-format valuation date', () => {
    const { rows } = validateExtraction({ rows: [{ ...good.rows[0], navAsOf: '9/30/2025' }] })
    expect(rows[0].navAsOf).toBe('2025-09-30')
  })

  it('drops a row with no fund name and says so', () => {
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], fundName: '   ' }] })
    expect(rows).toEqual([])
    expect(warnings.join(' ')).toMatch(/fund name/i)
  })

  it('drops a negative amount rather than booking a backwards call', () => {
    // A negative call is not a distribution — it is a misread. Direction comes from `kind`,
    // never from a sign the model inferred.
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], calls: -500000 }] })
    expect(rows).toEqual([])
    expect(warnings.join(' ')).toMatch(/negative/i)
  })

  it('drops a non-finite number', () => {
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], reportedNav: 'see attached' }] })
    expect(rows).toEqual([])
    expect(warnings.join(' ')).toMatch(/Acme Ventures III/)
  })

  it('treats an absent NAV as unreported rather than zero', () => {
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], reportedNav: null, navAsOf: null }] })
    expect(warnings).toEqual([])
    expect(rows[0].reportedNav).toBeNull()
    expect(rows[0].navAsOf).toBeNull()
    // Blank cash columns still mean "nothing this quarter".
    expect(rows[0].calls).toBe(500_000)
  })

  it('defaults a missing confidence to low rather than assuming high', () => {
    const { rows } = validateExtraction({ rows: [{ ...good.rows[0], confidence: undefined }] })
    expect(rows[0].confidence).toBe('low')
  })

  it('ignores a totals row', () => {
    const { rows } = validateExtraction({ rows: [good.rows[0], { ...good.rows[0], fundName: 'Total' }] })
    expect(rows.map(r => r.fundName)).toEqual(['Acme Ventures III'])
  })

  it('returns empty with a warning for a payload that is not an extraction', () => {
    for (const bad of [null, undefined, 'nope', 42, {}, { rows: 'no' }]) {
      const { rows, warnings } = validateExtraction(bad)
      expect(rows).toEqual([])
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  it('ignores unknown fields the model volunteered', () => {
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], irr: 0.2, commentary: 'strong quarter' }] })
    expect(warnings).toEqual([])
    expect(rows[0]).not.toHaveProperty('commentary')
  })

  it('keeps the source text so review happens against the statement', () => {
    const { rows } = validateExtraction(good)
    expect(rows[0].sourceText).toBe('Ending capital 4,000,000')
  })
})

describe('notice fields', () => {
  it('reads a notice: the date of the call, when it is due, its number and purpose', () => {
    const { rows, warnings } = validateExtraction({ rows: [{
      ...good.rows[0], eventDate: '8/12/2025', dueDate: '2025-08-26', noticeNumber: ' Drawdown No. 7 ', purpose: 'Investments and management fee',
    }] })
    expect(warnings).toEqual([])
    expect(rows[0]).toMatchObject({ eventDate: '2025-08-12', dueDate: '2025-08-26', noticeNumber: 'Drawdown No. 7', purpose: 'Investments and management fee' })
  })

  it('leaves an unreadable due date blank and says so, keeping the row', () => {
    const { rows, warnings } = validateExtraction({ rows: [{ ...good.rows[0], dueDate: 'whenever suits' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].dueDate).toBeNull()
    expect(warnings.join(' ')).toMatch(/due date/)
  })

  it('reads a statement with no notice fields as blank ones', () => {
    const { rows } = validateExtraction(good)
    expect(rows[0]).toMatchObject({ eventDate: null, dueDate: null, noticeNumber: null, purpose: null })
  })
})

describe('parseJsonLoosely', () => {
  it('salvages fenced or prose-wrapped JSON and gives up on prose', () => {
    expect(parseJsonLoosely('```json\n{"rows":[]}\n```')).toEqual({ rows: [] })
    expect(parseJsonLoosely('Here you go: {"rows":[]} — done')).toEqual({ rows: [] })
    expect(parseJsonLoosely('No figures here.')).toBeNull()
  })
})

describe('readManagerDocument', () => {
  const reply = (text: string) => vi.fn(async (_p: CreateMessageParams) => ({ text, usage: { inputTokens: 0, outputTokens: 0 }, truncated: false }))

  it('sends the document and the schema to the fund\'s model, and validates what comes back', async () => {
    const createMessage = reply('```json\n' + JSON.stringify(good) + '\n```')
    const out = await readManagerDocument({ provider: { createMessage }, model: 'm' }, [{ type: 'document', mediaType: 'application/pdf', data: 'JVBER' }])
    expect(out.rows[0]).toMatchObject({ fundName: 'Acme Ventures III', reportedNav: 4_000_000 })
    const params = createMessage.mock.calls[0][0]
    expect(params).toMatchObject({ model: 'm', system: EXTRACTION_PROMPT })
    const content = params.content as any[]
    expect(content[0]).toEqual({ type: 'document', mediaType: 'application/pdf', data: 'JVBER' })
    expect(content.at(-1).text).toContain('"eventDate"')
  })

  it('returns no rows and a warning when the model answers in prose', async () => {
    const out = await readManagerDocument({ provider: { createMessage: reply('I could not find a statement.') }, model: 'm' }, [{ type: 'text', text: 'hello' }])
    expect(out.rows).toEqual([])
    expect(out.warnings.length).toBeGreaterThan(0)
  })
})
