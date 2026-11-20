// Associates look-through: attributing a GP/associate vehicle's position in the fund back to
// its own members.
//
// WHAT THIS REPLACES. `lp_associates_overrides` stored, per (investor, associates entity), an
// `ownership_pct` and a `carried_interest_pct` — as FREE TEXT names that had to match an
// investor's name AND a portfolio_group string simultaneously. Rename anything and the
// look-through silently stopped matching. It pro-rated everything by ownership and then netted
// carry off NAV, which conflates two different economics.
//
// WHAT THIS DOES INSTEAD. An associate vehicle keeps its own books. Its members' commitments
// and capital accounts are IN THE LEDGER, so ownership is derived, not maintained. And carry is
// treated as what it is — a separate entitlement:
//
//   ownership  — each member's share of the associate's CAPITAL. Derived from their commitments
//                (or capital balances) in the associate vehicle.
//   carry      — each member's share of the associate's CARRIED INTEREST. A separate allocation
//                (partner_allocation_terms, category 'carried_interest'), because carry points
//                routinely diverge from committed capital — and a member can hold carry points
//                while committing NOTHING at all.
//
// The split is possible because the close now accrues carry into the GP partner's
// `carriedInterest` roll-forward bucket (see carry.ts). The associate's position in the fund is
// therefore already separated into "capital I contributed and its returns" and "carry I earned",
// and each half goes to the people entitled to it.

import { emptyAccount, ACTIVITY_FIELDS, type CapitalAccount } from './capital-account'
import { roundCents } from './ledger'

export interface AssociateMember {
  lpEntityId: string
  /** Share of the associate's capital. Weights are normalized, so these need not sum to 1. */
  ownershipWeight: number
  /** Share of the associate's carried interest. Independent of ownership; may be nonzero when
   *  ownershipWeight is 0 (a carry participant who committed no capital). */
  carryWeight: number
}

const normalize = (weights: number[]): number[] => {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0)
  if (total <= 0) return weights.map(() => 0)
  return weights.map(w => Math.max(0, w) / total)
}

/**
 * Explode one associate's capital account into its members'.
 *
 * Every line EXCEPT `carriedInterest` is split by ownership; `carriedInterest` is split by carry
 * points. `ending` is recomputed as the sum of the parts, so a member's account ties by
 * construction.
 *
 * The members' accounts sum back to the associate's exactly — nothing is created or lost.
 */
export function lookThroughAccount(
  associate: CapitalAccount,
  members: AssociateMember[]
): Map<string, CapitalAccount> {
  const out = new Map<string, CapitalAccount>()
  if (members.length === 0) return out

  const ownership = normalize(members.map(m => m.ownershipWeight))
  const carry = normalize(members.map(m => m.carryWeight))

  // The lines that follow capital. `carriedInterest` is deliberately absent — it follows points.
  const capitalFields = (['beginning', ...ACTIVITY_FIELDS] as (keyof CapitalAccount)[])
    .filter(f => f !== 'carriedInterest')

  members.forEach((m, i) => {
    const acct = emptyAccount()
    let ending = 0

    for (const f of capitalFields) {
      const share = roundCents(associate[f] * ownership[i])
      acct[f] = share
      ending += share
    }

    const carryShare = roundCents(associate.carriedInterest * carry[i])
    acct.carriedInterest = carryShare
    ending += carryShare

    acct.ending = roundCents(ending)
    out.set(m.lpEntityId, acct)
  })

  // Largest-remainder on `ending` so the members sum EXACTLY to the associate. Rounding each
  // line independently can otherwise leave a cent adrift, and a capital account that doesn't
  // tie is a capital account nobody can trust.
  const summed = roundCents(Array.from(out.values()).reduce((s, a) => s + a.ending, 0))
  const drift = roundCents(associate.ending - summed)
  if (drift !== 0 && out.size > 0) {
    const biggest = Array.from(out.entries()).reduce((a, b) => (Math.abs(b[1].ending) > Math.abs(a[1].ending) ? b : a))
    biggest[1].ending = roundCents(biggest[1].ending + drift)
    biggest[1].unclassified = roundCents(biggest[1].unclassified + drift)
  }

  return out
}

/**
 * Build the member list for an associate vehicle.
 *
 * `basis` is each member's ownership weight — their commitment to (or capital in) the associate
 * vehicle, straight from its own books. `carryWeights` is the carry allocation from
 * `partner_allocation_terms`.
 *
 * A member appears if they have EITHER. Someone with carry points and no commitment is a real
 * and common arrangement — a founding partner, an advisor with points — and dropping them
 * because they never wired money is how their carry silently redistributes to everyone else.
 */
export function associateMembers(
  basis: Map<string, number>,
  carryWeights: Map<string, number>
): AssociateMember[] {
  const ids = new Set<string>([...Array.from(basis.keys()), ...Array.from(carryWeights.keys())])
  // "Carry follows ownership" is the default ONLY when nobody has explicit carry points. The
  // moment any member has explicit points, a member left blank holds 0 carry — NOT their
  // ownership weight. Ownership weight is a capital figure (dollars); carry points are a small
  // abstract scale (e.g. 40, 14, 5). Falling an unset member back onto their ownership dollars
  // and normalizing it against everyone else's points lets the dollar figure swamp the split —
  // a blank member with a large commitment would show ~100% of the carry. If you set points for
  // some, set them for all who hold carry; a blank means none.
  const anyExplicitCarry = carryWeights.size > 0
  return Array.from(ids).map(lpEntityId => ({
    lpEntityId,
    ownershipWeight: Math.max(0, basis.get(lpEntityId) ?? 0),
    carryWeight: carryWeights.has(lpEntityId)
      ? Math.max(0, carryWeights.get(lpEntityId)!)
      : (anyExplicitCarry ? 0 : Math.max(0, basis.get(lpEntityId) ?? 0)),
  }))
}

/**
 * A member's IRR on their look-through share of an associate's position.
 *
 * A member is not a scaled copy of the associate. Their contributions are their ownership share of
 * the associate's, but what comes back to them (distributions and NAV) also carries their share of
 * the carry, which follows points rather than capital. So their IRR differs from the associate's
 * and from each other member's, and the associate's own IRR must never be copied onto them.
 *
 * `flows` are the associate's dated cash flows from its point of view (contributions negative,
 * distributions positive), without the terminal NAV. Each contribution is scaled by the member's
 * share of the associate's contributions, each distribution by their share of its distributions,
 * and the member's own NAV is the terminal value. Null when the member put nothing in (a
 * carry-only member has no IRR), when the history is too short, or when there is no solution.
 */
export function memberLookThroughIrr(
  flows: { date: Date; amount: number }[],
  shares: { contributions: number; distributions: number },
  nav: number,
  asOf: Date,
  solve: (flows: { date: Date; amount: number }[]) => number | null,
  tooNew: (flows: { date: Date }[], asOf: Date) => boolean,
): number | null {
  if (!(shares.contributions > 0)) return null
  const scaled = flows
    .map(f => ({ date: f.date, amount: f.amount * (f.amount < 0 ? shares.contributions : shares.distributions) }))
    .filter(f => Math.abs(f.amount) >= 0.005)
  if (!scaled.some(f => f.amount < 0)) return null
  if (tooNew(scaled, asOf)) return null
  if (Math.abs(nav) >= 0.005) scaled.push({ date: asOf, amount: nav })
  if (scaled.length < 2) return null
  scaled.sort((a, b) => a.date.getTime() - b.date.getTime())
  const rate = solve(scaled)
  return rate == null || !Number.isFinite(rate) ? null : Math.round(rate * 10000) / 10000
}
