import { describe, it, expect } from 'vitest'
import { soiTies } from './statements'

describe('soiTies', () => {
  const rows = Array.from({ length: 10 }, () => ({}))
  it('ties when fair value is off by rounding under a dollar a row', () => {
    expect(soiTies({ costVariance: 0, fairValueVariance: -0.57, rows })).toBe(true)
  })
  it('does not tie on any cost variance', () => {
    expect(soiTies({ costVariance: 0.01, fairValueVariance: 0, rows })).toBe(false)
  })
  it('does not tie on a real fair value variance', () => {
    expect(soiTies({ costVariance: 0, fairValueVariance: 102913.54, rows })).toBe(false)
  })
})
