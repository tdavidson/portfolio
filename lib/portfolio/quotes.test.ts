import { describe, it, expect } from 'vitest'
import {
  quoteAsOf, scaledPrice, quotedValue, feedActiveOn, discountAppliesOn,
  fairValueLevel, periodEndQuoteMarks, quoteCloseIssues, fairValueByLevel,
  STALE_QUOTE_DAYS,
  type PriceFeed, type PriceObservation, type QuotedPosition,
} from './quotes'

const feed = (o: Partial<PriceFeed> = {}): PriceFeed => ({
  id: 'f1', companyId: 'c1', kind: 'listed_equity', symbol: 'ACME',
  exchange: 'XNAS', quoteCurrency: 'USD', quoteScale: 1,
  activeFrom: '2026-01-01', activeUntil: null,
  restrictionUntil: null, restrictionDiscount: null,
  ...o,
})

const obs = (o: Partial<PriceObservation> = {}): PriceObservation => ({
  feedId: 'f1', asOfDate: '2026-03-31', price: 25, basis: 'close', ...o,
})

const position = (o: Partial<QuotedPosition> = {}): QuotedPosition => ({
  companyId: 'c1', name: 'Acme', shares: 10_000, ledgerCarrying: 0, ...o,
})

describe('feedActiveOn', () => {
  it('is inactive before the listing date — the holding still marks from its rounds', () => {
    expect(feedActiveOn(feed({ activeFrom: '2026-06-01' }), '2026-03-31')).toBe(false)
    expect(feedActiveOn(feed({ activeFrom: '2026-06-01' }), '2026-06-01')).toBe(true)
  })

  it('is inactive after a delisting', () => {
    expect(feedActiveOn(feed({ activeUntil: '2026-05-01' }), '2026-06-01')).toBe(false)
  })
})

describe('quoteAsOf', () => {
  const observations = [
    obs({ asOfDate: '2026-03-27', price: 24 }),
    obs({ asOfDate: '2026-03-30', price: 26 }),
    obs({ asOfDate: '2026-04-02', price: 30 }),
  ]

  it('takes the last quote on or before the period end, not the latest outright', () => {
    // 31 March is a Tuesday here, but the point holds regardless: a quote struck after the
    // period end must never reach back into it.
    expect(quoteAsOf(observations, 'f1', '2026-03-31')?.price).toBe(26)
  })

  it('reaches back across a closed market rather than reporting unpriced', () => {
    // Period ending Saturday 2026-03-28: the last trading day is Friday the 27th.
    expect(quoteAsOf(observations, 'f1', '2026-03-28')?.price).toBe(24)
  })

  it('returns null when nothing precedes the date', () => {
    expect(quoteAsOf(observations, 'f1', '2026-01-01')).toBeNull()
  })

  it('ignores observations belonging to another feed', () => {
    expect(quoteAsOf([obs({ feedId: 'other' })], 'f1', '2026-12-31')).toBeNull()
  })
})

describe('scaledPrice', () => {
  it('converts a GBp (pence) quote to major units', () => {
    const london = feed({ quoteCurrency: 'GBP', quoteScale: 100, exchange: 'XLON' })
    // 4,000 pence is 40 pounds. Read unscaled it is 4,000 — off by 100x and plausible.
    expect(scaledPrice(london, obs({ price: 4000 }))).toBe(40)
  })
})

describe('quotedValue', () => {
  it('is quantity times price', () => {
    expect(quotedValue(feed(), obs({ price: 25 }), 10_000, '2026-03-31')).toBe(250_000)
  })

  it('applies the lock-up discount while the restriction runs', () => {
    const locked = feed({ restrictionUntil: '2026-09-30', restrictionDiscount: 0.2 })
    expect(quotedValue(locked, obs(), 10_000, '2026-03-31')).toBe(200_000)
    // Once the lock-up lapses the position marks at the clean quote.
    expect(quotedValue(locked, obs({ asOfDate: '2026-12-31' }), 10_000, '2026-12-31')).toBe(250_000)
  })
})

describe('fairValueLevel', () => {
  it('is Level 1 for an unadjusted closing price in an active feed', () => {
    expect(fairValueLevel(feed(), obs(), '2026-03-31')).toBe(1)
  })

  it('is Level 3 with no feed or no quote — every private holding', () => {
    expect(fairValueLevel(null, null, '2026-03-31')).toBe(3)
    expect(fairValueLevel(feed(), null, '2026-03-31')).toBe(3)
  })

  it('is Level 3 before the feed goes active', () => {
    expect(fairValueLevel(feed({ activeFrom: '2026-06-01' }), obs(), '2026-03-31')).toBe(3)
  })

  it('is Level 2 on an intraday or indicative print', () => {
    expect(fairValueLevel(feed(), obs({ basis: 'intraday' }), '2026-03-31')).toBe(2)
    expect(fairValueLevel(feed(), obs({ basis: 'indicative' }), '2026-03-31')).toBe(2)
  })

  it('is Level 2 while a discounted lock-up runs, and Level 1 after it', () => {
    const locked = feed({ restrictionUntil: '2026-09-30', restrictionDiscount: 0.2 })
    expect(fairValueLevel(locked, obs(), '2026-03-31')).toBe(2)
    expect(fairValueLevel(locked, obs(), '2026-12-31')).toBe(1)
  })

  it('stays Level 1 through a lock-up a fund chose not to discount', () => {
    // Marking at the clean close is a defensible policy; it is the ADJUSTMENT that levels down.
    const undiscounted = feed({ restrictionUntil: '2026-09-30', restrictionDiscount: 0 })
    expect(fairValueLevel(undiscounted, obs(), '2026-03-31')).toBe(1)
  })
})

describe('periodEndQuoteMarks', () => {
  it('is the difference between the quoted value and what the ledger carries', () => {
    const marks = periodEndQuoteMarks(
      [position({ ledgerCarrying: 180_000 })], [feed()], [obs()], '2026-03-31',
    )
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({
      derivedCarrying: 250_000, ledgerCarrying: 180_000, delta: 70_000,
      quoteDate: '2026-03-31', level: 1,
    })
  })

  it('books nothing when the ledger already agrees', () => {
    expect(periodEndQuoteMarks(
      [position({ ledgerCarrying: 250_000 })], [feed()], [obs()], '2026-03-31',
    )).toEqual([])
  })

  it('marks a holding the ledger has never seen', () => {
    const marks = periodEndQuoteMarks([position()], [feed()], [obs()], '2026-03-31')
    expect(marks[0].delta).toBe(250_000)
  })

  it('skips a position whose feed is not active yet, rather than marking it to zero', () => {
    expect(periodEndQuoteMarks(
      [position({ ledgerCarrying: 180_000 })],
      [feed({ activeFrom: '2026-06-01' })], [obs()], '2026-03-31',
    )).toEqual([])
  })
})

describe('quoteCloseIssues', () => {
  it('passes clean when the ledger agrees with a fresh close', () => {
    const issues = quoteCloseIssues(
      [position({ ledgerCarrying: 250_000 })], [feed()], [obs()], '2026-03-31', 'USD',
    )
    expect(issues.blockers).toEqual([])
    expect(issues.warnings).toEqual([])
  })

  it('blocks on an unbooked mark', () => {
    const issues = quoteCloseIssues(
      [position({ ledgerCarrying: 180_000 })], [feed()], [obs()], '2026-03-31', 'USD',
    )
    expect(issues.blockers).toHaveLength(1)
    expect(issues.blockers[0]).toContain('Book the period-end mark first')
  })

  it('blocks when a quoted position has no price for the period', () => {
    const issues = quoteCloseIssues([position()], [feed()], [], '2026-03-31', 'USD')
    expect(issues.blockers[0]).toContain('no quote on or before 2026-03-31')
  })

  it('blocks a quote denominated in something other than the fund currency', () => {
    const london = feed({ quoteCurrency: 'GBP', quoteScale: 100 })
    const issues = quoteCloseIssues(
      [position()], [london], [obs({ price: 4000 })], '2026-03-31', 'USD',
    )
    expect(issues.blockers[0]).toContain('quoted in GBP')
    // And it does NOT also emit a mark computed in the wrong currency.
    expect(issues.blockers).toHaveLength(1)
  })

  it('warns rather than blocks on a stale quote', () => {
    const old = obs({ asOfDate: '2026-03-01' })
    const issues = quoteCloseIssues(
      [position({ ledgerCarrying: 250_000 })], [feed()], [old], '2026-03-31', 'USD',
    )
    expect(issues.blockers).toEqual([])
    expect(issues.warnings[0]).toContain('30 days before 2026-03-31')
  })

  it('tolerates a long weekend without warning', () => {
    const friday = obs({ asOfDate: '2026-03-27' })
    const issues = quoteCloseIssues(
      [position({ ledgerCarrying: 250_000 })], [feed()], [friday], '2026-03-31', 'USD',
    )
    expect(issues.warnings).toEqual([])
    expect(STALE_QUOTE_DAYS).toBeGreaterThanOrEqual(4)
  })

  it('warns that an intraday mark is not Level 1', () => {
    const issues = quoteCloseIssues(
      [position({ ledgerCarrying: 250_000 })], [feed()], [obs({ basis: 'intraday' })],
      '2026-03-31', 'USD',
    )
    expect(issues.blockers).toEqual([])
    expect(issues.warnings[0]).toContain('Level 2 rather than Level 1')
  })

  it('ignores a position with no feed — an ordinary private holding', () => {
    const issues = quoteCloseIssues([position({ companyId: 'private' })], [], [], '2026-03-31', 'USD')
    expect(issues).toEqual({ blockers: [], warnings: [], links: {} })
  })
  it('links each position blocker to the holding page at the period end, where the quote and the mark are entered', () => {
    const unbooked = quoteCloseIssues([position({ ledgerCarrying: 180_000 })], [feed()], [obs()], '2026-03-31', 'USD')
    expect(unbooked.links).toEqual({ [unbooked.blockers[0]]: '/companies/c1?asOf=2026-03-31' })
    const missing = quoteCloseIssues([position()], [feed()], [], '2026-03-31', 'USD')
    expect(missing.links[missing.blockers[0]]).toBe('/companies/c1?asOf=2026-03-31')
  })
  it('links the foreign-currency blocker too, and carries the entity being closed', () => {
    const gbp = quoteCloseIssues([position()], [feed({ quoteCurrency: 'GBP' })], [obs()], '2026-03-31', 'USD', 'v1')
    expect(gbp.blockers).toHaveLength(1)
    expect(gbp.links[gbp.blockers[0]]).toBe('/companies/c1?entity=v1&asOf=2026-03-31')
  })
})

describe('fairValueByLevel', () => {
  it('splits fair value across the hierarchy', () => {
    const out = fairValueByLevel([
      { fairValue: 250_000, level: 1 },
      { fairValue: 100_000, level: 2 },
      { fairValue: 900_000, level: 3 },
      { fairValue: 50_000, level: 3 },
    ])
    expect(out).toEqual({ level1: 250_000, level2: 100_000, level3: 950_000, total: 1_300_000 })
  })

  it('puts an all-private book entirely in Level 3', () => {
    const out = fairValueByLevel([{ fairValue: 1_000, level: 3 }])
    expect(out).toEqual({ level1: 0, level2: 0, level3: 1_000, total: 1_000 })
  })
})

describe('discountAppliesOn', () => {
  it('is false with no restriction', () => {
    expect(discountAppliesOn(feed(), '2026-03-31')).toBe(false)
  })
  it('is inclusive of the final locked day', () => {
    const locked = feed({ restrictionUntil: '2026-09-30' })
    expect(discountAppliesOn(locked, '2026-09-30')).toBe(true)
    expect(discountAppliesOn(locked, '2026-10-01')).toBe(false)
  })
})
