// The investments page lists a holding once per vehicle that owns it. A chart "by holding" wants
// it once, so the rows are summed per holding here before anything is ranked or banded.

export interface HoldingRow {
  companyId: string
  companyName: string
  status: string
  totalInvested: number
  totalRealized: number
  unrealizedValue: number
  totalCostBasisExited: number
}

export interface HoldingPosition {
  companyId: string
  name: string
  status: string
  /** Everything ever invested, exited cost included. The denominator of the gross multiple. */
  invested: number
  /** Cost of what is still held: invested less the cost basis of what was sold or written off. */
  cost: number
  /** Fair value of what is still held. */
  fairValue: number
  /** Realized proceeds plus fair value. The numerator of the gross multiple. */
  totalValue: number
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** One position per holding, summed across the vehicles that hold it. Order of first appearance. */
export function positionsByHolding(rows: HoldingRow[]): HoldingPosition[] {
  const byId = new Map<string, HoldingPosition>()
  for (const r of rows) {
    const p = byId.get(r.companyId) ?? {
      companyId: r.companyId, name: r.companyName, status: r.status, invested: 0, cost: 0, fairValue: 0, totalValue: 0,
    }
    p.invested += n(r.totalInvested)
    p.cost += n(r.totalInvested) - n(r.totalCostBasisExited)
    p.fairValue += n(r.unrealizedValue)
    p.totalValue += n(r.totalRealized) + n(r.unrealizedValue)
    byId.set(r.companyId, p)
  }
  return Array.from(byId.values())
}

/**
 * The positions with something still held: a cost that has not been exited, or a value on the
 * books. A fully exited holding has neither and would be a row with no bar and no tick.
 * Half a currency unit is the threshold, so float dust from summing does not keep a row alive.
 */
export function heldPositions(positions: HoldingPosition[]): HoldingPosition[] {
  return positions.filter(p => p.fairValue > 0.5 || p.cost > 0.5)
}

/** Sum a set of positions into one, for the folded "others" row. */
export function foldPositions(rest: HoldingPosition[], name: string): HoldingPosition {
  return rest.reduce<HoldingPosition>((a, p) => ({
    ...a,
    invested: a.invested + p.invested, cost: a.cost + p.cost,
    fairValue: a.fairValue + p.fairValue, totalValue: a.totalValue + p.totalValue,
  }), { companyId: '', name, status: 'active', invested: 0, cost: 0, fairValue: 0, totalValue: 0 })
}
