// Cost transfers in the readers: pure helpers, no I/O.
//
// A cost transfer moves basis from one holding to another inside one entity, with no cash and no
// gain: one journal entry (Dr Investment — target / Cr Investment — source) owning two
// `cost_transfer` rows, investment_cost −amount on the source and +amount on the target.
//
// What every reader must keep straight:
//   - it is NEVER proceeds: no realized amount, no realized gain, no distribution;
//   - on the source it REDUCES invested capital and remaining cost;
//   - on the target it is invested capital and cost from the transfer date;
//   - across the entity it nets to zero, so a fund-level cash-flow series leaves it out.
// computeSummary (lib/investments.ts) is the per-holding valuation and carries the IRR rule.

export const COST_TRANSFER = 'cost_transfer'

type Row = { transaction_type: string; investment_cost?: number | string | null }

export const isCostTransfer = (t: Row): boolean => t.transaction_type === COST_TRANSFER

/** A cost transfer into this holding. */
export const isTransferIn = (t: Row): boolean => isCostTransfer(t) && Number(t.investment_cost ?? 0) > 0

/** A cost transfer out of this holding. */
export const isTransferOut = (t: Row): boolean => isCostTransfer(t) && Number(t.investment_cost ?? 0) < 0

/**
 * The row puts the holding in the entity: a purchase, or cost transferred in. The gate the
 * schedule, the time series and the performance report use for "does this entity hold it".
 */
export const acquiresHolding = (t: Row): boolean => t.transaction_type === 'investment' || isTransferIn(t)

/**
 * A holding's dated investments, adjusted for its cost transfers: a transfer in is an investment on
 * its date; a transfer out shrinks the investments dated on or before it pro rata, so they sum that
 * much less (the moved cost is treated as never invested here — not as cash returned). Returns only
 * the investments that still carry an amount.
 */
export function investmentsAfterTransfers(
  investments: { date: string; amount: number }[],
  transfers: { date: string; amount: number }[],
): { date: string; amount: number }[] {
  const out = investments.map(i => ({ ...i }))
  const ordered = [...transfers].sort((a, b) => a.date.localeCompare(b.date) || (b.amount - a.amount))
  for (const t of ordered) {
    if (t.amount > 0) { out.push({ date: t.date, amount: t.amount }); continue }
    const prior = out.filter(i => i.date <= t.date && i.amount > 0)
    const base = prior.reduce((s, i) => s + i.amount, 0)
    if (base <= 0) continue
    const factor = Math.max(0, 1 - (-t.amount) / base)
    for (const i of prior) i.amount = Math.round(i.amount * factor * 100) / 100
  }
  return out.filter(i => i.amount > 0).sort((a, b) => a.date.localeCompare(b.date))
}
