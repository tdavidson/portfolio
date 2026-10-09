import { describe, expect, it } from 'vitest'
import { monthRange } from './months'
import { evaluateRule, validateRule } from './rules'
import { historyWindow, suggestRule } from './suggest'

const TWO_YEARS = monthRange('2024-10', '2026-09')
const closed = { closedFrom: '2024-10', closedThrough: '2026-09' }
const series = (f: (m: string, i: number) => number) => new Map(TWO_YEARS.map((m, i) => [m, f(m, i)] as [string, number]).filter(([, v]) => v !== 0))

describe('historyWindow', () => {
  it('reads at least 12 and at most 36 closed months, never before the books start', () => {
    expect(historyWindow('2020-01', '2026-09', 3)).toHaveLength(12)
    expect(historyWindow('2020-01', '2026-09', 99)).toHaveLength(36)
    expect(historyWindow('2026-01', '2026-09', 24)[0]).toBe('2026-01')
    expect(historyWindow(null, null)).toEqual([])
  })
})

describe('suggestRule', () => {
  it('sees an annual bill twice and calls it recurring, with its escalation', () => {
    const s = suggestRule({ actuals: series(m => (m.endsWith('-03') ? (m.startsWith('2025') ? 12000 : 12600) : 0)), ...closed })!
    expect(s).toMatchObject({ method: 'recurring', confidence: 'high', params: { amount: 12600, everyMonths: 12, anchor: '2026-03', annualEscalation: 0.05 } })
    expect(s.evidence).toContain('12,000 in Mar 2025')
  })

  it('a quarterly charge from February', () => {
    const s = suggestRule({ actuals: series(m => (['02', '05', '08', '11'].includes(m.slice(5)) ? 5000 : 0)), ...closed })!
    expect(s).toMatchObject({ method: 'recurring', params: { everyMonths: 3, amount: 5000 } })
    const r = evaluateRule(validateRule(s.method, s.params), monthRange('2026-10', '2027-09'), { actuals: new Map(), closedFrom: null, closedThrough: null, cutoff: null })
    expect([...r.amounts.keys()]).toEqual(['2026-11', '2027-02', '2027-05', '2027-08'])
  })

  it('an annual bill seen once is suggested, flagged as unconfirmed', () => {
    const s = suggestRule({ actuals: new Map([['2026-03', 9000]]), closedFrom: '2025-10', closedThrough: '2026-09' })!
    expect(s).toMatchObject({ method: 'recurring', confidence: 'low' })
    expect(s.warnings[0]).toMatch(/Seen once/)
  })

  it('payroll with a December bonus is seasonal, carried forward with its growth', () => {
    const s = suggestRule({ actuals: series(m => (m.startsWith('2024') || m < '2025-10' ? 40000 : 42000) + (m.endsWith('-12') ? 30000 : 0)), ...closed })!
    expect(s.method).toBe('seasonal')
    expect(s.confidence).toBe('high')
    expect((s.params.profile as any)['12']).toBe(72000)
    const r = evaluateRule(validateRule(s.method, s.params), ['2026-11', '2026-12'], { actuals: new Map(), closedFrom: null, closedThrough: null, cutoff: null })
    expect(r.amounts.get('2026-12')).toBe(72000)
  })

  it('a steady cost is a 12-month run rate', () => {
    expect(suggestRule({ actuals: series(() => 3000), ...closed })).toMatchObject({ method: 'run_rate', params: { window: 12 }, confidence: 'high' })
  })

  it('a steady climb is growth', () => {
    const s = suggestRule({ actuals: series((_, i) => 1000 * Math.pow(1.02, i)), ...closed })!
    expect(s.method).toBe('growth')
    expect(s.params.rate).toBeCloseTo(0.02, 2)
  })

  it('a step change uses the recent level and says so', () => {
    const s = suggestRule({ actuals: series(m => (m >= '2026-07' ? 8000 : 5000)), ...closed })!
    expect(s).toMatchObject({ method: 'run_rate', params: { window: 3 } })
    expect(s.warnings.join()).toMatch(/step change/)
  })

  it('scattered spend is a low-confidence average that says it smooths', () => {
    const s = suggestRule({ actuals: new Map([['2025-01', 500], ['2025-04', 300], ['2025-05', 700], ['2026-02', 400], ['2026-08', 900]]), ...closed })!
    expect(s).toMatchObject({ method: 'run_rate', confidence: 'low' })
    expect(s.warnings.join()).toMatch(/Spread evenly/)
  })

  it('short history cannot see a cycle, and says why', () => {
    const s = suggestRule({ actuals: new Map([['2026-07', 100], ['2026-08', 100], ['2026-09', 100]]), closedFrom: '2026-07', closedThrough: '2026-09' })!
    expect(s.confidence).toBe('low')
    expect(s.warnings[0]).toMatch(/Only 3 closed months/)
  })

  it('suggests nothing for an account that never moved', () => {
    expect(suggestRule({ actuals: new Map(), ...closed })).toBeNull()
  })
})
