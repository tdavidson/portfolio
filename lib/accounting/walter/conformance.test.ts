// Portfolio accounting against the Walter conformance vectors (README.md in this folder).
//
// Every vector must pass, except the ones listed in GAPS: terms the engine can't express yet, each
// with what's missing. A vector that starts passing fails this test too, so the list is kept
// honest: take it off when the engine learns the term.
//
// WALTER_RESULTS=path writes the run in Walter's results format, for the spec repo's
// compatibility table.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compare, type Vector } from './compare'
import { ENGINE, run } from './adapter'

const GAPS: Record<string, string> = {}

const root = join(__dirname, 'vectors')
const vectors: (Vector & { file: string })[] = readdirSync(root).flatMap(group =>
  readdirSync(join(root, group)).filter(f => f.endsWith('.json')).map(f => ({
    ...JSON.parse(readFileSync(join(root, group, f), 'utf8')),
    file: `vectors/${group}/${f}`,
  })))

describe('Walter conformance', () => {
  const results = vectors.map(v => {
    const o = compare(v, () => run(structuredClone(v.terms), structuredClone(v.flows)))
    return { id: v.id, file: v.file, tags: v.tags, status: o.status, ...(o.problems.length ? { problems: o.problems } : {}) }
  })

  it.each(results.map(r => [r.id, r] as const))('%s', (id, r) => {
    if (GAPS[id]) expect(r.status, `${id} now ${r.status}: take it off GAPS`).toBe('unsupported')
    else expect(r.problems ?? [], `${id} is ${r.status}`).toEqual([])
  })

  it('lists only vectors that exist', () => {
    expect(Object.keys(GAPS).filter(id => !results.some(r => r.id === id))).toEqual([])
  })

  if (process.env.WALTER_RESULTS) {
    const count = (s: string) => results.filter(r => r.status === s).length
    writeFileSync(process.env.WALTER_RESULTS, JSON.stringify({
      walter: '0.3',
      engine: ENGINE,
      summary: { vectors: results.length, pass: count('pass'), fail: count('fail'), unsupported: count('unsupported') },
      results,
    }, null, 2) + '\n')
  }
})
