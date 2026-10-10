import { splitAdjust } from '@/lib/splits'
import type { InvestmentTransaction } from '@/lib/types/database'

// ---------------------------------------------------------------------------
// Cost basis on a partial disposal.
//
// Selling part of a fungible position needs to know WHICH purchase the units left, and the
// answer is a policy election rather than a fact. The fund picks a method; this applies it.
//
// WHAT THIS DOES NOT DO: it does not overwrite `cost_basis_exited`. The recorded figure is what
// the books use, here as everywhere — a fund may have a reason for a number this cannot infer,
// and silently restating a realised gain because a policy field said so would be a worse bug
// than the one this fixes. It PROPOSES a basis for a new disposal, and it RECONCILES the ones
// already recorded, so a disagreement is visible instead of assumed away.
//
// Lots are built from SPLIT-ADJUSTED transactions, so a lot bought before a 2-for-1 holds twice
// the units at half the cost per unit and the same total cost. Without that, a disposal after a
// split consumes the wrong number of lots and lands on the wrong basis.
// ---------------------------------------------------------------------------

export type LotMethod = 'fifo' | 'lifo' | 'hifo' | 'average'

export const LOT_METHODS: LotMethod[] = ['fifo', 'lifo', 'hifo', 'average']

export const LOT_METHOD_LABELS: Record<LotMethod, string> = {
  fifo: 'First in, first out',
  lifo: 'Last in, first out',
  hifo: 'Highest cost first',
  average: 'Average cost',
}

export function isLotMethod(v: unknown): v is LotMethod {
  return typeof v === 'string' && (LOT_METHODS as string[]).includes(v)
}

export interface Lot {
  txnId: string
  date: string
  /** Split-adjusted units acquired. */
  units: number
  /** Total cost of the lot, including capitalised acquisition costs and in-kind income value. */
  cost: number
  /** cost / units. */
  unitCost: number
  /**
   * When the holding period began, if not `date`. Units received on converting a SAFE or a note
   * are held from when the instrument was bought (the holding period tacks), not from the
   * conversion — except any interest that capitalised into them, which is new basis on the day.
   */
  heldFrom?: string
}

export interface Disposal {
  txnId: string
  date: string
  /** Units disposed of, split-adjusted. */
  units: number
  /** What the row actually records as basis exited, or null if it records none. */
  recordedBasis: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * The cost a purchase actually put on the books.
 *
 * Three things add basis and they are easy to lose one of:
 *   - the cash paid (`investment_cost`);
 *   - interest that capitalised at a conversion (`interest_converted`, only on a conversion row);
 *   - acquisition costs — gas, brokerage (`fee_amount`).
 *
 * And for an in-kind income row, the basis is the income's fair value on the day, which is what
 * stops the same value being recognised again as gain when the units are eventually sold.
 */
export function basisOf(t: InvestmentTransaction): number {
  const row = t as any
  if (t.transaction_type === 'income') {
    return Number(row.income_amount ?? 0) + Number(row.fee_amount ?? 0)
  }
  const isConversion = !!row.converts_from_txn_id
  return (
    Number(t.investment_cost ?? 0)
    + (isConversion ? Number(t.interest_converted ?? 0) : 0)
    + Number(row.fee_amount ?? 0)
  )
}

/**
 * Purchase lots for one holding, oldest first.
 *
 * Rows carrying no units are skipped: a SAFE or a note has cost but nothing countable, and a
 * lot with zero units has an infinite unit cost that would poison every method.
 */
export function buildLots(txns: InvestmentTransaction[]): Lot[] {
  const adjusted = splitAdjust(txns)
  const byId = new Map(txns.map(t => [t.id, t as any]))
  // The date the original instrument was bought, through any chain of conversions (a note into a
  // SAFE into preferred). Guarded against a cycle in bad data.
  const originDate = (t: any): string | null => {
    let cur = t, seen = 0
    while (cur?.converts_from_txn_id && seen++ < 20) {
      const from = byId.get(cur.converts_from_txn_id)
      if (!from?.transaction_date) break
      cur = from
    }
    return cur && cur !== t ? cur.transaction_date ?? null : null
  }
  const lots: Lot[] = []
  for (const t of adjusted) {
    const acquires = t.transaction_type === 'investment'
      || (t.transaction_type === 'income' && (t as any).income_settlement === 'in_kind')
    if (!acquires) continue
    const units = Number(t.shares_acquired ?? 0)
    if (!(units > 0) || !t.transaction_date) continue
    const cost = basisOf(t)
    const origin = t.transaction_type === 'investment' ? originDate(t) : null
    const interest = origin ? Number(t.interest_converted ?? 0) : 0
    if (origin && origin < t.transaction_date) {
      // A conversion: the principal's units tack to the instrument's purchase date; units bought
      // with capitalised interest start their own clock on the conversion date.
      const interestUnits = cost > 0 && interest > 0 ? units * (interest / cost) : 0
      lots.push({ txnId: t.id, date: t.transaction_date, units: units - interestUnits, cost: cost - interest, unitCost: cost / units, heldFrom: origin })
      if (interestUnits > 0) lots.push({ txnId: t.id, date: t.transaction_date, units: interestUnits, cost: interest, unitCost: cost / units })
      continue
    }
    lots.push({
      txnId: t.id,
      date: t.transaction_date,
      units,
      cost,
      unitCost: cost / units,
    })
  }
  return lots.sort((a, b) => a.date.localeCompare(b.date))
}

/** Disposals for one holding, oldest first. Rows with no unit count are skipped. */
export function buildDisposals(txns: InvestmentTransaction[]): Disposal[] {
  const adjusted = splitAdjust(txns)
  const out: Disposal[] = []
  for (const t of adjusted) {
    if (t.transaction_type !== 'proceeds') continue
    if (!t.transaction_date) continue
    // A disposal states its size either as units sold or, for an unpriced exit, not at all.
    // `shares_acquired` is negative-free here: proceeds rows record units in the same column.
    const units = Math.abs(Number((t as any).shares_acquired ?? 0))
    if (!(units > 0)) continue
    out.push({
      txnId: t.id,
      date: t.transaction_date,
      units,
      recordedBasis: t.cost_basis_exited == null ? null : Math.abs(Number(t.cost_basis_exited)),
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

export interface LotAllocation {
  lotTxnId: string
  lotDate: string
  units: number
  cost: number
}

export interface DisposalBasis {
  txnId: string
  date: string
  units: number
  /** What the method says the basis should be. */
  computedBasis: number
  /** What the row records, or null. */
  recordedBasis: number | null
  /** Which lots the basis came from. Empty under 'average', which has no lots to point at. */
  allocations: LotAllocation[]
  /** Units the disposal claims that no lot could supply. */
  unmatchedUnits: number
}

/**
 * Walk the disposals in date order, consuming lots by the chosen method.
 *
 * IN DATE ORDER, and that is not cosmetic: every method except average depends on which lots
 * are still open when a disposal happens, so processing a later sale before an earlier one
 * consumes the wrong lots and both answers come out wrong.
 *
 * A disposal claiming more units than any lot holds reports `unmatchedUnits` rather than
 * inventing basis. That is the interesting case, not an edge case — it means a purchase was
 * never recorded, or the units are wrong, and either way a confident basis would bury it.
 */
export function computeDisposalBasis(
  lots: Lot[],
  disposals: Disposal[],
  method: LotMethod,
): DisposalBasis[] {
  // Copies: the caller's lots are not consumed.
  const open = lots.map(l => ({ ...l, remaining: l.units }))
  const out: DisposalBasis[] = []

  for (const d of disposals) {
    // Only lots acquired ON OR BEFORE the disposal date are available. Otherwise a sale in
    // March could draw basis from a purchase in June — which no method permits, and which
    // would silently make an early disposal look cheaper or dearer than it was.
    const available = open.filter(l => l.remaining > 0 && l.date <= d.date)

    if (method === 'average') {
      // One pooled unit cost across everything open. No lot to point at, so no allocations.
      const units = available.reduce((s, l) => s + l.remaining, 0)
      const cost = available.reduce((s, l) => s + l.remaining * l.unitCost, 0)
      const avg = units > 0 ? cost / units : 0
      const take = Math.min(d.units, units)
      // Drawn down pro rata so the pool stays correctly sized for the next disposal.
      if (units > 0) {
        const fraction = take / units
        for (const l of available) l.remaining -= l.remaining * fraction
      }
      out.push({
        txnId: d.txnId,
        date: d.date,
        units: d.units,
        computedBasis: r2(take * avg),
        recordedBasis: d.recordedBasis,
        allocations: [],
        unmatchedUnits: r2(d.units - take),
      })
      continue
    }

    const ordered = [...available].sort((a, b) => {
      if (method === 'fifo') return a.date.localeCompare(b.date)
      if (method === 'lifo') return b.date.localeCompare(a.date)
      return b.unitCost - a.unitCost // hifo
    })

    let want = d.units
    let basis = 0
    const allocations: LotAllocation[] = []
    for (const lot of ordered) {
      if (want <= 0) break
      const take = Math.min(want, lot.remaining)
      if (take <= 0) continue
      lot.remaining -= take
      want -= take
      basis += take * lot.unitCost
      allocations.push({
        // The holding period's start, which is what lotDate is read for (holding-period.ts,
        // realized-gains.ts) — tacked back for converted units.
        lotTxnId: lot.txnId, lotDate: lot.heldFrom ?? lot.date, units: take, cost: r2(take * lot.unitCost),
      })
    }

    out.push({
      txnId: d.txnId,
      date: d.date,
      units: d.units,
      computedBasis: r2(basis),
      recordedBasis: d.recordedBasis,
      allocations,
      unmatchedUnits: r2(want),
    })
  }

  return out
}

/** Everything in one call, from raw transactions for one holding. */
export function disposalBasis(txns: InvestmentTransaction[], method: LotMethod): DisposalBasis[] {
  return computeDisposalBasis(buildLots(txns), buildDisposals(txns), method)
}

/**
 * The basis a NEW disposal of `units` would carry, for prefilling the form.
 *
 * Existing disposals are replayed first so the proposal reflects what is actually still open —
 * proposing from the full lot set would hand back basis that an earlier sale already used.
 */
export function proposeBasisForNewDisposal(
  txns: InvestmentTransaction[],
  method: LotMethod,
  units: number,
  date: string,
): { basis: number; unmatchedUnits: number } {
  if (!(units > 0)) return { basis: 0, unmatchedUnits: 0 }
  const lots = buildLots(txns)
  const existing = buildDisposals(txns)
  const pending: Disposal = { txnId: '__proposed__', date, units, recordedBasis: null }
  const all = computeDisposalBasis(lots, [...existing, pending].sort((a, b) => a.date.localeCompare(b.date)), method)
  const mine = all.find(d => d.txnId === '__proposed__')
  return { basis: mine?.computedBasis ?? 0, unmatchedUnits: mine?.unmatchedUnits ?? 0 }
}

/** A cent, below which a difference is rounding rather than a disagreement. */
const CENT = 0.005

export interface LotIssue {
  txnId: string
  date: string
  kind: 'missing' | 'mismatch' | 'unmatched_units'
  message: string
}

/**
 * Where the recorded basis and the fund's own lot policy disagree.
 *
 * The severities differ by how wrong the books are:
 *   - MISSING basis on a disposal is the damaging one. The position keeps cost it no longer
 *     holds and the whole proceeds report as gain — an overstated NAV and an overstated return
 *     in the same stroke.
 *   - A MISMATCH may be perfectly deliberate (a specific-identification sale, a correction), so
 *     it is reported with both numbers and left alone.
 *   - UNMATCHED UNITS mean the disposal is larger than anything bought, so a purchase is
 *     missing entirely.
 */
export function lotIssues(
  txns: InvestmentTransaction[],
  method: LotMethod,
  holdingName: string,
): LotIssue[] {
  const issues: LotIssue[] = []
  for (const d of disposalBasis(txns, method)) {
    if (d.unmatchedUnits > CENT) {
      issues.push({
        txnId: d.txnId, date: d.date, kind: 'unmatched_units',
        message: `${holdingName}: the disposal on ${d.date} sells ${d.units} units but only `
          + `${d.units - d.unmatchedUnits} were ever acquired. A purchase is missing.`,
      })
    }
    if (d.recordedBasis == null || d.recordedBasis === 0) {
      if (d.computedBasis > CENT) {
        issues.push({
          txnId: d.txnId, date: d.date, kind: 'missing',
          message: `${holdingName}: the disposal on ${d.date} records no cost basis, so its full `
            + `proceeds report as gain and the position keeps cost it no longer holds. `
            + `${LOT_METHOD_LABELS[method]} puts the basis at ${d.computedBasis.toFixed(2)}.`,
        })
      }
      continue
    }
    if (Math.abs(d.recordedBasis - d.computedBasis) > CENT) {
      issues.push({
        txnId: d.txnId, date: d.date, kind: 'mismatch',
        message: `${holdingName}: the disposal on ${d.date} records basis of `
          + `${d.recordedBasis.toFixed(2)}, but ${LOT_METHOD_LABELS[method].toLowerCase()} puts it at `
          + `${d.computedBasis.toFixed(2)}. Deliberate is fine — this only says the two differ.`,
      })
    }
  }
  return issues
}
