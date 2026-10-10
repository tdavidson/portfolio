// When each vehicle closed, for the event-driven filings (Form D, Blue Sky) that fall due after a
// close.
//
// A close is a CLOSING on the vehicle's allocation terms (`vehicle_closings`). Closes used to be
// read from `fund_cash_flows` commitment rows, which nothing writes any more since the Funds
// cash-flow page went — so on every newer fund the calendar placed no event-driven filings at
// all. Those legacy rows are still read, so a fund that recorded its closes that way keeps them;
// the two are merged and a date in both counts once.

import type { SupabaseClient } from '@supabase/supabase-js'

type Result = { data: unknown; error: { message: string } | null }
const PAGE = 1000

/**
 * Vehicle name → its close dates (YYYY-MM-DD, ascending, distinct) within [from, to].
 *
 * A failed read THROWS, naming the table (`errorPrefix` lets the reminders digest keep its own
 * wording): an empty result would mean "no closes", and a digest built on that is a wrong one.
 * Reads page past PostgREST's 1000-row cap in a stable order.
 */
export async function loadCloseDates(
  admin: SupabaseClient, fundId: string, from: string, to: string, opts: { errorPrefix?: string } = {},
): Promise<Record<string, string[]>> {
  const db = admin as any
  const rowsOf = <T>(table: string, res: Result): T[] => {
    if (res?.error) throw new Error(`${opts.errorPrefix ?? ''}${table} load failed: ${res.error.message}`)
    return ((res?.data ?? []) as T[])
  }
  const allRows = async <T>(table: string, page: (lo: number, hi: number) => PromiseLike<Result>): Promise<T[]> => {
    const out: T[] = []
    for (let lo = 0; ; lo += PAGE) {
      const rows = rowsOf<T>(table, await page(lo, lo + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }
  const [closings, vehicles, legacy] = await Promise.all([
    allRows<{ vehicle_id: string; close_date: string }>('vehicle_closings', (lo, hi) =>
      db.from('vehicle_closings').select('vehicle_id, close_date')
        .eq('fund_id', fundId).gte('close_date', from).lte('close_date', to)
        .order('close_date').order('id').range(lo, hi)),
    db.from('fund_vehicles').select('id, name').eq('fund_id', fundId).then((r: Result) => rowsOf<{ id: string; name: string }>('fund_vehicles', r)),
    allRows<{ portfolio_group: string; flow_date: string }>('fund_cash_flows', (lo, hi) =>
      db.from('fund_cash_flows').select('portfolio_group, flow_date')
        .eq('fund_id', fundId).eq('flow_type', 'commitment').gte('flow_date', from).lte('flow_date', to)
        .order('flow_date').order('id').range(lo, hi)),
  ])
  const nameOf = new Map<string, string>((vehicles as { id: string; name: string }[]).map(v => [v.id, v.name]))

  const sets: Record<string, Set<string>> = {}
  const add = (group: string | undefined | null, date: string | null | undefined) => {
    if (!group || !date) return
    ;(sets[group] ??= new Set()).add(String(date).slice(0, 10))
  }
  for (const c of closings) add(nameOf.get(c.vehicle_id), c.close_date)
  for (const f of legacy) add(f.portfolio_group, f.flow_date)

  return Object.fromEntries(Object.entries(sets).map(([g, s]) => [g, [...s].sort()]))
}

/** Close dates → the months (1–12) with a close, per vehicle, for one year's calendar. */
export function closeMonthsFor(closeDates: Record<string, string[]>, year: number): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [group, dates] of Object.entries(closeDates)) {
    const months = [...new Set(dates.filter(d => d.startsWith(`${year}-`)).map(d => Number(d.slice(5, 7))))]
    if (months.length) out[group] = months.sort((a, b) => a - b)
  }
  return out
}
