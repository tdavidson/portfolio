import { describe, expect, it } from 'vitest'
import { buildExtractionPrompt, documentsText, packageDocuments, parseExtractionResponse } from './extract'
import { cleanPackage } from './clean'

const docs = [
  { id: 'd1', name: 'Q3 statements.pdf', text: '[Page 1]\nExample Fund I\n[Page 2]\nAcme Partners LP 590,000.00', hash: 'a'.repeat(64), pages: 2 },
  { id: 'd2', name: 'Q3 SOI.xlsx', text: '# Sheet1\nNorthwind,100000,150000' },
]

describe('parseExtractionResponse', () => {
  it('reads a fenced or bare JSON object, or an object given as is', () => {
    expect(parseExtractionResponse('Here it is:\n```json\n{ "period_end": "2026-09-30" }\n```')).toEqual({ period_end: '2026-09-30' })
    expect(parseExtractionResponse('{ "partners": [] }')).toEqual({ partners: [] })
    expect(parseExtractionResponse({ period_end: '2026-09-30' })).toEqual({ period_end: '2026-09-30' })
  })
  it('says what is wrong when there is no object', () => {
    expect(parseExtractionResponse('no json here')).toMatch(/no JSON object/)
    expect(parseExtractionResponse('{ broken')).toMatch(/no JSON object|not valid JSON/)
    expect(parseExtractionResponse([1, 2])).toMatch(/not a JSON object/)
  })
})

describe('documentsText', () => {
  it('labels each document and cuts to the budget, naming what was cut', () => {
    const { text, truncated } = documentsText(docs, 30)
    expect(text).toContain('===== DOCUMENT: Q3 statements.pdf =====')
    expect(truncated).toEqual(['Q3 statements.pdf', 'Q3 SOI.xlsx'])
    expect(documentsText(docs, 10_000).truncated).toEqual([])
  })
})

describe('buildExtractionPrompt', () => {
  it('carries the shape, the rules, the period and every document', () => {
    const { prompt } = buildExtractionPrompt(docs, { periodEnd: '2026-09-30', vehicle: 'Example Fund I' })
    expect(prompt).toContain('period ending 2026-09-30')
    expect(prompt).toContain('"partners"')
    expect(prompt).toContain('Copy figures exactly as printed')
    expect(prompt).toContain('===== DOCUMENT: Q3 SOI.xlsx =====')
  })
})

describe('a reading becomes a package', () => {
  it('cleans like any package, with the documents recorded', () => {
    const reading = parseExtractionResponse('{"period_end":"2026-09-30","partners":[{"name":"Acme Partners LP","ending":"590,000.00","cite":{"ending":{"document":"Q3 statements.pdf","page":2}}}]}')
    const pkg = cleanPackage({ ...(reading as object), documents: packageDocuments(docs) }, 'veh-1')
    expect(typeof pkg).toBe('object')
    if (typeof pkg === 'string') return
    expect(pkg.partners?.[0]).toMatchObject({ ending: 590_000, cite: { ending: { document: 'Q3 statements.pdf', page: 2 } } })
    expect(pkg.documents).toEqual([
      { name: 'Q3 statements.pdf', kind: 'statements', hash: 'a'.repeat(64), pages: 2 },
      { name: 'Q3 SOI.xlsx', kind: 'statements' },
    ])
  })
})
