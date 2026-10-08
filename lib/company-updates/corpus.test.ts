import { describe, expect, it } from 'vitest'
import { extractArtifact, extractEmailBody, type ExtractedArtifact } from './extraction'
import { EMAIL_BODIES, docxBytes, multiPagePdf, pngBytes, pptxBytes, workbookBytes } from './fixtures'

/**
 * The verification corpus: representative, sanitized updates with KNOWN QUESTIONS and the source
 * passage each must resolve to. These tests measure whether the correct evidence is present in a
 * chunk with the right locator — the precondition for the SQL search returning it — not merely
 * that a parser ran.
 *
 * The SQL side (`company_updates_search`) is exercised by supabase/tests/company_updates_search.sql
 * against a running stack; the matcher here is a deliberate stand-in so the corpus can run in CI.
 */

interface Expectation {
  question: string
  /** Substring that must appear in exactly the chunk the locator identifies. */
  passage: string
  locator: Record<string, unknown>
  /** What must be TRUE about extraction so the answer is not mistaken for absence. */
  status?: ExtractedArtifact['status']
}

function chunkMatching(chunks: ExtractedArtifact['chunks'], locator: Record<string, unknown>) {
  return chunks.filter(chunk => Object.entries(locator).every(([key, value]) => chunk.locator[key] === value))
}

function expectEvidence(result: ExtractedArtifact, expectation: Expectation) {
  const candidates = chunkMatching(result.chunks, expectation.locator)
  expect(candidates.length, `${expectation.question}: no chunk at ${JSON.stringify(expectation.locator)}`).toBeGreaterThan(0)
  const hit = candidates.find(chunk => chunk.text.toLowerCase().includes(expectation.passage.toLowerCase()))
  expect(hit, `${expectation.question}: passage "${expectation.passage}" missing from ${JSON.stringify(expectation.locator)}`).toBeTruthy()
  // The complete representation must contain what the chunk contains.
  expect(result.text.toLowerCase()).toContain(expectation.passage.toLowerCase())
  if (expectation.status) expect(result.status).toBe(expectation.status)
}

async function artifact(filename: string, bytes: Buffer, declared?: string) {
  return extractArtifact({ filename, declaredContentType: declared, content: bytes.toString('base64') })
}

describe('verification corpus — email bodies', () => {
  it('plain body: current-message chunk carries the figure; a bare sign-off is NOT cut', () => {
    const body = extractEmailBody(EMAIL_BODIES.plain)
    expect(body.current).toContain('Net revenue retention reached 118%')
    // The cleaner is conservative by design: only a "-- " separator or a quote header cuts.
    // "Best,\nAda" without a separator stays, because guessing wrong would drop real content.
    expect(body.current).toContain('Best,\nAda')
    expect(body.original).toContain('Best,\nAda')
    expect(body.cleaningStatus).toBe('complete')
    expect(body.currentChunks[0].locator).toMatchObject({ section: 'email_body', representation: 'current' })
  })

  it('HTML-only body: list items and bold figures survive with a derived-from-HTML warning', () => {
    const body = extractEmailBody(EMAIL_BODIES.htmlOnly)
    expect(body.original).toContain('- NRR 118%')
    expect(body.original).toContain('Cash $4.2M')
    expect(body.warnings[0]).toMatch(/derived from HTML/)
  })

  it('Gmail reply: quoted history is in the original, cut from the current message', () => {
    const body = extractEmailBody(EMAIL_BODIES.gmailReply)
    expect(body.current).toBe('Thanks — noted on the hiring plan.')
    expect(body.original).toContain('Churn was 1.1%')
    expect(body.cleaningStatus).toBe('complete')
    // The quoted history is searchable as original chunks; the new reply text is not duplicated there.
    const originalText = body.originalChunks.map(c => c.text).join('\n')
    expect(originalText).toContain('Churn was 1.1%')
    expect(originalText).not.toContain('Thanks — noted on the hiring plan.')
  })

  it('Outlook reply: the From/Sent header block marks the quote boundary', () => {
    const body = extractEmailBody(EMAIL_BODIES.outlookReply)
    expect(body.current).toBe('Confirming receipt.')
    expect(body.original).toContain('July ARR $1.35M')
  })

  it('forwarded founder update: forwarded sender recovered, forwarded content retained', () => {
    const body = extractEmailBody(EMAIL_BODIES.forwarded)
    expect(body.forwardedSender).toEqual({ name: 'Ada Founder', email: 'ada@example.test' })
    expect(body.current).toContain('Customer retention rose to 96 percent')
    // current already holds the forwarded content, so indexing the original too would duplicate it.
    expect(body.originalChunks).toEqual([])
    expect(body.original).toContain('Customer retention rose to 96 percent')
  })

  it('wholly quoted message: cleaning is uncertain and keeps everything rather than emptying it', () => {
    const body = extractEmailBody(EMAIL_BODIES.whollyQuoted)
    expect(body.cleaningStatus).toBe('uncertain')
    expect(body.current).toContain('Retention 96 percent')
    expect(body.warnings.join(' ')).toMatch(/uncertain/)
    expect(body.originalChunks).toEqual([])
    expect(body.currentChunks.length).toBeGreaterThan(0)
  })

  it('bumps the cleaner version so backfill treats v1 captures as stale', () => {
    expect(extractEmailBody(EMAIL_BODIES.plain).cleanerVersion).toBe('company-updates-body-v3')
  })
})

describe('verification corpus — attachments', () => {
  it('selectable multi-page PDF: each figure resolves to its page', async () => {
    const pdf = multiPagePdf([
      'Executive summary. Net revenue retention was 118 percent in the second quarter.',
      'Financials. Cash balance 4.2 million dollars; runway eighteen months at current burn.',
      'Team. Headcount 42, two open roles in engineering and one in sales.',
    ])
    const { result } = await artifact('Q2 update.pdf', pdf, 'application/pdf')
    expectEvidence(result, { question: 'What was NRR in Q2?', passage: 'retention was 118 percent', locator: { page: 1 }, status: 'complete' })
    expectEvidence(result, { question: 'What is the runway?', passage: 'runway eighteen months', locator: { page: 2 } })
    expectEvidence(result, { question: 'How many open roles?', passage: 'two open roles', locator: { page: 3 } })
    expect(result.metadata).toMatchObject({ pageCount: 3, pagesWithText: 3, ocrNeeded: false })
  })

  it('scanned PDF (one image-only page among text pages): partial, OCR queued for that page only', async () => {
    const pdf = multiPagePdf(['Cover page with a title line and the reporting period stated.', '', 'Appendix. Churn was 1.1 percent in July.'])
    const { result } = await artifact('scan.pdf', pdf, 'application/pdf')
    expect(result.status).toBe('partial')
    expect(result.metadata).toMatchObject({ ocrNeeded: true, ocrNeededPages: [2], pagesWithText: 2 })
    expect(result.warnings[0]).toBe('PDF pages requiring OCR: 2.')
    expectEvidence(result, { question: 'What was churn in July?', passage: 'Churn was 1.1 percent', locator: { page: 3 } })
    expect(chunkMatching(result.chunks, { page: 2 })).toEqual([])
  })

  it('image-only PDF: failed (no text yet) with OCR queued, never an empty complete', async () => {
    const { result } = await artifact('scan.pdf', multiPagePdf(['', '']), 'application/pdf')
    expect(result.status).toBe('failed')
    expect(result.metadata).toMatchObject({ ocrNeeded: true, ocrNeededPages: [1, 2] })
  })

  it('DOCX: headings, list items and table rows each chunk under their heading', async () => {
    const bytes = await docxBytes({
      blocks: [
        { heading: 'Commercial' },
        { paragraph: 'We signed Globex and Initech this quarter.' },
        { bullets: ['Pipeline grew to 3.4 million', 'Win rate 31 percent'] },
        { heading: 'Finance' },
        { table: [['Metric', 'Value'], ['Cash', '4.2M'], ['Runway', '18 months']] },
      ],
    })
    const { result } = await artifact('board memo.docx', bytes)
    expect(result.parser).toBe('docx-xml')
    expect(result.status).toBe('complete')
    expect(result.text).toContain('- Pipeline grew to 3.4 million')
    expect(result.text).toContain('Runway | 18 months')
    expectEvidence(result, { question: 'Which customers did we sign?', passage: 'signed Globex and Initech', locator: { heading: 'Commercial' } })
    expectEvidence(result, { question: 'What is the runway?', passage: 'Runway | 18 months', locator: { heading: 'Finance' } })
    expect(result.metadata).toMatchObject({ headingCount: 2, tableCount: 1 })
  })

  it('PPTX: slide text, table rows and speaker notes resolve to their slide', async () => {
    const bytes = await pptxBytes({
      slides: [
        { paragraphs: ['Q2 Board Update', 'Confidential'] },
        { paragraphs: ['Retention'], table: [['Cohort', 'NRR'], ['Enterprise', '124%'], ['SMB', '101%']], notes: ['Enterprise NRR benefited from the Globex expansion.'] },
      ],
    })
    const { result } = await artifact('deck', bytes, 'application/octet-stream')
    expect(result.status).toBe('complete')
    expectEvidence(result, { question: 'Enterprise NRR?', passage: 'Enterprise | 124%', locator: { slide: 2 } })
    expectEvidence(result, { question: 'Why did enterprise NRR improve?', passage: 'Globex expansion', locator: { slide: 2, section: 'notes' } })
    expect(result.text).toContain('[Slide 2]\nRetention\nCohort | NRR')
    expect(result.metadata).toMatchObject({ slideCount: 2, slidesWithNotes: 1 })
  })

  it('workbook: model, table, prose, formula, hidden and duplicate-name-like sheets are all searchable', async () => {
    const bytes = workbookBytes([
      { name: 'Model', rows: [['Month', 'ARR', 'Churn'], ['Jul 2026', 1_350_000, 0.011], ['Aug 2026', 1_420_000, 0.009]], formulas: { B4: 'SUM(B2:B3)' } },
      { name: 'Customers', rows: [['Customer', 'Segment', 'ARR'], ['Globex', 'Enterprise', 240_000], ['Initech', 'Mid-market', 96_000]] },
      { name: 'Notes', rows: [['We paused sales hiring in August to protect runway.']] },
      { name: 'Model (old)', rows: [['Month', 'ARR'], ['Jun 2026', 1_300_000]], hidden: 1 },
    ])
    const { result } = await artifact('financial model.xlsx', bytes)
    expect(result.status).toBe('complete')
    expectEvidence(result, { question: 'What is Globex ARR?', passage: 'A=Globex | B=Enterprise | C=240000', locator: { sheet: 'Customers' } })
    expectEvidence(result, { question: 'Why did hiring pause?', passage: 'paused sales hiring in August', locator: { sheet: 'Notes' } })
    expectEvidence(result, { question: 'Is there a total formula?', passage: '[formula: =SUM(B2:B3)]', locator: { sheet: 'Model' } })
    expectEvidence(result, { question: 'What did the old model say?', passage: 'Jun 2026', locator: { sheet: 'Model (old)', visibility: 'hidden' } })
    // Never only column names: the prose sheet's sentence is present, not just a header row.
    expect(result.text).toContain('[Sheet: Notes | Visibility: visible]\nRow 1: A=We paused sales hiring')
  })

  it('CSV: rows keep their row locator', async () => {
    const csv = Buffer.from('date,metric,value\n2026-07-31,ARR,1350000\n2026-08-31,ARR,1420000\n')
    const { result } = await artifact('metrics.csv', csv, 'text/csv')
    expect(result.status).toBe('complete')
    expectEvidence(result, { question: 'ARR at end of August?', passage: 'A=2026-08-31 | B=ARR | C=1420000', locator: { sheet: 'Sheet1', rowStart: 1 } })
  })

  it('extensionless generic-MIME text: detected as text and fully preserved', async () => {
    const { result, detectedContentType } = await artifact('update', Buffer.from('Runway 18 months. Burn 230k/month.'), 'application/octet-stream')
    expect(detectedContentType).toBe('text/plain')
    expectEvidence(result, { question: 'Monthly burn?', passage: 'Burn 230k/month', locator: { section: 'text' }, status: 'complete' })
  })

  it('image with a generic MIME type is detected by signature and queued for OCR', async () => {
    const { result, detectedContentType } = await artifact('chart', pngBytes(), 'application/octet-stream')
    expect(detectedContentType).toBe('image/png')
    expect(result.status).toBe('not_applicable')
    expect(result.metadata).toMatchObject({ ocrNeeded: true, ocrUsed: false })
  })

  it('declared type disagreeing with detected type is recorded, and the safety scan decides', async () => {
    const pdf = multiPagePdf(['Mislabelled but readable: gross margin 71 percent.'])
    // Declared AND named as a spreadsheet, actually a PDF. The mismatch is stored either way; the
    // format-aware scan then fails closed on a claimed archive it cannot open, and that outcome is
    // a visible failed artifact with both facts — never a silent skip.
    const { result, detectedContentType } = await artifact('report.xlsx', pdf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(detectedContentType).toBe('application/pdf')
    expect(result.warnings[0]).toMatch(/Declared content type .* differs from detected type application\/pdf/)
    expect(result.status).toBe('failed')
    expect(result.parser).toBe('safety-scan')
    expect(result.warnings.at(-1)).toMatch(/ZIP-based file could not be parsed/)

    // The same bytes under a truthful generic declaration read fine, page-located.
    const honest = await artifact('report', pdf, 'application/octet-stream')
    expectEvidence(honest.result, { question: 'Gross margin?', passage: 'gross margin 71 percent', locator: { page: 1 } })
  })
})
