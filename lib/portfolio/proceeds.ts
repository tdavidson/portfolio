// What an exit's proceeds columns mean. ONE definition, read everywhere.
//
// On a `proceeds` row:
//   proceeds_received  GROSS proceeds realized at the exit — everything the fund is owed for what it
//                      sold, INCLUDING any part the buyer held back in escrow. This is what the form
//                      labels "Proceeds (gross)" and what the tracker, MOIC, DPI and realized gain read.
//   proceeds_escrow    The portion of that gross still held back. A disclosure, never an extra amount:
//                      it is never added to proceeds_received.
//
// So the cash that arrived at the exit is gross − escrow, the rest is a receivable (1350), and the
// realized gain is gross − basis. When the escrow lands, an `escrow_receipt` row (its own
// proceeds_received = the amount released) moves it from 1350 to cash and adds no proceeds.
//
//   proceeds_holdback  The part of proceeds_escrow that is a holdback or deferred payment the buyer
//                      owes directly (a note, a deferred tranche) rather than money sitting in an
//                      escrow account. Still part of the escrow figure, so every report reads the
//                      same totals; the ledger books it to its own receivable (1355) instead of
//                      1350. On an `escrow_receipt` row it is the part of the cash received that
//                      clears 1355; the rest clears 1350.
//
// Before this was pinned down, the ledger and several reports read proceeds_received as the cash
// received and added the escrow on top, so a gross figure entered on the form booked the escrow
// twice. Rows recorded before then may hold either reading; scripts/diagnose-escrow-exits.ts lists
// them for review.

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

export interface ProceedsSplit {
  /** Total realized at the exit, escrow included. */
  gross: number
  /** Held back, not yet paid. */
  escrow: number
  /** Paid at the exit: gross − escrow. */
  cash: number
}

/** The gross / escrow / cash of a `proceeds` row. */
export function proceedsSplit(t: { proceeds_received?: unknown; proceeds_escrow?: unknown }): ProceedsSplit {
  const gross = n(t.proceeds_received)
  const escrow = n(t.proceeds_escrow)
  return { gross, escrow, cash: Math.round((gross - escrow) * 100) / 100 }
}

/**
 * Why a row's holdback doesn't fit, or null. On an exit the holdback is part of the escrow; on an
 * escrow receipt it is part of the cash received. Nowhere else.
 */
export function holdbackError(t: {
  transaction_type?: unknown; proceeds_received?: unknown; proceeds_escrow?: unknown; proceeds_holdback?: unknown
}): string | null {
  const holdback = n(t.proceeds_holdback)
  if (holdback === 0) return null
  if (holdback < 0) return 'proceeds_holdback cannot be negative.'
  if (t.transaction_type === 'proceeds') {
    if (holdback - n(t.proceeds_escrow) > 0.005) {
      return 'The holdback is larger than the escrow. proceeds_escrow is everything held back; the holdback is the part of it the buyer owes directly rather than through an escrow account.'
    }
    return null
  }
  if (t.transaction_type === 'escrow_receipt') {
    if (holdback - n(t.proceeds_received) > 0.005) return 'The holdback cleared is larger than the cash received.'
    return null
  }
  return 'proceeds_holdback applies only to an exit (proceeds) or an escrow receipt.'
}

/** Gross proceeds of a `proceeds` row — the figure every return and gain is measured on. */
export const grossProceeds = (t: { proceeds_received?: unknown }): number => n(t.proceeds_received)

/** Why a proceeds row's escrow cannot be read as part of its gross, or null. */
export function escrowExceedsGross(t: { transaction_type?: unknown; proceeds_received?: unknown; proceeds_escrow?: unknown }): string | null {
  if (t.transaction_type !== 'proceeds') return null
  const { gross, escrow } = proceedsSplit(t)
  if (escrow > 0 && escrow - gross > 0.005) {
    return 'The amount in escrow is larger than the proceeds. Proceeds is the GROSS amount realized, '
      + 'including what is held in escrow — enter the total, and the escrow as the part of it held back.'
  }
  return null
}

/**
 * Why an escrow_receipt row can't be booked, or null. A receipt is cash released from an exit's
 * holdback: its proceeds_received is that cash, and it moves no cost and holds no escrow of its own.
 * Extra gain paid beyond the escrow held is a separate proceeds row with no cost exited.
 */
export function escrowReceiptError(t: {
  transaction_type?: unknown; proceeds_received?: unknown; proceeds_escrow?: unknown
  cost_basis_exited?: unknown; investment_cost?: unknown
}): string | null {
  if (t.transaction_type !== 'escrow_receipt') return null
  if (!(n(t.proceeds_received) > 0)) return 'An escrow receipt needs proceeds_received: the cash released from escrow.'
  if (n(t.cost_basis_exited) !== 0 || n(t.investment_cost) !== 0) {
    return 'An escrow receipt moves no cost: the exit already took the cost off. Leave cost_basis_exited and investment_cost empty.'
  }
  if (n(t.proceeds_escrow) !== 0) return 'An escrow receipt releases escrow; it holds none. Leave proceeds_escrow empty.'
  return null
}

/**
 * Why a row's securities-settled consideration doesn't fit, or null. On an exit, cash is the gross
 * less escrow less what came as shares, so escrow and shares together can't exceed the gross. On a
 * purchase, the shares can't pay for more than the cost.
 */
export function inKindExceeds(t: {
  transaction_type?: unknown; proceeds_received?: unknown; proceeds_escrow?: unknown
  investment_cost?: unknown; consideration_in_kind?: unknown
}): string | null {
  const inKind = n(t.consideration_in_kind)
  if (inKind <= 0) return null
  if (t.transaction_type === 'proceeds') {
    if (inKind + n(t.proceeds_escrow) - n(t.proceeds_received) > 0.005) {
      return 'The part paid in shares plus the escrow is larger than the proceeds. Proceeds is the GROSS, '
        + 'including what came as shares and what is held in escrow.'
    }
    return null
  }
  if (t.transaction_type === 'investment') {
    if (inKind - n(t.investment_cost) > 0.005) return 'The part paid in securities is larger than the investment cost.'
    return null
  }
  return 'consideration_in_kind applies only to an exit (proceeds) or a purchase (investment).'
}
