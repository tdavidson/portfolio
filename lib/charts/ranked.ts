// The arithmetic behind the ranked-bar and distribution charts on the investments, partners and
// entities pages. Pure, so each rule is pinned by a test (ranked.test.ts) instead of living in
// the middle of a component.

/**
 * The largest `limit` items by `value`, largest first, with everything after them folded into
 * one. Folding rather than dropping: a chart of the top ten that silently leaves out the other
 * forty would understate the portfolio by whatever they hold.
 *
 * Nothing is folded when the tail is a single item: "1 other" takes the same row as the item
 * itself would.
 */
export function topWithOthers<T>(items: T[], limit: number, value: (item: T) => number, fold: (rest: T[]) => T): T[] {
  const ranked = [...items].sort((a, b) => value(b) - value(a))
  if (limit <= 0 || ranked.length <= limit + 1) return ranked
  return [...ranked.slice(0, limit), fold(ranked.slice(limit))]
}

/** "3 others", "1 other". */
export function othersLabel(count: number): string {
  return `${count} ${count === 1 ? 'other' : 'others'}`
}

// ---------------------------------------------------------------------------------------------
// Return distribution
// ---------------------------------------------------------------------------------------------

export interface MultipleBucket {
  key: string
  label: string
  /** Lower bound, inclusive. */
  min: number
  /** Upper bound, exclusive. Infinity for the top bucket. */
  max: number
  count: number
  invested: number
  totalValue: number
  /** The part of totalValue already received as proceeds. */
  realized: number
  /** The part of totalValue still held, at fair value. realized + held = totalValue. */
  held: number
}

/**
 * The bands a venture portfolio's outcomes are read in. Ordered, and fixed: the same five
 * columns whatever the portfolio looks like, so two funds' charts can be laid side by side.
 * "Below 1x" is everything worth less than it cost, write-offs included.
 */
const BANDS: Pick<MultipleBucket, 'key' | 'label' | 'min' | 'max'>[] = [
  { key: 'below-1', label: 'Below 1x', min: -Infinity, max: 1 },
  { key: '1-2', label: '1x to 2x', min: 1, max: 2 },
  { key: '2-5', label: '2x to 5x', min: 2, max: 5 },
  { key: '5-10', label: '5x to 10x', min: 5, max: 10 },
  { key: '10-plus', label: '10x and up', min: 10, max: Infinity },
]

/**
 * Sort holdings into bands by gross multiple (total value over invested capital) and sum what
 * went into each band and what it is worth now, split into what has been received and what is
 * still held.
 *
 * A holding with nothing invested has no multiple and is left out; so is one carried at exactly
 * cost with no proceeds only if it has no cost (it then has no bar to draw). Total value is
 * realized proceeds plus what is still held, which is the numerator of the page's Gross MOIC.
 */
export function multipleBuckets(holdings: { invested: number; totalValue: number; fairValue?: number }[]): MultipleBucket[] {
  const buckets: MultipleBucket[] = BANDS.map(b => ({ ...b, count: 0, invested: 0, totalValue: 0, realized: 0, held: 0 }))
  for (const h of holdings) {
    if (!(h.invested > 0) || !Number.isFinite(h.totalValue)) continue
    const multiple = h.totalValue / h.invested
    const bucket = buckets.find(b => multiple >= b.min && multiple < b.max)
    if (!bucket) continue
    bucket.count += 1
    bucket.invested += h.invested
    // Held is capped at the total so the two parts can never add up to more than the column.
    const total = Math.max(0, h.totalValue)
    const held = Math.min(total, Math.max(0, h.fairValue ?? 0))
    bucket.totalValue += total
    bucket.held += held
    bucket.realized += total - held
  }
  return buckets
}

// ---------------------------------------------------------------------------------------------
// Shares and ratios
// ---------------------------------------------------------------------------------------------

/** n / d, or null when d is not positive. Never Infinity, never NaN. */
export function ratio(n: number | null | undefined, d: number | null | undefined): number | null {
  return typeof n === 'number' && typeof d === 'number' && Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : null
}

/** A 0..1 share as a whole percentage: 0.725 is "73%". Null is a dash. */
export function wholePercent(share: number | null): string {
  return share == null ? '—' : `${Math.round(share * 100)}%`
}

/**
 * A bar's length as a CSS percentage of the chart's scale. Clamped to the plot: a negative
 * value draws nothing and a value past the scale stops at the edge, so no bar can leave its lane.
 */
export function barWidth(value: number | null | undefined, scaleMax: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !(scaleMax > 0)) return '0%'
  return `${Math.min(1, value / scaleMax) * 100}%`
}
