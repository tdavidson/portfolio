import { describe, expect, it } from 'vitest'
import { applyComputed, evaluate, FormulaError, parseFormula } from './formula'

const cols = ['nav', 'called', 'distributed']

describe('formulas', () => {
  it('follows arithmetic precedence, parentheses and unary minus', () => {
    const row = { nav: 300, called: 200, distributed: 100 }
    expect(evaluate(parseFormula('(distributed + nav) / called', cols), row)).toBe(2)
    expect(evaluate(parseFormula('distributed + nav / called', cols), row)).toBe(101.5)
    expect(evaluate(parseFormula('-nav * 2', cols), row)).toBe(-600)
    expect(evaluate(parseFormula('round(nav / 7, 2)', cols), row)).toBe(42.86)
    expect(evaluate(parseFormula('max(nav, called) - min(nav, called) + abs(-1)', cols), row)).toBe(101)
  })

  it('gives no value for division by zero or a missing figure', () => {
    expect(evaluate(parseFormula('nav / called', cols), { nav: 1, called: 0 })).toBeNull()
    expect(evaluate(parseFormula('nav + called', cols), { nav: 1, called: null })).toBeNull()
  })

  it('refuses anything that is not arithmetic on result columns', () => {
    expect(() => parseFormula('nav; drop', cols)).toThrow(FormulaError)
    expect(() => parseFormula('constructor', cols)).toThrow(/not a column/)
    expect(() => parseFormula('sqrt(nav)', cols)).toThrow(/Unknown function/)
    expect(() => parseFormula('min(nav)', cols)).toThrow(/2 arguments/)
    expect(() => parseFormula('(nav', cols)).toThrow(/Expected "\)"/)
    expect(() => parseFormula('x'.repeat(301), cols)).toThrow(/at most/)
  })

  it('lets a later calculated column use an earlier one', () => {
    const out = applyComputed([{ nav: 300, called: 200, distributed: 100 }], [
      { as: 'value', formula: 'nav + distributed' },
      { as: 'tvpi', formula: 'value / called' },
    ], cols)
    expect(out[0]).toMatchObject({ value: 400, tvpi: 2 })
  })
})
