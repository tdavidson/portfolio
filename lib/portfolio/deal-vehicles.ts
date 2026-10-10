// Which entities Investments carries at the sum of their LP positions (app/api/portfolio/investments).
//
// An entity whose holdings carry no figures — none recorded, or set up but never given an
// investment, proceeds or a mark — would read $0, though its LPs' positions say what went in and
// what it is worth. Those are carried at their LP sums. The moment ANY holding in the entity has a
// figure, the holdings take over and the LP row drops, so the same money is never counted twice.
// Management companies and GP/associate entities are never investments.

export interface HoldingFigures {
  portfolioGroup: string[]
  totalInvested: number
  totalRealized: number
  unrealizedValue: number
}

const norm = (s: string) => s.trim().toLowerCase()
const hasFigures = (h: HoldingFigures) =>
  Math.abs(h.totalInvested) > 0.5 || Math.abs(h.totalRealized) > 0.5 || Math.abs(h.unrealizedValue) > 0.5

export function vehiclesCarriedAtLpPositions<V extends { name: string; kind: string; active: boolean | null }>(
  vehicles: V[], holdings: HoldingFigures[],
): V[] {
  const recorded = new Set(holdings.filter(hasFigures).flatMap(h => h.portfolioGroup).map(norm))
  return vehicles.filter(v => v.active !== false && v.kind !== 'manco' && v.kind !== 'associate' && !recorded.has(norm(v.name)))
}
