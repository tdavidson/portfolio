// Watched wallets: what the chain says a fund holds, checked against what its books say.
//
// THE POINT OF THIS FILE IS THE DISAGREEMENT. A quoted equity gets its quantity from the fund's
// own trade records and there is nothing to reconcile against. A token does not: the address is
// a second, independent source of truth for the quantity, and it is the only asset class in
// this book where an outside party can check the position without being shown anything.
//
// So the observed balance NEVER becomes the carrying quantity. If it did, the two sources would
// be one source and the check would be gone — an unrecorded disposal would silently restate the
// position instead of raising its hand. The books stay the books; this reports the variance.
//
// Pure, and shaped like fof-valuation.ts and quotes.ts so the close splices it into the same
// blockers/warnings arrays.

export interface Wallet {
  id: string
  companyId: string
  chain: string
  address: string
  label?: string | null
  active: boolean
  verifiedAt?: string | null
  verificationMethod?: string | null
}

export interface WalletBalance {
  walletId: string
  asOfDate: string
  units: number
  blockHeight?: number | null
}

/**
 * How stale an on-chain balance may be at period end before the close says so.
 *
 * A chain produces blocks continuously, so unlike a manager NAV (90 days is normal) or even an
 * equity close (a long weekend), there is no honest reason for a balance to be old. Two days
 * covers a weekend of nobody looking; beyond that the observation is not describing the period.
 */
export const STALE_BALANCE_DAYS = 2

/**
 * How far the chain and the books may differ before it is worth reporting, as a FRACTION of the
 * recorded quantity rather than an absolute number of units.
 *
 * Absolute would be meaningless across assets: 0.001 units is dust in one token and a material
 * position in another. This catches a real disposal or an unrecorded receipt while tolerating
 * the last-decimal noise of an 18-decimal quantity round-tripping through a provider.
 */
export const BALANCE_TOLERANCE = 0.0001

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

/** The last balance observed on or before a date — the same backwards-looking rule as quoteAsOf. */
export function balanceAsOf(
  balances: WalletBalance[],
  walletId: string,
  asOf: string,
): WalletBalance | null {
  let best: WalletBalance | null = null
  for (const b of balances) {
    if (b.walletId !== walletId) continue
    if (b.asOfDate > asOf) continue
    if (!best || b.asOfDate > best.asOfDate) best = b
  }
  return best
}

export interface HoldingBalance {
  companyId: string
  /** Sum of the latest observed balance across every active wallet for this holding. */
  observedUnits: number
  /** Wallets with no observation on or before the date. */
  unobserved: Wallet[]
  /** The oldest observation date contributing to the total, for staleness. */
  oldestAsOf: string | null
}

/**
 * Roll every active wallet for a holding into one observed quantity.
 *
 * A wallet with NO observation contributes nothing and is named instead. Treating it as zero
 * would understate the position and — worse — would look like a disposal, producing a confident
 * variance against the books that describes nothing that happened.
 */
export function observedByHolding(
  wallets: Wallet[],
  balances: WalletBalance[],
  asOf: string,
): Map<string, HoldingBalance> {
  const out = new Map<string, HoldingBalance>()
  for (const w of wallets) {
    if (!w.active) continue
    const entry = out.get(w.companyId) ?? {
      companyId: w.companyId, observedUnits: 0, unobserved: [], oldestAsOf: null,
    }
    const b = balanceAsOf(balances, w.id, asOf)
    if (!b) entry.unobserved.push(w)
    else {
      entry.observedUnits += b.units
      if (!entry.oldestAsOf || b.asOfDate < entry.oldestAsOf) entry.oldestAsOf = b.asOfDate
    }
    out.set(w.companyId, entry)
  }
  return out
}

export interface WalletVariance {
  companyId: string
  name: string
  /** What the chain says, summed across the holding's wallets. */
  observedUnits: number
  /** What the transaction history says — split-adjusted, from computeSummary. */
  recordedUnits: number
  /** observed − recorded. Positive means the chain holds more than the books know about. */
  delta: number
  /** As a fraction of recorded, which is what the tolerance is applied to. */
  fraction: number
  asOf: string | null
}

/**
 * Where the chain and the books disagree about the quantity.
 *
 * A holding with no wallets is skipped entirely — a token the fund tracks by hand is a
 * perfectly ordinary position, and having no address to check against is not a finding.
 */
export function walletVariances(
  positions: { companyId: string; name: string; units: number }[],
  wallets: Wallet[],
  balances: WalletBalance[],
  asOf: string,
): WalletVariance[] {
  const observed = observedByHolding(wallets, balances, asOf)
  const out: WalletVariance[] = []

  for (const p of positions) {
    const o = observed.get(p.companyId)
    if (!o) continue
    // Every wallet unobserved: there is no chain-side number to compare, so there is no
    // variance — only the missing observation, which the close reports separately.
    if (o.oldestAsOf === null) continue

    const delta = o.observedUnits - p.units
    const fraction = p.units === 0 ? (delta === 0 ? 0 : 1) : Math.abs(delta) / Math.abs(p.units)
    if (fraction <= BALANCE_TOLERANCE) continue

    out.push({
      companyId: p.companyId,
      name: p.name,
      observedUnits: o.observedUnits,
      recordedUnits: p.units,
      delta,
      fraction,
      asOf: o.oldestAsOf,
    })
  }
  return out
}

const units = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 })

/**
 * The wallet half of the pre-close check.
 *
 * THE SEVERITY SPLIT IS THE POLICY, and it differs from the quoted case in one important way:
 * nothing here BLOCKS on the variance itself.
 *
 * A quantity disagreement is a warning, not a blocker, because the books may well be right. A
 * transfer between two of the fund's own wallets, an airdrop nobody has decided how to treat,
 * a staking reward still accruing — all produce a variance that a fund can look at and
 * reasonably decide to close over. Blocking would make an ordinary week unclosable and would
 * train people to ignore it. What it must do is be impossible to miss, with both numbers and
 * the direction stated, so the decision is a decision rather than an oversight.
 *
 * An UNOBSERVED wallet warns too: the fund attached an address and then never read it, which
 * means the position is being reported on the books' word alone — exactly the situation the
 * wallet was supposed to improve on.
 *
 * An UNVERIFIED wallet warns once per holding. A watched address proves a balance, not control,
 * and an auditor will ask. Warning rather than blocking because proving control is a task with
 * a human in it, and a fund should not be locked out of its own close over paperwork.
 */
export function walletCloseIssues(
  positions: { companyId: string; name: string; units: number }[],
  wallets: Wallet[],
  balances: WalletBalance[],
  periodEnd: string,
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = []
  const warnings: string[] = []
  const byCompany = new Map(positions.map(p => [p.companyId, p]))

  for (const v of walletVariances(positions, wallets, balances, periodEnd)) {
    const more = v.delta > 0
    warnings.push(
      `${v.name}: the chain shows ${units(v.observedUnits)} units at ${v.asOf} but the books record `
      + `${units(v.recordedUnits)} — ${units(Math.abs(v.delta))} ${more ? 'more on-chain than recorded' : 'fewer on-chain than recorded'}. `
      + `${more ? 'A receipt, airdrop or staking reward may not be booked.' : 'A transfer or disposal may not be booked.'}`,
    )
  }

  const observed = observedByHolding(wallets, balances, periodEnd)
  for (const [companyId, o] of Array.from(observed.entries())) {
    const name = byCompany.get(companyId)?.name ?? 'A digital asset holding'

    for (const w of o.unobserved) {
      warnings.push(
        `${name}: no balance has been read for ${w.label ? `${w.label} (${w.chain})` : `${w.chain} ${short(w.address)}`} `
        + `on or before ${periodEnd}, so this position rests on the books alone.`,
      )
    }

    if (o.oldestAsOf) {
      const age = daysBetween(o.oldestAsOf, periodEnd)
      if (age > STALE_BALANCE_DAYS) {
        warnings.push(
          `${name}: the newest wallet balance is from ${o.oldestAsOf}, ${age} days before ${periodEnd}. `
          + `A chain does not stop producing blocks — read it again before closing.`,
        )
      }
    }
  }

  // One line per holding rather than per wallet: a fund with six unverified addresses on one
  // token has one problem, and six copies of it would bury the rest of the close report.
  const unverifiedByHolding = new Map<string, number>()
  for (const w of wallets) {
    if (!w.active || w.verifiedAt) continue
    unverifiedByHolding.set(w.companyId, (unverifiedByHolding.get(w.companyId) ?? 0) + 1)
  }
  for (const [companyId, count] of Array.from(unverifiedByHolding.entries())) {
    const name = byCompany.get(companyId)?.name ?? 'A digital asset holding'
    warnings.push(
      `${name}: ${count} ${count === 1 ? 'address has' : 'addresses have'} no proof of control on file. `
      + `Watching an address shows its balance, not that the fund owns it — record a signed message, `
      + `a test transaction, or a custodian statement.`,
    )
  }

  return { blockers, warnings }
}

/** Enough of an address to recognise, without a 42-character string in a sentence. */
export function short(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 8)}…${address.slice(-4)}`
}

/** A crypto_wallets row in the shape the reconciliation reads. */
export function walletFromRow(w: any): Wallet {
  return {
    id: w.id,
    companyId: w.company_id,
    chain: w.chain,
    address: w.address,
    label: w.label ?? null,
    active: w.active !== false,
    verifiedAt: w.verified_at ?? null,
    verificationMethod: w.verification_method ?? null,
  }
}

/** A crypto_wallet_balances row in the shape the reconciliation reads. */
export function balanceFromRow(b: any): WalletBalance {
  return { walletId: b.wallet_id, asOfDate: b.as_of_date, units: Number(b.units), blockHeight: b.block_height ?? null }
}
