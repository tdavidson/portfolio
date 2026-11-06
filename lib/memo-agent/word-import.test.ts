import { describe, expect, it } from 'vitest'
import { matchImported, similarity } from './word-import'
import { buildParagraphs, nextDraftVersion, resolveSection } from './assistant-memo'
import type { BriefSection } from './brief'
import type { MemoParagraph } from './stages/draft'

const sections: BriefSection[] = [
  { id: 'executive_summary', title: 'Summary', depth: 'standard', partner_only: false, covers: null },
  { id: 'recommendation', title: 'The Ask', depth: 'standard', partner_only: true, covers: null },
  { id: 'team', title: 'Team', depth: 'standard', partner_only: false, covers: null },
]
const para = (id: string, section: string, prose: string, refs: string[] = []): MemoParagraph => ({
  id, section_id: section, order: 1, prose, origin: 'agent_drafted', confidence: 'medium',
  sources: refs.map(r => ({ source_type: 'claim', source_id: r })), contains_projection: false, contains_unverified_claim: false, contains_contradiction: false,
})

describe('matchImported', () => {
  const prior = [
    para('p1', 'executive_summary', 'Northwind Freight routes freight for mid-sized shippers and reports 1.4M ARR.', ['c1']),
    para('p2', 'team', 'The founders ran operations at a carrier.', ['c2']),
  ]
  it('keeps citations on edited paragraphs and lists every change', () => {
    const out = matchImported([
      { title: 'Summary', paragraphs: ['Northwind Freight routes freight for mid-sized shippers and reports 1.5M ARR.', 'A new paragraph.'] },
      { title: 'The Ask', paragraphs: ['We propose to invest.'] },
    ], sections, prior)
    expect(out.paragraphs[0]).toEqual({ section: 'executive_summary', text: expect.stringContaining('1.5M'), sources: ['claim:c1'] })
    expect(out.paragraphs[1].sources).toEqual([])
    expect(out.changes.map(c => c.kind)).toEqual(['edited', 'added', 'added', 'removed'])
    expect(out.unmatched).toEqual([])
  })
  it('scores similar text above different text', () => {
    expect(similarity('ARR grew to 1.4M', 'ARR grew to 1.5M')).toBeGreaterThan(similarity('ARR grew to 1.4M', 'The team is small'))
  })
})

describe('buildParagraphs', () => {
  it('resolves sections by id or title, keeps the partner placeholder, and orders by section', () => {
    expect(resolveSection(sections, 'summary')?.id).toBe('executive_summary')
    const { paragraphs, problems } = buildParagraphs(sections, [
      { section: 'Team', text: 'Two founders.', sources: ['claim:c2'] },
      { section: 'The Ask', text: 'Invest.', sources: [] },
      { section: 'Summary', text: 'Freight routing.', sources: ['claim:c1'] },
    ], 'agent_drafted')
    expect(paragraphs.map(p => [p.section_id, p.prose])).toEqual([
      ['executive_summary', 'Freight routing.'], ['recommendation', '[Partner to complete]'], ['team', 'Two founders.'],
    ])
    expect(problems.map(p => p.kind)).toEqual(['recommendation_outside_section'])
  })
  it('lets a partner write the partner section', () => {
    const { paragraphs } = buildParagraphs(sections, [{ section: 'The Ask', text: 'We propose to invest.' }], 'partner_edited', true)
    expect(paragraphs.find(p => p.section_id === 'recommendation')).toMatchObject({ prose: 'We propose to invest.', origin: 'partner_drafted' })
  })
  it('numbers versions by who wrote them', () => {
    expect(nextDraftVersion('v0.3-ingest-2026-01-01', 'assistant')).toBe('v0.4-assistant')
    expect(nextDraftVersion(null, 'import')).toBe('v0.2-import')
  })
})
