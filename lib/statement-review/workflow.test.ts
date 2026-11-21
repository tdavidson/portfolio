import { describe, expect, it } from 'vitest'
import { applyNote, blocking, carryStatuses, draftQuestions, findingKey, keyed, questionFor } from './workflow'
import type { Finding } from './types'

const f = (over: Partial<Finding> = {}): Finding => ({
  check: 'roll_forward', severity: 'error', subject: { kind: 'partner', id: 'lp-acme', label: 'Acme Partners LP' },
  stated: 590_000, expected: 589_000, difference: 1_000,
  message: "Acme Partners LP's ending capital is 590,000.00, but the roll-forward gives 589,000.00 (1,000.00 apart).",
  cites: [{ document: 'Q3 statements.pdf', page: 4, label: 'Ending capital' }], status: 'open', ...over,
})

describe('findingKey', () => {
  it('stays the same when only the figures change', () => {
    const later = f({ message: "Acme Partners LP's ending capital is 591,000.00, but the roll-forward gives 589,500.00 (1,500.00 apart)." })
    expect(findingKey(later)).toBe(findingKey(f()))
    expect(findingKey(f({ check: 'continuity' }))).not.toBe(findingKey(f()))
  })
})

describe('applyNote', () => {
  const list = keyed([f(), f({ subject: { kind: 'partner', id: 'lp-nw', label: 'Northwind Capital' }, severity: 'warning' })])
  it('needs a note to explain or accept', () => {
    expect(applyNote(list, { key: list[0].key, status: 'explained' }, 'u1')).toMatch(/needs a note/)
  })
  it('records who decided and when', () => {
    const r = applyNote(list, { key: list[0].key, status: 'explained', note: 'Wire in transit' }, 'u1', '2026-10-15T00:00:00Z')
    if (typeof r === 'string') throw new Error(r)
    expect(r.finding).toMatchObject({ status: 'explained', note: 'Wire in transit', statusBy: 'u1', statusAt: '2026-10-15T00:00:00Z' })
    expect(blocking(r.findings)).toHaveLength(1)
  })
  it('refuses an unknown key or status', () => {
    expect(applyNote(list, { key: 'nope', status: 'asked' }, 'u1')).toMatch(/No finding/)
    expect(applyNote(list, { key: list[0].key, status: 'done' }, 'u1')).toMatch(/status must be/)
  })
  it('reopening a finding a known adjustment explained restores its severity', () => {
    const adj = keyed([f({ severity: 'info', status: 'explained', adjustedFrom: 'error', note: 'Known adjustment: wire' })])
    const r = applyNote(adj, { key: adj[0].key, status: 'open', note: '' }, 'u1')
    if (typeof r === 'string') throw new Error(r)
    expect(r.finding).toMatchObject({ status: 'open', severity: 'error' })
    expect(r.finding.adjustedFrom).toBeUndefined()
  })
})

describe('carryStatuses', () => {
  it("carries a reviewer's decision and question to the same finding on the next run", () => {
    const before = keyed([f({ status: 'asked', statusBy: 'u1', note: 'Sent to the administrator', question: 'Why?' })])
    const now = keyed([f({ message: "Acme Partners LP's ending capital is 590,500.00, but the roll-forward gives 589,000.00 (1,500.00 apart)." })])
    expect(carryStatuses(now, before)[0]).toMatchObject({ status: 'asked', note: 'Sent to the administrator', question: 'Why?', statusBy: 'u1' })
  })
  it("doesn't carry a known adjustment's status, only a reviewer's", () => {
    const before = keyed([f({ status: 'explained', note: 'Known adjustment: x', adjustedFrom: 'error', severity: 'info' })])
    expect(carryStatuses(keyed([f()]), before)[0].status).toBe('open')
  })
})

describe('draftQuestions', () => {
  it('groups open and asked errors and warnings by document, in page order, leaving out information and closed ones', () => {
    const list = keyed([
      f({ cites: [{ document: 'Q3 statements.pdf', page: 9 }] }),
      f({ subject: { kind: 'fund', label: 'Fund' }, cites: [{ document: 'Q3 statements.pdf', page: 2 }], status: 'asked', question: 'Please send the fee calculation.' }),
      f({ subject: { kind: 'partner', label: 'Northwind Capital' }, cites: [] }),
      f({ subject: { kind: 'partner', label: 'Gone' }, severity: 'info' }),
      f({ subject: { kind: 'partner', label: 'Done' }, status: 'accepted', note: 'ok' }),
    ])
    const g = draftQuestions(list)
    expect(g.map(x => x.document)).toEqual(['Q3 statements.pdf', 'General'])
    expect(g[0].questions.map(q => q.page)).toEqual([2, 9])
    expect(g[0].questions[0].text).toBe('Please send the fee calculation.')
  })
  it('drafts a question that names the difference and where it is stated', () => {
    expect(questionFor(f())).toMatch(/explain the difference of 1,000.00 \(Q3 statements.pdf, page 4, "Ending capital"\)/)
  })
})
