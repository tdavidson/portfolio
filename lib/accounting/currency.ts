// The fund's reporting currency — the denomination of its books.
//
// THE LEDGER IS SINGLE-CURRENCY, AND THAT IS DELIBERATE.
//
// A fund reports in one currency. A position held in another moves for two unrelated reasons:
// the company changed value, and the exchange rate changed. The chart already separates those
// (1200/4200 for the mark, 1250/4300 for the translation — see chart.ts), which is the ASC 830
// treatment. So a foreign investment is translated into the fund's currency at the point it is
// booked, and the rate movement gets its own asset and its own income line. There is never a
// posting denominated in anything but the fund's currency.
//
// This is why `assertBalanced` checks the zero-sum PER CURRENCY: not because we expect several,
// but so that a posting in the wrong one can't silently balance against the right ones.
//
// What was broken: every writer hardcoded 'USD'. A fund whose `fund_settings.currency` was EUR
// had a EUR portfolio tracker, EUR statements, EUR LP reports — and a ledger whose postings all
// claimed to be dollars. `persistEntry` now stamps the fund's currency on every posting, so a
// caller cannot get this wrong.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * MODULE-LEVEL memo, shared by every request this server instance handles — not per request. A
 * fund's currency rarely changes, and persistEntry is hot; the settings route calls
 * forgetFundCurrency when it does change. Only a SUCCESSFUL read is cached.
 */
const cache = new Map<string, string>()

/**
 * THROWS on a failed read. Falling back to USD stamped USD on a EUR fund's postings — and, cached,
 * on every entry the instance wrote afterwards. A fund with no settings row (or no currency set)
 * is USD by default; that is a successful read.
 */
export async function fundCurrency(admin: SupabaseClient, fundId: string): Promise<string> {
  const hit = cache.get(fundId)
  if (hit) return hit

  const { data, error } = await admin
    .from('fund_settings' as any)
    .select('currency')
    .eq('fund_id', fundId)
    .maybeSingle()
  if (error) throw new Error(`The fund's currency could not be read: ${error.message}`)

  const currency = ((data as any)?.currency as string) || 'USD'
  cache.set(fundId, currency)
  return currency
}

/** Drop a fund from the cache — call after its currency setting changes. */
export function forgetFundCurrency(fundId: string): void {
  cache.delete(fundId)
}
