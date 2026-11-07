import { describe, expect, it } from 'vitest'
import {
  affectedPriorRefs, buildRequestList, describeChangesForPrompt, diffRoundEvidence, memoRevisionTitle, notableChanges,
  requestListText, ROUND_CHANGES_SECTION_ID, withRoundChangesFirst,
} from './rounds'

const ingestion = (claims: Array<{ id: string; field: string; value: string }>, missing: string[] = []) => ({
  documents: [{ document_id: 'doc-1', detected_type: 'pitch_deck', type_confidence: 'high', summary: '', claims: claims.map(c => ({ ...c, context: '', verification_status: 'unverified', criticality: 'high' })) }],
  gap_analysis: { missing: missing.map(t => ({ expected_type: t, criticality: 'blocker', rationale: `No ${t}.` })), inadequate: [] },
  cross_doc_flags: [],
})

const research = (findings: Array<{ id: string; topic: string; status: string }>, contradictions: string[] = []) => ({
  findings: findings.map(f => ({ id: f.id, claim_ref: null, topic: f.topic, verification_status: f.status, evidence: `About ${f.topic}.`, sources: [] })),
  contradictions: contradictions.map(t => ({ topic: t, claim_ref: null, description: `${t} disagrees.`, severity: 'material' })),
  competitive_map: { named_by_company: [], named_by_research: [] },
  founder_dossiers: [],
  research_gaps: [],
  research_mode: 'no_web_search',
})

const round1 = {
  ingestion_output: ingestion([
    { id: 'c1', field: 'ARR', value: '$1.0M' },
    { id: 'c2', field: 'Customers', value: '40' },
    { id: 'c3', field: 'Burn', value: '$100K / month' },
  ], ['cap_table', 'financial_model']),
  research_output: research([{ id: 'f1', topic: 'Market size', status: 'company_stated' }], ['Churn']),
  qa_answers: [{ question_id: 'q1', answer_text: 'Two pilots running.' }],
}

// Round 2 re-analyzed everything, so the ids moved; matching is on what each item is about.
const round2 = {
  ingestion_output: ingestion([
    { id: 'c10', field: 'ARR', value: '$1.4M' },
    { id: 'c11', field: 'Customers', value: '40' },
    { id: 'c12', field: 'Net revenue retention', value: '120%' },
  ], ['financial_model']),
  research_output: research([{ id: 'f9', topic: 'Market size', status: 'verified' }]),
  qa_answers: [{ question_id: 'q1', answer_text: 'Two pilots running.' }, { question_id: 'q2', answer_text: 'Hiring a CFO.', excluded: true }],
}

describe('what changed between diligence rounds', () => {
  const changes = diffRoundEvidence(round1, round2)
  const find = (kind: string, label: string) => changes.items.find(i => i.kind === kind && i.label === label)

  it('matches claims on their document and field, not their id', () => {
    expect(find('claim', 'ARR')).toMatchObject({ status: 'changed', ref: 'claim:c10', prior_ref: 'claim:c1', detail: '$1.4M', prior_detail: '$1.0M' })
    expect(find('claim', 'Customers')).toMatchObject({ status: 'confirmed', ref: 'claim:c11', prior_ref: 'claim:c2' })
    expect(find('claim', 'Net revenue retention')).toMatchObject({ status: 'new', prior_ref: null })
    expect(find('claim', 'Burn')).toMatchObject({ status: 'resolved', ref: null, prior_ref: 'claim:c3' })
  })

  it('counts a finding as changed only when its verdict moved', () => {
    expect(find('finding', 'Market size')).toMatchObject({ status: 'changed', ref: 'finding:f9', prior_ref: 'finding:f1' })
  })

  it('reports closed gaps and gone contradictions as resolved', () => {
    expect(find('gap', 'Missing: Cap table')?.status).toBe('resolved')
    expect(find('gap', 'Missing: Financial model')?.status).toBe('confirmed')
    expect(find('contradiction', 'Churn')?.status).toBe('resolved')
  })

  it('leaves partner-excluded answers out', () => {
    expect(changes.items.filter(i => i.kind === 'qa').map(i => i.status)).toEqual(['confirmed'])
  })

  it('counts by kind and status', () => {
    expect(changes.counts.claim).toEqual({ new: 1, changed: 1, confirmed: 1, resolved: 1 })
    expect(changes.first_round).toBe(false)
    expect(notableChanges(changes).every(i => i.status !== 'confirmed')).toBe(true)
  })

  it('treats everything as new in round 1', () => {
    const first = diffRoundEvidence(null, round1)
    expect(first.first_round).toBe(true)
    expect(first.items.every(i => i.status === 'new')).toBe(true)
  })

  it('names the prior refs whose evidence changed or went away', () => {
    expect([...affectedPriorRefs(changes)].sort()).toEqual(['claim:c1', 'claim:c3', 'finding:f1'])
  })

  it('describes the changes for the memo agent', () => {
    const text = describeChangesForPrompt(changes, 1)
    expect(text).toContain('CHANGED (claim:c10) ARR: was "$1.0M", now "$1.4M"')
    expect(text).toContain('NEW (claim:c12) Net revenue retention')
    expect(text).toContain('RESOLVED / NO LONGER PRESENT (claim:c3) Burn')
    expect(text).not.toContain('Customers')
    expect(describeChangesForPrompt(diffRoundEvidence(round1, round1), 1)).toBe('Nothing in the evidence changed since round 1.')
  })

  it('handles a round with no evidence', () => {
    expect(diffRoundEvidence({}, {}).items).toEqual([])
  })
})

describe('the follow-up request list', () => {
  const list = buildRequestList({
    checklist: [
      { kind: 'section', label: 'Financials', status: 'unknown' },
      { kind: 'item', label: 'Audited accounts', status: 'missing', section: 'Financials' },
      { kind: 'item', label: 'Customer contracts', status: 'partial', section: 'Commercial' },
      { kind: 'item', label: 'Pitch deck', status: 'found' },
      { kind: 'item', label: 'Cap table', status: 'missing' },
    ],
    attention: [
      { urgency: 'must_address', status: 'open', body: 'Confirm the ARR definition' },
      { urgency: 'should_address', status: 'addressed', body: 'Already answered' },
      { urgency: 'fyi', status: 'open', body: 'Just so you know' },
    ],
    ingestion_output: ingestion([], ['cap_table', 'hiring_plan']),
  })

  it('asks for what is missing first, then what is partial, without repeats', () => {
    expect(list.map(r => [r.priority, r.label])).toEqual([
      ['high', 'Audited accounts'],
      ['high', 'Cap table'],
      ['high', 'Confirm the ARR definition'],
      ['high', 'Hiring plan'],
      ['medium', 'Customer contracts'],
    ])
  })

  it('reads as plain text for an email', () => {
    const text = requestListText(list)
    expect(text.split('\n')[0]).toBe('Needed')
    expect(text).toContain('- Audited accounts (Financials)')
    expect(text).toContain('Helpful\n- Customer contracts (Commercial (partly covered))')
    expect(requestListText([])).toBe('')
  })
})

describe('the memo\'s "What changed" section', () => {
  it('goes first, after a leading header', () => {
    expect(withRoundChangesFirst(['thesis', 'risks', ROUND_CHANGES_SECTION_ID])).toEqual([ROUND_CHANGES_SECTION_ID, 'thesis', 'risks'])
    expect(withRoundChangesFirst(['header', 'thesis', ROUND_CHANGES_SECTION_ID])).toEqual(['header', ROUND_CHANGES_SECTION_ID, 'thesis'])
    expect(withRoundChangesFirst([{ id: 'thesis' }, { id: ROUND_CHANGES_SECTION_ID }]).map(s => s.id)).toEqual([ROUND_CHANGES_SECTION_ID, 'thesis'])
    expect(withRoundChangesFirst(['thesis', 'risks'])).toEqual(['thesis', 'risks'])
  })

  it('is titled from the memo\'s revision marker', () => {
    expect(memoRevisionTitle({ revision: { round_number: 2, prior_round_number: 1, title: 'What changed since Round 1' } })).toBe('What changed since Round 1')
    expect(memoRevisionTitle({ revision: { prior_round_number: 2 } })).toBe('What changed since Round 2')
    expect(memoRevisionTitle({ paragraphs: [] })).toBeNull()
  })
})
