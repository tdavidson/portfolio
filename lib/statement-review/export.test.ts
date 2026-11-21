import { describe, expect, it } from 'vitest'
import { questionsMarkdown, reviewFileName, reviewHtml, reviewMarkdown } from './export'
import type { StoredReview } from './store'

const review: StoredReview = {
  id: 'r1', vehicle: 'Example Fund I', periodStart: '2026-07-01', periodEnd: '2026-09-30', source: 'administrator', input: 'package',
  counts: { error: 1, warning: 0, info: 1 }, partners: 2, runAt: '2026-10-20T14:00:00Z', runBy: null, current: true, signedOffAt: null,
  package: { vehicleId: 'v', periodStart: '2026-07-01', periodEnd: '2026-09-30', source: 'administrator', documents: [{ name: 'Q3 statements.pdf', hash: 'a'.repeat(64) }] },
  checks: [{ check: 'roll_forward', ran: true, compared: 4 }],
  findings: [
    { check: 'roll_forward', severity: 'error', subject: { kind: 'partner', label: 'Acme Partners LP' }, stated: 10, expected: 5, difference: 5,
      message: 'Ending capital does not roll.', cites: [{ document: 'Q3 statements.pdf', page: 4 }], status: 'open' },
    { check: 'foots', severity: 'info', subject: { kind: 'fund', label: 'Fund' }, message: 'A <b>cent</b> off.', cites: [], status: 'open' },
  ],
  materiality: { amount: 100, navShare: 0 }, threshold: 100, nav: 1_000_000, signOff: null,
}

describe('export', () => {
  it('lists the questions by document', () => {
    const q = questionsMarkdown(review)
    expect(q).toContain("# Questions on Example Fund I's statements for the period ending 2026-09-30")
    expect(q).toContain('## Q3 statements.pdf')
    expect(q).toMatch(/1\. \(Page 4\) Ending capital does not roll\./)
    expect(q).not.toContain('cent')
  })
  it('writes the whole review, and escapes HTML in the PDF page', () => {
    const m = reviewMarkdown(review)
    expect(m).toContain('Not signed off.')
    expect(m).toContain('| Roll-forward | Yes | 4 |')
    expect(reviewHtml(review)).toContain('A &lt;b&gt;cent&lt;/b&gt; off.')
    expect(reviewMarkdown({ ...review, signOff: { by: 'u', byName: 'Jane Doe', at: '2026-10-21T00:00:00Z', documents: [], counts: review.counts, statuses: { open: 0, explained: 1, asked: 0, accepted: 1 }, checks: [], materiality: review.materiality, threshold: 100 } }))
      .toContain('Signed off 2026-10-21 by Jane Doe.')
  })
  it('names the file after the vehicle and period', () => {
    expect(reviewFileName(review, 'pdf')).toBe('statement-review-Example-Fund-I-2026-09-30.pdf')
  })
})
