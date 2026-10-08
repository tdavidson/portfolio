import type { PriceFeed } from '../quotes'
import type { QuoteProvider, QuoteResult, ProviderContext } from './types'

export type { QuoteProvider, QuoteResult, ProviderContext } from './types'

// ---------------------------------------------------------------------------
// Where quotes come from.
//
// NO LIVE VENDOR IS WIRED UP, deliberately. Prices are entered by hand today, which is a
// perfectly good answer for a handful of positions and costs nothing to run or audit. What
// exists here is the SEAM: the shape an adapter has to satisfy, and the one place it registers.
//
// ADDING A VENDOR is a new file and a line in PROVIDERS below. Nothing else changes — not the
// schema, not the close, not the valuation. `price_feeds.provider` already stores which adapter
// a feed uses, `price_observations` already records where each stored price came from, and
// syncFundQuotes (quote-sync.ts) is what a scheduled job calls once a vendor is registered — no route calls it while hand entry is the only provider.
//
// The candidates worth looking at, and what each is good for:
//   - Massive (massive.com) — what Polygon.io became. Daily closes plus a corporate-actions
//     feed, which is the piece that would let a split be DETECTED rather than typed in.
//   - EOD Historical Data — broad global exchange coverage, so a London or Euronext listing
//     works with the MIC and the GBp quote_scale the feed already carries.
//   - CoinGecko or similar for digital assets, which are a different market and a different
//     vendor from listed equities.
//
// An adapter must satisfy exactly one rule beyond the interface: it returns a price and the
// date that price belongs to, and NOTHING else. Scaling, FX, lock-up discounts and ASC 820
// leveling all live in lib/portfolio/quotes.ts. A provider that starts adjusting prices is a
// second, drifted copy of the valuation rules, and the whole point of this boundary is that
// there cannot be one.
// ---------------------------------------------------------------------------

/**
 * Prices entered by hand — the only provider today, and a real one rather than a placeholder.
 *
 * It fetches nothing, so a manual feed is never asked. Its observations are stored, sourced and
 * levelled exactly like a fetched one would be: the close cannot tell them apart, and neither
 * can the schedule of investments.
 */
const manualProvider: QuoteProvider = {
  name: 'manual',
  async fetch() { return new Map<string, QuoteResult>() },
}

const PROVIDERS: Record<string, QuoteProvider> = {
  manual: manualProvider,
  // Register a vendor adapter here. See the note above for the contract.
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS)

export function providerFor(name: string | null | undefined): QuoteProvider {
  return PROVIDERS[name ?? 'manual'] ?? manualProvider
}

export interface ResolvedQuote extends QuoteResult {
  feedId: string
}

/**
 * Fetch quotes for a set of feeds, grouping by provider so each is called once.
 *
 * A provider that THROWS takes down only its own group — the others still return. A quote run
 * is a best-effort background refresh, and one vendor's outage must not stop a fund's other
 * positions from being priced. What it must never do is invent a price to paper over the
 * failure: the feeds that could not be reached are simply absent, and the close says so.
 *
 * With only the manual provider registered this returns nothing, which is correct rather than
 * broken — there is no one to ask.
 */
export async function resolveQuotes(
  feeds: PriceFeed[],
  ctx: ProviderContext,
  providerByFeed: Map<string, string>,
): Promise<{ quotes: ResolvedQuote[]; errors: string[] }> {
  const groups = new Map<string, PriceFeed[]>()
  for (const feed of feeds) {
    const name = providerByFeed.get(feed.id) ?? 'manual'
    if (name === 'manual') continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push(feed)
  }

  const quotes: ResolvedQuote[] = []
  const errors: string[] = []

  for (const [name, group] of Array.from(groups.entries())) {
    try {
      const got = await providerFor(name).fetch(group, ctx)
      for (const [feedId, quote] of Array.from(got.entries())) quotes.push({ feedId, ...quote })
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? 'fetch failed'}`)
    }
  }

  return { quotes, errors }
}
