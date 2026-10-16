import { describe, it, expect } from 'vitest'
import { soiTies } from './statements'

describe('soiTies', () => {
  const rows = Array.from({ length: 10 }, () => ({}))
  it('ties when fair value is off by rounding under a dollar a row', () => {
    expect(soiTies({ costVariance: 0, fairValueVariance: -0.43, rows })).toBe(true)
  })
  it('does not tie on any cost variance', () => {
    expect(soiTies({ costVariance: 0.01, fairValueVariance: 0, rows })).toBe(false)
  })
  it('does not tie on a real fair value variance', () => {
    expect(soiTies({ costVariance: 0, fairValueVariance: 64120.75, rows })).toBe(false)
  })
})
