// The eval cases grade the way they claim to: each case's good output passes, its bad output fails
// on the checks it was written to trip, and every case is one a skill can actually pass. No model
// is called here; `npm run evals` runs the skills themselves.

import { describe, expect, it } from 'vitest'
import { EVAL_SKILLS, evalPrompt, golden, grade, listCases } from './cases'
import { gradeMemo, parseMemoOutput, type MemoCase } from './memo'

for (const skill of EVAL_SKILLS) {
  describe(`${skill} evals`, () => {
    const cases = listCases(skill)

    it('has cases, each with a good output', () => {
      expect(cases.length).toBeGreaterThan(0)
      for (const c of cases) expect(golden(skill, c.id, 'good'), `${c.id}.good`).not.toBeNull()
    })

    for (const c of cases) {
      it(`${c.id}: the good output passes`, () => {
        const r = grade(skill, golden(skill, c.id, 'good')!, c)
        expect(r.failures).toEqual([])
      })

      const bad = golden(skill, c.id, 'bad')
      if (bad) it(`${c.id}: the bad output fails`, () => {
        expect(grade(skill, bad, c).pass).toBe(false)
      })

      it(`${c.id}: the prompt carries the skill and the brief`, () => {
        const { system, user } = evalPrompt(skill, c)
        expect(system).toContain(`name: ${skill}`)
        expect(user).toContain(JSON.stringify(c.brief, null, 2))
      })
    }
  })
}

describe('letter grading', () => {
  const [c] = listCases('lp-quarterly-letter').filter(x => x.id === 'mixed-quarter')
  const bad = grade('lp-quarterly-letter', golden('lp-quarterly-letter', 'mixed-quarter', 'bad')!, c)
  const checks = new Set(bad.failures.map(f => f.check))

  it('catches what the skill forbids', () => {
    for (const k of [
      'missing_information', 'unsupported_number', 'unlabeled_performance', 'confidential_quoted',
      'unstated_event', 'stale_copy', 'investor_named', 'must_contain', 'must_not_contain',
    ]) expect(checks, k).toContain(k)
  })
})

describe('memo grading', () => {
  const [c] = listCases('investment-memo').filter(x => x.id === 'first-round-contradiction') as MemoCase[]

  it('catches what the skill forbids', () => {
    const checks = new Set(grade('investment-memo', golden('investment-memo', c.id, 'bad')!, c).failures.map(f => f.check))
    for (const k of [
      'recommendation_outside_section', 'team_judgment', 'number_not_in_sources', 'unlabeled_projection',
      'empty_section', 'must_contain', 'attention_must_contain', 'attribute_claims',
    ]) expect(checks, k).toContain(k)
  })

  it('accepts the partner placeholder left in the recommendation, as the skill says to', () => {
    const r = gradeMemo(JSON.stringify({ paragraphs: [{ section: 'Recommendation', text: '[Partner to complete]' }] }), c)
    expect(r.failures.map(f => f.check)).not.toContain('recommendation_outside_section')
  })

  it('reads JSON inside a code fence and fails a reply with none', () => {
    expect(parseMemoOutput('Here it is:\n```json\n{"paragraphs": []}\n```')).toEqual({ paragraphs: [] })
    expect(gradeMemo('I could not write the memo.', c).failures[0].check).toBe('parse')
  })
})
