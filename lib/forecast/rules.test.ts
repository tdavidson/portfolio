import { describe, expect, it } from 'vitest'
import { aggregateFlow, monthRange, periods } from './months'
import { evaluateRule, RuleError, validateRule, type HistoryContext } from './rules'

const NO_HISTORY: HistoryContext = { actuals: new Map(), closedFrom: null, closedThrough: null, cutoff: null }
const YEAR = monthRange('2026-01', '2026-12')

const run = (method: string, params: unknown, months = YEAR, history = NO_HISTORY) =>
  evaluateRule(validateRule(method, params), months, history)

describe('recurring schedules (acceptance #2)', () => {
  const tax = run('recurring', { amount: 12000, everyMonths: 12, anchor: '2026-03' })
  const consulting = run('recurring', { amount: 5000, everyMonths: 3, anchor: '2026-02' })

  it('lands $12,000 tax prep only in March', () => {
    expect([...tax.amounts]).toEqual([['2026-03', 12000]])
  })

  it('lands $5,000 consulting every third month from February', () => {
    expect([...consulting.amounts.keys()]).toEqual(['2026-02', '2026-05', '2026-08', '2026-11'])
  })

  it('totals by quarter and year without smoothing', () => {
    const q = periods('2026-01', '2026-12', 'quarter')
    expect(aggregateFlow(tax.amounts, q)).toEqual([12000, 0, 0, 0])
    expect(aggregateFlow(consulting.amounts, q)).toEqual([5000, 5000, 5000, 5000])
    expect(aggregateFlow(consulting.amounts, periods('2026-01', '2026-12', 'year'))).toEqual([20000])
  })

  it('runs backwards from the anchor too', () => {
    const r = run('recurring', { amount: 9600, everyMonths: 12, anchor: '2027-09' })
    expect([...r.amounts.keys()]).toEqual(['2026-09'])
  })

  it('escalates once per full year after the anchor, skips exceptions, adds one-offs', () => {
    const r = run(
      'recurring',
      { amount: 1000, everyMonths: 6, anchor: '2026-01', annualEscalation: 0.1, exceptions: ['2026-07'], oneOffs: [{ month: '2026-07', amount: 250 }] },
      monthRange('2026-01', '2027-07'),
    )
    expect([...r.amounts]).toEqual([['2026-01', 1000], ['2026-07', 250], ['2027-01', 1100], ['2027-07', 1100]])
  })
})

describe('run rate (acceptance #3)', () => {
  const actuals = new Map([
    ['2026-01', 100], ['2026-02', 200], ['2026-03', 300], ['2026-04', 900], ['2026-05', 900],
  ])

  it('averages closed months only, and says which it left out', () => {
    const r = run('run_rate', { window: 6 }, ['2026-06'], { actuals, closedFrom: '2026-01', closedThrough: '2026-03', cutoff: '2026-05' })
    expect(r.amounts.get('2026-06')).toBe(200)
    expect(r.warnings.some(w => w.includes('unclosed') && w.includes('2026-04–2026-05'))).toBe(true)
    expect(r.warnings.some(w => w.includes('3 of 6'))).toBe(true)
  })

  it('counts a closed month with no postings as zero', () => {
    const r = run('run_rate', { window: 3 }, ['2026-04'], { actuals: new Map([['2026-01', 300]]), closedFrom: '2026-01', closedThrough: '2026-03', cutoff: '2026-03' })
    expect(r.amounts.get('2026-04')).toBe(100)
  })

  it('produces nothing rather than zero when nothing is eligible', () => {
    const r = run('run_rate', { window: 3 }, ['2026-04'], { actuals, closedFrom: null, closedThrough: null, cutoff: '2026-03' })
    expect(r.amounts.size).toBe(0)
    expect(r.warnings).toContain('No eligible months to average')
  })

  it('can include unclosed months when asked', () => {
    const r = run('run_rate', { window: 3, includeUnclosed: true }, ['2026-06'], { actuals, closedFrom: '2026-01', closedThrough: '2026-03', cutoff: '2026-05' })
    expect(r.amounts.get('2026-06')).toBe(700)
  })
})

describe('other methods', () => {
  it('fixed respects its window', () => {
    expect([...run('fixed', { amount: 50, start: '2026-11' }).amounts.keys()]).toEqual(['2026-11', '2026-12'])
  })

  it('manual leaves unentered months absent', () => {
    expect([...run('manual', { amounts: { '2026-04': 10 } }).amounts]).toEqual([['2026-04', 10]])
  })

  it('growth compounds monthly or steps annually', () => {
    const monthly = run('growth', { base: 100, baseMonth: '2026-01', rate: 0.01, per: 'month' }, ['2026-03'])
    expect(monthly.amounts.get('2026-03')).toBe(102.01)
    const annual = run('growth', { base: 100, baseMonth: '2026-01', rate: 0.1, per: 'year' }, ['2026-12', '2027-01'])
    expect([...annual.amounts.values()]).toEqual([100, 110])
  })
})

describe('validation', () => {
  it('rejects unknown and not-yet-available methods with a field-level message', () => {
    expect(() => validateRule('magic', {})).toThrow(RuleError)
    expect(() => validateRule('linked_construction', { flow: 'carry' })).toThrow(/flow/)
    expect(() => validateRule('recurring', { amount: 1, everyMonths: 0, anchor: '2026-01' })).toThrow(/everyMonths/)
    expect(() => validateRule('fixed', { amount: 'x' })).toThrow(/amount/)
    expect(() => validateRule('run_rate', { window: 4 })).toThrow(/window/)
  })
})
