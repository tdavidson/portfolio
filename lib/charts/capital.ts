// Partner capital as the charts need it: one shape for a partner (the Partners page) and for a
// vehicle (the entities overview), since both are the same four figures and the same two charts.
//
// PAID-IN ≡ CALLED CAPITAL (lib/lp-metrics.ts). `called` here is that figure: capital recognised
// when called, funded or not. It is the denominator of every multiple below.

import { ratio } from './ranked'

export interface CapitalPosition {
  key: string
  name: string
  committed: number
  called: number
  distributions: number
  nav: number
}

/** A figure that may be unknown (null) as a number the charts can draw. Unknown draws nothing. */
export const known = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const totalValue = (p: CapitalPosition): number => p.distributions + p.nav
export const dpi = (p: CapitalPosition): number | null => ratio(p.distributions, p.called)
export const rvpi = (p: CapitalPosition): number | null => ratio(p.nav, p.called)
export const tvpi = (p: CapitalPosition): number | null => ratio(totalValue(p), p.called)
export const funded = (p: CapitalPosition): number | null => ratio(p.called, p.committed)

/**
 * Sum positions into one. The multiples of the result are then ratios of sums, which is the only
 * correct way to combine them: an average of TVPIs weights a $50K position like a $50M one.
 */
export function foldCapital(rest: CapitalPosition[], name: string): CapitalPosition {
  return rest.reduce<CapitalPosition>((a, p) => ({
    ...a,
    committed: a.committed + p.committed, called: a.called + p.called,
    distributions: a.distributions + p.distributions, nav: a.nav + p.nav,
  }), { key: '', name, committed: 0, called: 0, distributions: 0, nav: 0 })
}

/** Positions with a commitment to draw against, or capital called without one on record. */
export function withCommitment(positions: CapitalPosition[]): CapitalPosition[] {
  return positions.filter(p => p.committed > 0.5 || p.called > 0.5)
}

/** Positions with any value, or capital called that has none yet (a bar of nothing behind a tick). */
export function withValue(positions: CapitalPosition[]): CapitalPosition[] {
  return positions.filter(p => totalValue(p) > 0.5 || p.called > 0.5)
}

/** Positions that have a multiple at all: nothing called means nothing to divide by. */
export function withMultiple(positions: CapitalPosition[]): CapitalPosition[] {
  return positions.filter(p => p.called > 0.5)
}
