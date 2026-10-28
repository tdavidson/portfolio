// Carry escrow (a holdback): a share of each carry payment is held rather than paid, to secure the
// clawback. It is released at fund end, after the clawback has been taken from it, or earlier once
// the LPs have received a set multiple of what they contributed. This is the Walter spec's reading
// (spec/06-clawback-and-accrued-carry.md); lib/accounting/walter/adapter.ts runs it on the escrow
// vectors.
//
// The escrow doesn't change the waterfall: carry held is carry the GP has been paid, so the
// clawback measures against it as before. It only changes when the recipients get the cash.

import { roundCents } from './ledger.ts'

export interface CarryEscrowTerms {
  /** The share of each carry payment held, 0 to 1. */
  share: number
  /** When it is paid out. Default: at fund end. */
  release?: 'fund-end' | { lpMultiple: number }
}

/** Half to even, to the cent: how each recipient's held amount is rounded. */
function roundHalfEven(v: number): number {
  const c = v * 100
  const f = Math.floor(c)
  const r = c - f
  const cents = Math.abs(r - 0.5) < 1e-7 ? (f % 2 === 0 ? f : f + 1) : Math.round(c)
  return cents / 100
}

export class CarryEscrow {
  private readonly held = new Map<string, number>()
  private released = false

  constructor(private readonly terms: CarryEscrowTerms) {}

  /**
   * One distribution: each recipient's carry received in it, and the LPs' distributions and
   * contributions to date, this distribution included. Returns each recipient's escrow line,
   * negative when held and positive when released, netted.
   */
  distribution(carry: Map<string, number>, lpDistributed: number, lpContributed: number): Map<string, number> {
    const lines = new Map<string, number>()
    if (this.released) return lines
    for (const [id, c] of carry) {
      const h = roundHalfEven(c * this.terms.share)
      if (h === 0) continue
      this.held.set(id, roundCents((this.held.get(id) ?? 0) + h))
      lines.set(id, -h)
    }
    const multiple = typeof this.terms.release === 'object' ? this.terms.release.lpMultiple : undefined
    if (multiple !== undefined && lpContributed > 0 && lpDistributed >= lpContributed * multiple - 1e-9) {
      for (const [id, x] of this.take()) lines.set(id, roundCents((lines.get(id) ?? 0) + x))
      this.released = true
    }
    return lines
  }

  /** Fund end: releases what is still held, and says how much of each recipient's clawback it covered. */
  fundEnd(clawback: Map<string, number>): { lines: Map<string, number>; fromEscrow: number } {
    let fromEscrow = 0
    for (const [id, c] of clawback) fromEscrow += Math.min(Math.max(0, c), this.held.get(id) ?? 0)
    this.released = true
    return { lines: this.take(), fromEscrow: roundCents(fromEscrow) }
  }

  /** What each recipient still has held. */
  balance(): Map<string, number> {
    return new Map(this.held)
  }

  private take(): Map<string, number> {
    const out = new Map([...this.held].filter(([, x]) => x !== 0))
    this.held.clear()
    return out
  }
}
