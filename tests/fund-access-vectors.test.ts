import { describe, it, expect } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import schema from '@/spec/fund-access/schema/vector.schema.json'
import { decide } from '@/spec/fund-access/engine/decide'
import { loadVectors } from '@/spec/fund-access/engine/vectors'

/**
 * The Fund Access spec's own check (spec/fund-access/08-conformance.md): every vector is valid
 * against the schema, ids are unique and match their file, and the reference engine produces each
 * expected outcome and reason. Portfolio's own run is tests/fund-access-portfolio.test.ts.
 */

const vectors = loadVectors()
const validate = new Ajv2020({ allErrors: true }).compile(schema)

describe('Fund Access vectors', () => {
  it('has vectors, each with a unique id', () => {
    expect(vectors.length).toBeGreaterThan(30)
    expect(new Set(vectors.map(v => v.id)).size).toBe(vectors.length)
  })

  for (const v of vectors) {
    it(`${v.id}: valid, and the reference engine agrees`, () => {
      expect(validate(v), JSON.stringify(validate.errors)).toBe(true)
      const got = decide(v.fund, v.party, v.call)
      expect({ outcome: got.outcome, reason: got.reason }).toEqual({ outcome: v.expect.outcome, reason: v.expect.reason })
    })
  }
})
