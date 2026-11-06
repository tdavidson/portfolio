import { describe, expect, it } from 'vitest'
import { figuresIn, normalizeFigure, refToSource, reviewMemo, sourceToRef } from './review'

const sources = new Map([
  ['claim:c1', 'ARR of $1.4M at year end, up from 0.6M'],
  ['claim:c2', 'Net revenue retention 118%'],
  ['finding:f1', 'Largest customer is 22% of revenue'],
])

describe('figures', () => {
  it('treats 1.4M, 1,400,000 and 1.4 million as one figure', () => {
    expect(normalizeFigure('$1.4M')).toBe('1400000')
    expect(normalizeFigure('1,400,000')).toBe('1400000')
    expect(figuresIn('revenue of 1.4 million')[0].norm).toBe('1400000')
  })
  it('skips years and small bare counts', () => {
    expect(figuresIn('In 2025 it signed 3 customers').map(f => f.raw)).toEqual([])
  })
})

describe('reviewMemo', () => {
  const base = { sources, sections: [{ id: 'executive_summary', title: 'Summary' }, { id: 'traction', title: 'Traction' }, { id: 'recommendation', title: 'Recommendation' }], year: 2026 }

  it('passes a cited paragraph whose figures are in its sources', () => {
    const flags = reviewMemo({ ...base, paragraphs: [
      { id: 'p1', section_id: 'executive_summary', prose: 'ARR reached $1.4M, up from 0.6M [c1].', refs: ['claim:c1'] },
      { id: 'p2', section_id: 'traction', prose: 'Net retention was 118%, per management.', refs: ['claim:c2'] },
      { id: 'p3', section_id: 'recommendation', prose: '[Partner to complete]', refs: [], placeholder: true },
    ] })
    expect(flags).toEqual([])
  })

  it('flags uncited paragraphs, unknown refs, invented and uncited figures', () => {
    const flags = reviewMemo({ ...base, paragraphs: [
      { id: 'p1', section_id: 'executive_summary', prose: 'Revenue is growing.', refs: [] },
      { id: 'p2', section_id: 'traction', prose: 'Retention is 130% and the top customer is 22%.', refs: ['claim:c2', 'claim:zz'] },
    ] })
    expect(flags.map(f => f.kind).sort()).toEqual(['number_not_cited', 'number_not_in_sources', 'uncited', 'unknown_source'])
  })

  it('flags a recommendation, a team judgment and an unlabeled projection', () => {
    const flags = reviewMemo({ ...base, paragraphs: [
      { id: 'p1', section_id: 'executive_summary', prose: 'We recommend investing. The founders are visionary.', refs: ['claim:c1'] },
      { id: 'p2', section_id: 'traction', prose: 'ARR will be 1.4M in 2028.', refs: ['claim:c1'] },
    ] })
    expect(flags.map(f => f.kind).sort()).toEqual(['recommendation_outside_section', 'team_judgment', 'unlabeled_projection'])
  })

  it('flags an empty section but not the partner-only one', () => {
    const flags = reviewMemo({ ...base, paragraphs: [{ id: 'p1', section_id: 'executive_summary', prose: 'ARR of 1.4M.', refs: ['claim:c1'] }] })
    expect(flags).toEqual([{ kind: 'empty_section', severity: 'check', message: '"Traction" has no paragraphs.', section: 'traction' }])
  })
})

describe('refs', () => {
  it('round-trips between brief refs and draft sources', () => {
    expect(refToSource('qa:q_market_1')).toEqual({ source_type: 'qa_answer', source_id: 'q_market_1' })
    expect(sourceToRef({ source_type: 'qa_answer', source_id: 'q_market_1' })).toBe('qa:q_market_1')
    expect(refToSource('nonsense')).toBeNull()
  })
})
