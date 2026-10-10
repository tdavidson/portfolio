import { describe, it, expect } from 'vitest'
import { DASH, clockTime, createFormatters, fractionPercent, multiple, percent, share, shortDate, titleCase } from './format'

describe('dashboard formatters', () => {
  const fmt = createFormatters('USD', 'en-US')

  it('writes money in whole units with negatives in parentheses', () => {
    expect(fmt.money(1234567.4)).toBe('$1,234,567')
    expect(fmt.money(-800000)).toBe('($800,000)')
    expect(fmt.money(0)).toBe('$0')
  })

  it('never shows a negative zero', () => {
    expect(fmt.money(-0)).toBe('$0')
    expect(fmt.compact(-0)).toBe('$0')
  })

  it('compacts tiles and bar labels', () => {
    expect(fmt.compact(27_190_000)).toBe('$27.2M')
    expect(fmt.compact(620_000)).toBe('$620K')
  })

  it('keeps the cents on a share price, and four decimals on a sub-dollar one', () => {
    expect(fmt.price(4.2)).toBe('$4.20')
    expect(fmt.price(0.0375)).toBe('$0.0375')
  })

  it('renders a missing figure as a dash, not as zero', () => {
    // A null TVPI means nothing has been called. "0.00x" would say the fund lost everything.
    for (const v of [null, undefined, NaN, Infinity]) {
      expect(fmt.money(v)).toBe(DASH)
      expect(fmt.compact(v)).toBe(DASH)
      expect(multiple(v)).toBe(DASH)
      expect(percent(v)).toBe(DASH)
      expect(fractionPercent(v)).toBe(DASH)
    }
  })

  it('formats multiples and percentages', () => {
    expect(multiple(1.837)).toBe('1.84x')
    expect(percent(12.44)).toBe('12.4%')
    // IRRs are stored as fractions.
    expect(fractionPercent(0.214)).toBe('21.4%')
  })

  it('takes a share only of a positive denominator', () => {
    expect(share(725, 1000)).toBe(72.5)
    expect(share(10, 0)).toBeNull()
  })

  it('survives a currency or locale it does not know', () => {
    expect(() => createFormatters('NOT-A-CODE', 'xx-invalid-locale-tag-')).not.toThrow()
    expect(createFormatters('NOT-A-CODE').money(1500)).toContain('1,500')
  })

  it('reads an ISO date as the calendar day it names, whatever the viewer\'s time zone', () => {
    // new Date('2026-10-09') is midnight UTC: the 8th in New York. A statement "as of" the wrong
    // day is wrong, so the date is parsed by hand.
    expect(shortDate('2026-10-09')).toBe('9 Oct 2026')
    expect(shortDate('2026-01-31T23:59:59Z')).toBe('31 Jan 2026')
    expect(shortDate(null)).toBe(DASH)
    expect(shortDate('not a date')).toBe(DASH)
    expect(shortDate('2026-13-01')).toBe(DASH)
  })

  it('gives an empty time for an unreadable timestamp', () => {
    expect(clockTime('nope')).toBe('')
    expect(clockTime('2026-10-09T18:14:00.000Z', 'en-US')).toMatch(/\d{1,2}:14/)
  })

  it('title-cases a status', () => {
    expect(titleCase('written_off')).toBe('Written off')
    expect(titleCase('active')).toBe('Active')
    expect(titleCase(null)).toBe('')
  })
})
