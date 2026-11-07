import { describe, expect, it } from 'vitest'
import { diffRoundEvidence, affectedPriorRefs } from '@/lib/diligence/rounds'
import { applyRevision, priorMemoText, revisionFillBlock, revisionOutlineBlock, roundChangesParagraphs, type RevisionContext } from './revision'
import type { MemoParagraph } from './stages/draft'

const para = (id: string, section_id: string, prose: string, sources: string[], origin: MemoParagraph['origin'] = 'agent_drafted'): MemoParagraph => ({
  id, section_id, order: 1, prose, origin, confidence: 'medium',
  sources: sources.map(s => ({ source_type: s.split(':')[0], source_id: s.split(':')[1] })),
  contains_projection: false, contains_unverified_claim: false, contains_contradiction: false,
})

const evidence = (arr: string) => ({
  ingestion_output: {
    documents: [{ document_id: 'doc-1', detected_type: 'pitch_deck', type_confidence: 'high', summary: '', claims: [
      { id: arr === '$1.0M' ? 'c1' : 'c10', field: 'ARR', value: arr, context: '', verification_status: 'unverified', criticality: 'high' },
      { id: arr === '$1.0M' ? 'c2' : 'c11', field: 'Customers', value: '40', context: '', verification_status: 'unverified', criticality: 'high' },
    ] }],
    gap_analysis: { missing: [], inadequate: [] },
    cross_doc_flags: [],
  },
})

function ctx(priorParagraphs: MemoParagraph[]): RevisionContext {
  const changes = diffRoundEvidence(evidence('$1.0M'), evidence('$1.4M'))
  return { roundNumber: 2, priorRoundNumber: 1, changes, affected: affectedPriorRefs(changes), priorParagraphs }
}

const prior = [
  para('p_traction_1', 'traction', 'Revenue is $1.0M ARR.', ['claim:c1']),
  para('p_traction_2', 'traction', 'Forty customers pay today.', ['claim:c2']),
  para('p_team_1', 'team', 'The founders met at a lab.', ['claim:c2'], 'partner_edited'),
  para('p_recommendation_1', 'recommendation', 'We should invest.', [], 'partner_drafted'),
]

describe('revising the memo in a later round', () => {
  it('keeps unchanged paragraphs word for word, even when the model rephrased one it called kept', () => {
    const out = applyRevision([
      { ...para('p_traction_2', 'traction', 'Forty paying customers today.', ['claim:c11']), revision: 'kept' },
    ], ctx(prior))
    const p = out.paragraphs.find(x => x.id === 'p_traction_2')!
    expect(p.prose).toBe('Forty customers pay today.')
    expect(p.round_status).toBe('kept')
  })

  it('takes the rewrite of a paragraph whose evidence changed, and marks it revised', () => {
    const out = applyRevision([
      { ...para('p_traction_1', 'traction', 'Revenue grew to $1.4M ARR.', ['claim:c10']), revision: 'kept' },
    ], ctx(prior))
    expect(out.paragraphs.find(x => x.id === 'p_traction_1')).toMatchObject({ prose: 'Revenue grew to $1.4M ARR.', round_status: 'revised' })
  })

  it('marks a paragraph with a new id as new', () => {
    const out = applyRevision([{ ...para('p_traction_9', 'traction', 'Retention is strong.', ['claim:c11']), revision: 'new' }], ctx(prior))
    expect(out.paragraphs.find(x => x.id === 'p_traction_9')?.round_status).toBe('new')
  })

  it('restores the partners\' paragraphs as written, replacing the recommendation placeholder', () => {
    const out = applyRevision([
      { ...para('p_team_1', 'team', 'Rewritten by the model.', ['claim:c11']), revision: 'revised' },
      para('p_recommendation_placeholder', 'recommendation', '[Partner to complete]', [], 'partner_only_placeholder'),
    ], ctx(prior))
    expect(out.paragraphs.find(x => x.id === 'p_team_1')?.prose).toBe('The founders met at a lab.')
    const rec = out.paragraphs.filter(x => x.section_id === 'recommendation')
    expect(rec.map(r => r.prose)).toEqual(['We should invest.'])
    expect(out.attention.map(a => a.kind)).toEqual(['round_recommendation_carried'])
  })

  it('tells the partner when the evidence under their paragraph changed, and keeps their words', () => {
    const withAffected = [...prior, para('p_risks_1', 'risks', 'ARR is small for the round.', ['claim:c1'], 'partner_edited')]
    const out = applyRevision([], ctx(withAffected))
    expect(out.paragraphs.find(x => x.id === 'p_risks_1')?.prose).toBe('ARR is small for the round.')
    expect(out.attention.find(a => a.kind === 'round_evidence_changed')?.links).toEqual([{ source_type: 'claim', source_id: 'c1' }])
  })

  it('tags the prior memo for the prompts', () => {
    const c = ctx(prior)
    const text = priorMemoText(c)
    expect(text).toContain('p_traction_1 (order 1) [EVIDENCE CHANGED] [sources: claim:c1]')
    expect(text).toContain('p_traction_2 (order 1) [EVIDENCE UNCHANGED]')
    expect(text).toContain('p_team_1 (order 1) [PARTNER-WRITTEN (do not rewrite)]')
    expect(priorMemoText(c, ['team'])).not.toContain('p_traction_1')
    expect(revisionOutlineBlock(c)).toContain('REVISION: ROUND 2 OF DILIGENCE')
    expect(revisionFillBlock(c, ['traction'])).toContain('"revision": "kept"')
  })

  it('reads the "What changed" paragraphs', () => {
    const paras = roundChangesParagraphs({ paragraphs: [
      { prose: 'ARR grew 40%.', sources: [{ source_type: 'claim', source_id: 'c10' }, { bad: true }] },
      { prose: '   ' },
    ] })
    expect(paras).toHaveLength(1)
    expect(paras[0]).toMatchObject({ id: 'p_round_changes_1', section_id: 'round_changes', sources: [{ source_type: 'claim', source_id: 'c10' }] })
    expect(roundChangesParagraphs(null)).toEqual([])
  })
})
