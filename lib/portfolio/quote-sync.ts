import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveQuotes } from './quote-providers'
import { feedActiveOn, type PriceFeed } from './quotes'

// ---------------------------------------------------------------------------
// Refreshing a fund's stored quotes from whatever provider is registered.
//
// Provider-agnostic on purpose: this walks the feeds, asks the registry, and stores what comes
// back. With only hand entry registered it finds nothing to ask and does nothing, which is the
// correct behaviour rather than a stub — and the day an adapter lands, this needs no changes.
//
// It WRITES OBSERVATIONS AND NOTHING ELSE. It does not mark a position, post an entry, or touch
// the ledger — a price arriving from a provider is a fact about a market, not authority to
// restate a fund's NAV. Turning stored quotes into marks stays a deliberate act on
// the holding's page (POST /api/companies/[id]/price-feed, action 'book'), one entity at a time.
// ---------------------------------------------------------------------------

export interface SyncResult {
  fundId: string
  fetched: number
  stored: number
  errors: string[]
}

/** Feeds worth asking a provider about today: active, and not priced by hand. */
export function syncableFeeds(feeds: PriceFeed[], providers: Map<string, string>, today: string): PriceFeed[] {
  return feeds.filter(f => feedActiveOn(f, today) && (providers.get(f.id) ?? 'manual') !== 'manual')
}

/** The DB row shape, mapped to the domain type the valuation code uses. */
export function feedFromRow(f: any): PriceFeed {
  return {
    id: f.id,
    companyId: f.company_id,
    kind: f.kind,
    symbol: f.symbol,
    exchange: f.exchange,
    quoteCurrency: f.quote_currency,
    quoteScale: Number(f.quote_scale ?? 1),
    activeFrom: f.active_from,
    activeUntil: f.active_until,
    restrictionUntil: f.restriction_until,
    restrictionDiscount: f.restriction_discount == null ? null : Number(f.restriction_discount),
  }
}

/**
 * Refresh one fund's quotes.
 *
 * Never throws. A sync is a background refresh: one fund's lapsed credential or unreachable
 * vendor must not take down the run for every other fund.
 */
export async function syncFundQuotes(
  admin: SupabaseClient,
  fundId: string,
  today: string,
): Promise<SyncResult> {
  const result: SyncResult = { fundId, fetched: 0, stored: 0, errors: [] }

  const { data: feedRows } = await (admin as any)
    .from('price_feeds').select('*').eq('fund_id', fundId)
  const rows = ((feedRows as any[]) ?? [])
  if (rows.length === 0) return result

  const feeds = rows.map(feedFromRow)
  const providerByFeed = new Map<string, string>(rows.map(f => [f.id as string, (f.provider ?? 'manual') as string]))

  const due = syncableFeeds(feeds, providerByFeed, today)
  if (due.length === 0) return result

  const { quotes, errors } = await resolveQuotes(due, { fundId }, providerByFeed)
  result.errors.push(...errors)
  result.fetched = quotes.length

  // A quote dated in the FUTURE is refused. A misconfigured adapter can return tomorrow's date,
  // and an observation ahead of the period end would be picked up by `quoteAsOf` for a period it
  // has no business pricing.
  const usable = quotes.filter(q => {
    if (q.asOfDate > today) {
      result.errors.push(`Ignored a quote dated ${q.asOfDate}, which is in the future.`)
      return false
    }
    return true
  })

  if (usable.length > 0) {
    // Upsert on (feed_id, as_of_date): re-running the sync on the same day REPLACES the day's
    // observation rather than accumulating duplicates that would then race by insertion order.
    const { error } = await (admin as any)
      .from('price_observations')
      .upsert(
        usable.map(q => ({
          fund_id: fundId,
          feed_id: q.feedId,
          as_of_date: q.asOfDate,
          price: q.price,
          basis: q.basis,
          source: providerByFeed.get(q.feedId) ?? 'manual',
        })),
        { onConflict: 'feed_id,as_of_date' },
      )
    if (error) result.errors.push(`Storing quotes failed: ${error.message}`)
    else result.stored = usable.length
  }

  return result
}
