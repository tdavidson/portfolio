// lib/portfolio/quote-read.ts
//
// How stored quotes are read. quote-sync writes one row per feed per day, and the Data API returns
// at most `max_rows` (1000, supabase/config.toml) rows per request — so an unordered, unpaged read
// of a feed's quotes passes the cap within three years, and a fund-wide one within months. Past
// it, PostgREST hands back an arbitrary 1000 (in practice the oldest), `quoteAsOf` never sees the
// latest price, and a mark is struck — and checked — on a stale one.
//
// So every consumer reads either exactly the row it needs (the latest on or before a date, per
// feed) or every row, paged in a stable order. Both THROW on a failed read: no quotes is a
// meaningful state (Level 3, "enter the closing price"), so a failed read must not look like one.

import type { SupabaseClient } from '@supabase/supabase-js'
import { observationFromRow, type PriceObservation } from './quotes'

const COLUMNS = 'feed_id, as_of_date, price, basis'
const PAGE = 1000

/** Per feed, the latest observation on or before `asOf` — one ordered, single-row read each. */
export async function latestQuotesAsOf(
  admin: SupabaseClient,
  fundId: string,
  feedIds: string[],
  asOf: string,
): Promise<PriceObservation[]> {
  const reads = await Promise.all(Array.from(new Set(feedIds)).map(feedId =>
    (admin as any).from('price_observations').select(COLUMNS)
      .eq('fund_id', fundId).eq('feed_id', feedId).lte('as_of_date', asOf)
      .order('as_of_date', { ascending: false }).limit(1),
  ))
  const out: PriceObservation[] = []
  for (const { data, error } of reads as { data: unknown; error: { message: string } | null }[]) {
    if (error) throw new Error(`quotes read failed: ${error.message}`)
    const row = ((data as any[]) ?? [])[0]
    if (row) out.push(observationFromRow(row))
  }
  return out
}

/**
 * Every observation of these feeds, paged in (as_of_date, feed_id) order — for a consumer that
 * needs the price on SEVERAL dates (a statement package with comparison periods).
 */
export async function allQuotes(
  admin: SupabaseClient,
  fundId: string,
  feedIds: string[],
): Promise<PriceObservation[]> {
  if (feedIds.length === 0) return []
  const out: PriceObservation[] = []
  // Stops on an EMPTY page, not a short one: a deployment whose max_rows is below PAGE returns a
  // short page that is not the last, and stopping there would drop the latest quotes silently.
  for (let from = 0; ; ) {
    const { data, error } = await (admin as any).from('price_observations').select(COLUMNS)
      .eq('fund_id', fundId).in('feed_id', feedIds)
      .order('as_of_date', { ascending: true }).order('feed_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`quotes read failed: ${error.message}`)
    const rows = (data as any[]) ?? []
    if (rows.length === 0) return out
    out.push(...rows.map(observationFromRow))
    from += rows.length
  }
}
