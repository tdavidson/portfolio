// Quoted positions — period-end valuation from an observable price, and the ASC 820 level
// that price earns.
//
// Deliberately PURE, and deliberately shaped like lib/portfolio/fof-valuation.ts: the close
// loads the inputs and splices the result into its existing blockers/warnings arrays. A fund
// of funds derives its mark from a manager NAV rolled forward; a quoted holding derives its
// mark from a price on a date. Same question, same answer shape, same place in the close.
//
// NO VALUATION MATH IS REIMPLEMENTED HERE. A quoted position is quantity x price, which is
// exactly computeSummary's priced-equity path, so a booked quote is an ordinary
// `unrealized_gain_change` carrying `current_share_price` and everything downstream — the
// schedule of investments, the statements, the per-company tie-out — reads it without
// knowing a feed exists. What this file adds is which price, on which date, and at what level.
import { holdingHref } from './holding-href'

/** ASC 820 fair value hierarchy. */
export type FairValueLevel = 1 | 2 | 3

export interface PriceFeed {
  id: string
  companyId: string
  kind: 'listed_equity' | 'digital_asset'
  symbol: string
  exchange?: string | null
  quoteCurrency: string
  /** Divisor from the quoted figure to one major currency unit. 100 for a GBp listing. */
  quoteScale: number
  activeFrom: string
  activeUntil?: string | null
  restrictionUntil?: string | null
  restrictionDiscount?: number | null
}

export interface PriceObservation {
  feedId: string
  asOfDate: string
  price: number
  basis: 'close' | 'intraday' | 'indicative'
}

/**
 * How stale a quote may be at period end before the close says so.
 *
 * FOUR CALENDAR DAYS, which sounds arbitrary and is not: a period ending on a Saturday of a
 * long weekend has its last trading day on the preceding Thursday, and a Friday-holiday close
 * pushes it further. Four days covers every ordinary market calendar and still catches a feed
 * that stopped updating. This is emphatically NOT the fund-of-funds STALE_NAV_DAYS of 100 —
 * a manager reporting 90 days late is normal, a price 90 days late is a broken pipe.
 */
export const STALE_QUOTE_DAYS = 4

const CENT = 0.005
const r2 = (n: number) => Math.round(n * 100) / 100

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

/** Is this feed the price source on `date`? Outside its window the holding marks from rounds. */
export function feedActiveOn(feed: PriceFeed, date: string): boolean {
  if (date < feed.activeFrom) return false
  if (feed.activeUntil && date > feed.activeUntil) return false
  return true
}

/**
 * The quote that prices a period ending on `periodEnd`.
 *
 * THE LAST OBSERVATION ON OR BEFORE THE DATE, never the latest one outright. Two reasons, and
 * both are silent failures otherwise. A period end lands on a weekend or a holiday more often
 * than not — "the price on 31 December" finds nothing at all when that is a Saturday, and a
 * position with a perfectly good Friday close would report unpriced. And re-closing a prior
 * period must reproduce: reaching for the newest price would mark a restated Q1 at today's.
 */
export function quoteAsOf(
  observations: PriceObservation[],
  feedId: string,
  periodEnd: string,
): PriceObservation | null {
  let best: PriceObservation | null = null
  for (const o of observations) {
    if (o.feedId !== feedId) continue
    if (o.asOfDate > periodEnd) continue
    if (!best || o.asOfDate > best.asOfDate) best = o
  }
  return best
}

/** The quoted figure in major currency units of the feed's quote currency (GBp -> GBP). */
export function scaledPrice(feed: PriceFeed, observation: PriceObservation): number {
  return observation.price / (feed.quoteScale || 1)
}

/**
 * The mark itself: quantity x price, less any discount for lack of marketability.
 *
 * `shares` must already be SPLIT-ADJUSTED — computeSummary does this for every consumer (see
 * lib/splits.ts), and passing a raw share count here is precisely the halving bug the split
 * action exists to prevent: a post-split quote against a pre-split count.
 *
 * The result is in the feed's quote currency. A feed quoting in anything but the fund's
 * currency still needs the FX path (chart accounts 1250/4300); `quoteCloseIssues` refuses to
 * derive a mark in that case rather than silently reporting foreign units as fund currency.
 */
export function quotedValue(
  feed: PriceFeed,
  observation: PriceObservation,
  shares: number,
  periodEnd: string,
): number {
  const gross = shares * scaledPrice(feed, observation)
  const discount = discountAppliesOn(feed, periodEnd) ? (feed.restrictionDiscount ?? 0) : 0
  return r2(gross * (1 - discount))
}

/** Is the holding still inside its lock-up on this date? */
export function discountAppliesOn(feed: PriceFeed, date: string): boolean {
  return !!feed.restrictionUntil && date <= feed.restrictionUntil
}

/**
 * The ASC 820 level a position earns on a date.
 *
 * Level 1 is an unadjusted quoted price in an active market. Every word of that is load-bearing:
 *   - a quote at all (an active feed with an observation) — otherwise Level 3, as every private
 *     holding in this book has always implicitly been;
 *   - the OFFICIAL CLOSE, not an intraday or indicative print, which is an input to a price
 *     rather than the price;
 *   - UNADJUSTED — the moment a lock-up discount is applied the mark is no longer the quoted
 *     price, and ASC 820 puts it at Level 2. This is why the restriction dates live on the feed
 *     and the level is derived from them rather than typed by hand: a level that can be typed
 *     is a level that will be wrong on the one position anybody checks.
 */
export function fairValueLevel(
  feed: PriceFeed | null,
  observation: PriceObservation | null,
  date: string,
): FairValueLevel {
  if (!feed || !observation) return 3
  if (!feedActiveOn(feed, date)) return 3
  if (observation.basis !== 'close') return 2
  if (discountAppliesOn(feed, date) && (feed.restrictionDiscount ?? 0) > 0) return 2
  return 1
}

export interface QuotedPosition {
  companyId: string
  name: string
  /** Split-adjusted share/unit count as of the period end. */
  shares: number
  /** What the ledger carries for this holding today (1100 + 1200). */
  ledgerCarrying: number
}

export interface PendingQuoteMark {
  companyId: string
  name: string
  feedId: string
  symbol: string
  periodEnd: string
  /** The observation the mark is struck on, so the close can show its date and staleness. */
  quoteDate: string
  price: number
  shares: number
  derivedCarrying: number
  ledgerCarrying: number
  /** What to book as unrealized_value_change. */
  delta: number
  level: FairValueLevel
}

/**
 * Period-end marks a quoted book still owes, mirroring fof-valuation's periodEndMarks.
 *
 * A position whose feed is not yet active on the period end is skipped entirely, not marked at
 * zero: before its listing date the holding is priced by its rounds like any other private
 * position, and that is the whole point of the feed being dated.
 */
export function periodEndQuoteMarks(
  positions: QuotedPosition[],
  feeds: PriceFeed[],
  observations: PriceObservation[],
  periodEnd: string,
): PendingQuoteMark[] {
  const marks: PendingQuoteMark[] = []
  const byCompany = new Map(feeds.map(f => [f.companyId, f]))

  for (const p of positions) {
    const feed = byCompany.get(p.companyId)
    if (!feed || !feedActiveOn(feed, periodEnd)) continue
    const obs = quoteAsOf(observations, feed.id, periodEnd)
    if (!obs) continue

    const derived = quotedValue(feed, obs, p.shares, periodEnd)
    const delta = r2(derived - p.ledgerCarrying)
    if (Math.abs(delta) < CENT) continue

    marks.push({
      companyId: p.companyId,
      name: p.name,
      feedId: feed.id,
      symbol: feed.symbol,
      periodEnd,
      quoteDate: obs.asOfDate,
      price: scaledPrice(feed, obs),
      shares: p.shares,
      derivedCarrying: derived,
      ledgerCarrying: p.ledgerCarrying,
      delta,
      level: fairValueLevel(feed, obs, periodEnd),
    })
  }
  return marks
}

/**
 * The quoted half of the pre-close check. Pure, for the same reason fofCloseIssues is:
 * `lib/accounting/close.ts` owns loading and `closeThrough` already refuses to close on a
 * non-empty `blockers`. No new rule engine.
 *
 * THE SEVERITY SPLIT IS THE POLICY.
 *
 * A MISSING period-end quote blocks. There is no defensible number for a listed position with
 * no price — marking it at its last round would report a public company at a private valuation.
 *
 * An UNBOOKED mark blocks, exactly as it does for a fund of funds: the ledger is the control
 * total for the schedule of investments, so closing without it publishes a NAV no posting
 * supports.
 *
 * A STALE quote warns rather than blocks. A market can genuinely be shut for days, and a fund
 * that cannot close over a long weekend is a fund that cannot close.
 *
 * A NON-CLOSE basis warns: an intraday print is a real price and a defensible mark, it just
 * is not a Level 1 one, and the leveling breakout will say so.
 *
 * A FOREIGN-CURRENCY quote blocks, because it is the one case where proceeding produces a
 * confident wrong number rather than a missing one — 40,000 pence reported as 40,000 pounds
 * ties out against nothing and looks entirely plausible.
 */
export function quoteCloseIssues(
  positions: QuotedPosition[],
  feeds: PriceFeed[],
  observations: PriceObservation[],
  periodEnd: string,
  fundCurrency: string,
  vehicleId?: string | null,
): { blockers: string[]; warnings: string[]; links: Record<string, string> } {
  const blockers: string[] = []
  const warnings: string[] = []
  // Each position's blocker names the page where it is cleared: the holding's own, which carries
  // its feed, its quotes and the mark to book (plans/spec-ledger-one-writer.md §6) — opened at the
  // period end, so the mark it offers is this period's, not today's.
  const links: Record<string, string> = {}
  const block = (companyId: string, text: string) => { blockers.push(text); links[text] = holdingHref(companyId, vehicleId, periodEnd) }
  const byCompany = new Map(feeds.map(f => [f.companyId, f]))
  // Positions whose feed is unusable. They are reported ONCE, as the blocker below, and then
  // held back from the mark pass — otherwise the same position also produces a derived mark
  // computed from a price in the wrong currency, which is the confident-wrong-number this
  // check exists to prevent.
  const unusable = new Set<string>()

  for (const p of positions) {
    const feed = byCompany.get(p.companyId)
    if (!feed || !feedActiveOn(feed, periodEnd)) continue

    if (feed.quoteCurrency !== fundCurrency) {
      unusable.add(p.companyId)
      block(p.companyId,
        `${p.name} (${feed.symbol}) is quoted in ${feed.quoteCurrency} but the fund reports in `
        + `${fundCurrency}. Translating a quote is not yet supported — remove the feed and mark `
        + `this position by hand for now.`
      )
      continue
    }

    const obs = quoteAsOf(observations, feed.id, periodEnd)
    if (!obs) {
      block(p.companyId,
        `${p.name} (${feed.symbol}) has no quote on or before ${periodEnd}. A quoted position `
        + `cannot be marked at its last round — enter the closing price for the period.`
      )
      continue
    }

    const age = daysBetween(obs.asOfDate, periodEnd)
    if (age > STALE_QUOTE_DAYS) {
      warnings.push(
        `${p.name} (${feed.symbol}) is being marked on its ${obs.asOfDate} price, ${age} days `
        + `before ${periodEnd}. Check the feed is still updating.`
      )
    }
    if (obs.basis !== 'close') {
      warnings.push(
        `${p.name} (${feed.symbol}) is marked on ${an(obs.basis)} price rather than the official `
        + `close, so it is Level 2 rather than Level 1 in the fair value hierarchy.`
      )
    }
  }

  const markable = positions.filter(p => !unusable.has(p.companyId))
  for (const m of periodEndQuoteMarks(markable, feeds, observations, periodEnd)) {
    block(m.companyId,
      `${m.name} (${m.symbol}): the ledger carries ${m.ledgerCarrying.toFixed(2)} but `
      + `${m.shares.toLocaleString('en-US')} units at ${m.price} on ${m.quoteDate} value at `
      + `${m.derivedCarrying.toFixed(2)}. Book the period-end mark first.`
    )
  }

  return { blockers, warnings, links }
}

const an = (basis: string) => (basis === 'intraday' ? 'an intraday' : 'an indicative')

/**
 * Fair value by ASC 820 level — the disclosure the schedule of investments owes once any
 * position is quoted.
 *
 * Until this feature there was no leveling anywhere in the app, and that was CORRECT: every
 * holding in a private book is Level 3 and a table saying so adds nothing. It stops being
 * correct the moment one position has a quote, because then the reader cannot tell which is
 * which — and an SOI carrying a listed holding with no leveling is an audit comment.
 */
export function fairValueByLevel(
  rows: { fairValue: number; level: FairValueLevel }[],
): { level1: number; level2: number; level3: number; total: number } {
  const out = { level1: 0, level2: 0, level3: 0, total: 0 }
  for (const row of rows) {
    if (row.level === 1) out.level1 += row.fairValue
    else if (row.level === 2) out.level2 += row.fairValue
    else out.level3 += row.fairValue
    out.total += row.fairValue
  }
  return { level1: r2(out.level1), level2: r2(out.level2), level3: r2(out.level3), total: r2(out.total) }
}

/**
 * Stamp each position with the ASC 820 level its price earns on `asOf`.
 *
 * Generic over the position shape so this file never imports the schedule of investments —
 * soi.ts imports the LEVEL TYPE from here and nothing flows the other way, which keeps the
 * two modules acyclic. Anything without an active feed comes back Level 3, which is both the
 * correct answer for a private holding and the correct answer for "we don't know".
 */
export function withFairValueLevels<T extends { companyId: string }>(
  positions: T[],
  feeds: PriceFeed[],
  observations: PriceObservation[],
  asOf: string,
): (T & { valuationLevel: FairValueLevel })[] {
  const byCompany = new Map(feeds.map(f => [f.companyId, f]))
  return positions.map(p => {
    const feed = byCompany.get(p.companyId) ?? null
    const obs = feed ? quoteAsOf(observations, feed.id, asOf) : null
    return { ...p, valuationLevel: fairValueLevel(feed, obs, asOf) }
  })
}

/** A price_feeds row in the shape the valuation reads. */
export function feedFromRow(f: any): PriceFeed {
  return {
    id: f.id,
    companyId: f.company_id,
    kind: f.kind,
    symbol: f.symbol,
    exchange: f.exchange ?? null,
    quoteCurrency: f.quote_currency,
    quoteScale: Number(f.quote_scale ?? 1),
    activeFrom: f.active_from,
    activeUntil: f.active_until ?? null,
    restrictionUntil: f.restriction_until ?? null,
    restrictionDiscount: f.restriction_discount == null ? null : Number(f.restriction_discount),
  }
}

/** A price_observations row in the shape the valuation reads. */
export function observationFromRow(o: any): PriceObservation {
  return { feedId: o.feed_id, asOfDate: o.as_of_date, price: Number(o.price), basis: o.basis }
}
