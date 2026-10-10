import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'
import type { CompanyInvestmentSummary, InvestmentRoundSummary } from '@/lib/types/investments'
import { xirr, type CashFlow } from '@/lib/xirr'
import { splitAdjust } from '@/lib/splits'

// ---------------------------------------------------------------------------
// Compute summary from raw transactions
// ---------------------------------------------------------------------------

const OPENS_ROUND = new Set(['investment', 'conversion', 'share_split'])

/** Date order, acquisitions first within a day — what the per-round roll-up needs. */
export function sortForRollup(txns: InvestmentTransaction[]): InvestmentTransaction[] {
  return txns
    .map((t, i) => ({ t, i }))
    .sort((a, b) =>
      String(a.t.transaction_date ?? '').localeCompare(String(b.t.transaction_date ?? ''))
      || (OPENS_ROUND.has(a.t.transaction_type) ? 0 : 1) - (OPENS_ROUND.has(b.t.transaction_type) ? 0 : 1)
      || a.i - b.i)
    .map(x => x.t)
}

export function computeSummary(
  rawTransactions: InvestmentTransaction[],
  companyStatus: CompanyStatus,
  asOfDate: Date = new Date()
): CompanyInvestmentSummary {
  // Restate the history in today's shares BEFORE anything reads a share count or a per-share
  // price. Splits are applied once, here, so nothing downstream has to know they exist — see
  // lib/splits.ts for why this is a pre-pass and not a branch in the roll-up.
  //
  // Then put them in date order, acquisitions first within a day. The roll-up attributes a mark or
  // an exit to its round by name, so a mark read before the investment that opens its round has
  // no round to land on and is silently dropped. Several callers read the table without an order
  // (the close, construction), so the order is fixed here rather than trusted.
  const transactions = sortForRollup(splitAdjust(rawTransactions))

  let totalInvested = 0
  let totalIncomeBasis = 0
  let totalIncome = 0
  let totalShares = 0
  let totalRealized = 0
  let totalWrittenOff = 0
  let latestSharePrice: number | null = null
  let latestSharePriceDate: string | null = null
  let latestFromConversion = false
  const valueMarks: { date: string; amount: number; round: string | null }[] = []

  const roundMap = new Map<string, InvestmentRoundSummary>()
  const roundCashFlows = new Map<string, CashFlow[]>()
  const cashFlows: CashFlow[] = []

  // A conversion (a SAFE/note investment row carrying `converts_from_txn_id`) MOVES the source
  // instrument's basis into the priced round it became. When source and target are different
  // rounds we shift the basis for fair-value purposes: it leaves the source round (so the SAFE
  // stops showing a live position) and lands in the target round (so its priced-equity value is
  // computed on the full basis). The source row's cash outflow stays on its own date for IRR —
  // only the FV attribution moves. Same-round conversions need no shift: the basis is already
  // there; the conversion just makes the round priced.
  const byId = new Map<string, InvestmentTransaction>()
  for (const t of transactions) if (t.id) byId.set(t.id, t)
  const carriedInByRound = new Map<string, number>()   // basis moved INTO a round from a conversion
  const carriedOutByRound = new Map<string, number>()  // basis moved OUT of a source round
  for (const t of transactions) {
    const srcId = (t as { converts_from_txn_id?: string | null }).converts_from_txn_id
    if (t.transaction_type !== 'investment' || !srcId) continue
    const src = byId.get(srcId)
    if (!src || src.transaction_type !== 'investment') continue
    const targetRound = t.round_name ?? 'Unknown'
    const sourceRound = src.round_name ?? 'Unknown'
    if (targetRound === sourceRound) continue // nothing to move
    // Carta treats converted interest as additional basis in the note before the note converts.
    // Move principal plus that capitalized interest into the target round.
    const carried = (src.investment_cost ?? 0) + Number(t.interest_converted ?? 0)
    carriedInByRound.set(targetRound, (carriedInByRound.get(targetRound) ?? 0) + carried)
    carriedOutByRound.set(sourceRound, (carriedOutByRound.get(sourceRound) ?? 0) + carried)
  }

  for (const txn of transactions) {
    if (txn.transaction_type === 'investment') {
      const isConversion = !!(txn as { converts_from_txn_id?: string | null }).converts_from_txn_id
      totalInvested += (txn.investment_cost ?? 0) + Number((txn as any).fee_amount ?? 0)
      totalShares += txn.shares_acquired ?? 0
      // Interest that rolled into equity at conversion is real cost basis (it was recognized as
      // income while accruing, and now capitalizes into the position). It is NOT cash, so it is
      // added to basis here but never pushed as a cash flow. Only counted on the conversion row.
      if (isConversion) totalInvested += txn.interest_converted ?? 0

      if (txn.transaction_date && txn.investment_cost) {
        const cf = { date: new Date(txn.transaction_date), amount: -(txn.investment_cost) }
        cashFlows.push(cf)
        const rn = txn.round_name ?? 'Unknown'
        if (!roundCashFlows.has(rn)) roundCashFlows.set(rn, [])
        roundCashFlows.get(rn)!.push({ ...cf })
      }

      // Converted interest is added to the source note's basis below, then carried into the target
      // round if this is a cross-round conversion. The conversion row itself contributes only new
      // cash here, avoiding double-counting the capitalized interest.
      // Acquisition costs — gas, brokerage — capitalise into the position's basis rather than
      // hitting the income statement. See migration 20260822000001 for what does NOT belong here.
      const rowBasis = (txn.investment_cost ?? 0)
        + Number((txn as any).fee_amount ?? 0)
      const roundName = txn.round_name ?? 'Unknown'
      const existing = roundMap.get(roundName)
      if (existing) {
        existing.investmentCost += rowBasis
        existing.sharesAcquired += txn.shares_acquired ?? 0
        existing.interestConverted += txn.interest_converted ?? 0
        if (!existing.date && txn.transaction_date) existing.date = txn.transaction_date
        if (txn.share_price != null && txn.share_price > 0) existing.sharePrice = txn.share_price
      } else {
        roundMap.set(roundName, {
          roundName,
          date: txn.transaction_date,
          investmentCost: rowBasis,
          sharesAcquired: txn.shares_acquired ?? 0,
          sharePrice: (txn.share_price != null && txn.share_price > 0) ? txn.share_price : null,
          currentSharePrice: null,
          currentValue: 0,
          interestConverted: txn.interest_converted ?? 0,
          unrealizedValueChange: 0,
          costBasisExited: 0,
          totalRealized: 0,
          totalEscrow: 0,
          escrowOutstanding: 0,
          proceedsDate: null,
          grossIrr: null,
        })
      }
      // Also track share price for latest determination
      // Only use positive share prices (skip $0 from SAFEs, warrants, etc.)
      if (txn.share_price != null && txn.share_price > 0 && txn.transaction_date) {
        // A conversion's price is what the SAFE or note bought in at, not what the equity is worth:
        // on a day with both, the priced round's price is the day's price, whichever row comes first.
        const sameDayRound = txn.transaction_date === latestSharePriceDate && latestFromConversion && !txn.converts_from_txn_id
        if (!latestSharePriceDate || txn.transaction_date > latestSharePriceDate || sameDayRound) {
          latestSharePrice = txn.share_price
          latestSharePriceDate = txn.transaction_date
          latestFromConversion = !!txn.converts_from_txn_id
        }
      }
    }

    // Income the POSITION produced — a staking reward, an airdrop, a dividend.
    //
    // NOT a valuation change, which is what recording one as a mark used to make it. Income is
    // income: it belongs on the statement of operations, not in change-in-unrealized, and
    // treating it as appreciation both inflates the unrealized line and — because a mark adds
    // no basis — reports the same value again as realized gain when the units are sold.
    if (txn.transaction_type === 'income') {
      const row = txn as any
      const amount = Number(row.income_amount ?? 0)
      totalIncome += amount

      if (row.income_settlement === 'in_kind') {
        // Received in kind: more units, and their fair value on the day becomes their cost.
        // That basis is what a later disposal nets against.
        const units = txn.shares_acquired ?? 0
        const rowBasis = amount + Number(row.fee_amount ?? 0)
        totalIncomeBasis += rowBasis
        totalShares += units

        // Into the round like any other acquisition, so fair value (shares x price) and the
        // remaining-basis test both see them. NOT pushed as a cash flow: no capital was
        // deployed, and an outflow here would understate the IRR of a position that did well.
        const roundName = txn.round_name ?? 'Unknown'
        const existing = roundMap.get(roundName)
        if (existing) {
          existing.investmentCost += rowBasis
          existing.sharesAcquired += units
          if (!existing.date && txn.transaction_date) existing.date = txn.transaction_date
        } else {
          roundMap.set(roundName, {
            roundName,
            date: txn.transaction_date,
            investmentCost: rowBasis,
            sharesAcquired: units,
            sharePrice: null,
            currentSharePrice: null,
            currentValue: 0,
            interestConverted: 0,
            unrealizedValueChange: 0,
            costBasisExited: 0,
            totalRealized: 0,
            totalEscrow: 0,
            escrowOutstanding: 0,
            proceedsDate: null,
            grossIrr: null,
          })
        }
      }
    }

    if (txn.transaction_type === 'proceeds') {
      // `proceeds_received` stores gross proceeds realized at the exit. `proceeds_escrow` is a
      // disclosure of the portion still held back, not an additional amount to add again.
      const proceedsAmount = txn.proceeds_received ?? 0
      totalRealized += proceedsAmount
      totalWrittenOff += txn.proceeds_written_off ?? 0

      // Gross performance recognizes escrow at the original realization date. Escrow receipt
      // rows are collection history only and do not change the return calculation.
      if (txn.transaction_date && proceedsAmount > 0) {
        const cf = { date: new Date(txn.transaction_date), amount: proceedsAmount }
        cashFlows.push(cf)
        if (txn.round_name) {
          if (!roundCashFlows.has(txn.round_name)) roundCashFlows.set(txn.round_name, [])
          roundCashFlows.get(txn.round_name)!.push({ ...cf })
        }
      }
      // Attribute cost basis exited and proceeds to the round if specified
      if (txn.round_name) {
        const round = roundMap.get(txn.round_name)
        if (round) {
          if (txn.cost_basis_exited != null) round.costBasisExited += Math.abs(txn.cost_basis_exited)
          round.totalRealized += proceedsAmount
          round.totalEscrow += txn.proceeds_escrow ?? 0
          round.escrowOutstanding += txn.proceeds_escrow ?? 0
          if (txn.transaction_date) {
            if (!round.proceedsDate || txn.transaction_date > round.proceedsDate) {
              round.proceedsDate = txn.transaction_date
            }
          }
        }
      }
    }

    if (txn.transaction_type === 'escrow_receipt' && txn.round_name) {
      const round = roundMap.get(txn.round_name)
      if (round) round.escrowOutstanding = Math.max(0, round.escrowOutstanding - Number(txn.proceeds_received ?? 0))
    }

    if (txn.transaction_type === 'unrealized_gain_change') {
      if (txn.current_share_price != null && txn.transaction_date) {
        if (!latestSharePriceDate || txn.transaction_date >= latestSharePriceDate) {
          latestSharePrice = txn.current_share_price
          latestSharePriceDate = txn.transaction_date
        }
      }
      // Attribute unrealized value change to the round if specified
      if (txn.round_name && txn.unrealized_value_change != null) {
        const round = roundMap.get(txn.round_name)
        if (round) round.unrealizedValueChange += txn.unrealized_value_change
      }
      // A value-change mark with no price. Kept with its date: whether it moves a priced position
      // depends on whether a later price already reflects it (see `valueMarks` below).
      if (txn.unrealized_value_change != null && txn.current_share_price == null) {
        valueMarks.push({ date: txn.transaction_date ?? '', amount: Number(txn.unrealized_value_change), round: txn.round_name ?? null })
      }
    }

    if (txn.transaction_type === 'round_info') {
      if (txn.share_price != null && txn.transaction_date) {
        if (!latestSharePriceDate || txn.transaction_date >= latestSharePriceDate) {
          latestSharePrice = txn.share_price
          latestSharePriceDate = txn.transaction_date
        }
      }
    }
  }

  // Capitalize converted interest into the note's basis before the conversion moves that basis
  // into the priced round. This is a basis transfer, not a proceeds event: no cash was received
  // and no realized return should be recognized at conversion.
  for (const txn of transactions) {
    const sourceId = (txn as { converts_from_txn_id?: string | null }).converts_from_txn_id
    const interest = Number(txn.interest_converted ?? 0)
    if (txn.transaction_type !== 'investment' || !sourceId || interest <= 0 || !txn.transaction_date) continue

    const source = byId.get(sourceId)
    if (!source || source.transaction_type !== 'investment') continue

    const sourceRoundName = source.round_name ?? 'Unknown'
    const sourceRound = roundMap.get(sourceRoundName)
    if (sourceRound) {
      sourceRound.investmentCost += interest
    }
  }

  // Compute per-round FMV and sum for company unrealized value
  const rounds = Array.from(roundMap.values())
  let unrealizedValue = 0
  for (const round of rounds) {
    // Use the latest share price from unrealized_gain_change / round_info transactions.
    // If none exists, fall back to the round's own share price from the investment.
    const effectiveSharePrice = latestSharePrice ?? round.sharePrice ?? null
    round.currentSharePrice = effectiveSharePrice
    // Conversions move basis between rounds: a target round is valued on its own basis PLUS what
    // converted into it; a source round has the converted basis removed (so a SAFE that has fully
    // converted shows no live position). Both default to 0 when there are no conversions.
    const carriedIn = carriedInByRound.get(round.roundName) ?? 0
    const carriedOut = carriedOutByRound.get(round.roundName) ?? 0
    const roundBasis = round.investmentCost + carriedIn
    const isPricedEquity = round.sharesAcquired > 0 && ((round.sharePrice != null && round.sharePrice > 0) || roundBasis > 0)
    // If all cost basis has been exited (or converted away), there's no remaining unrealized position.
    // "Exited" means basis actually LEFT: a round that cost nothing (warrants received with a deal)
    // and was never sold still holds whatever its marks say, so a zero basis alone is not gone.
    const remainingBasis = roundBasis - round.costBasisExited - carriedOut
    const exitedAway = round.costBasisExited + carriedOut > 0
    if (remainingBasis <= 0 && (exitedAway || roundBasis > 0)) {
      round.currentValue = 0
    } else if (isPricedEquity && effectiveSharePrice != null) {
      // Equity round with a price: prorate shares by remaining basis fraction
      const fraction = roundBasis > 0 ? Math.max(0, remainingBasis) / roundBasis : 1
      round.currentValue = round.sharesAcquired * fraction * effectiveSharePrice
    } else {
      // No price anywhere (none on the investment, none on a mark): the marks ARE the valuation.
      // Valuing shares at a missing price gave 0 and threw away every recorded mark.
      // Convertible / warrant / no shares: remaining basis + unrealized changes
      round.currentValue = Math.max(0, remainingBasis + round.unrealizedValueChange)
    }
    unrealizedValue += round.currentValue
  }

  // Value-change marks on a priced position. A price (a round, a mark with a share price) values
  // every share at once, so a mark recorded on or before it is already inside it; a mark AFTER the
  // latest price moves the value on from there. That is exactly what the books hold — cost plus
  // every mark — and why the schedule of investments ties to the ledger. Without this, a fund that
  // marks by value change ("+$1.2M") rather than by price showed its last round price forever.
  // Marks on an unpriced round are already in that round's value above.
  const pricedRounds = new Set(rounds.filter(r => r.currentValue > 0 && r.sharesAcquired > 0 && r.currentSharePrice != null).map(r => r.roundName))
  const lateMarks = valueMarks.filter(m =>
    (m.round == null || pricedRounds.has(m.round))
    && (latestSharePriceDate == null || m.date > latestSharePriceDate))
  const markAdjustment = lateMarks.reduce((sum, m) => sum + m.amount, 0)
  if (markAdjustment !== 0) {
    // Spread over the live rounds by value, so a per-round view still adds up to the company.
    const live = rounds.filter(r => r.currentValue > 0)
    const base = live.reduce((sum, r) => sum + r.currentValue, 0)
    if (base > 0) {
      for (const r of live) r.currentValue = Math.max(0, r.currentValue + markAdjustment * (r.currentValue / base))
      unrealizedValue = rounds.reduce((sum, r) => sum + r.currentValue, 0)
    } else {
      unrealizedValue = Math.max(0, unrealizedValue + markAdjustment)
    }
  }

  // Compute per-round IRR
  for (const round of rounds) {
    const rcf = roundCashFlows.get(round.roundName) ?? []
    const hasInvestment = rcf.some(cf => cf.amount < 0)
    const hasProceeds = rcf.some(cf => cf.amount > 0)

    if (hasInvestment && hasProceeds) {
      // Full cash flow data available
      round.grossIrr = xirr(rcf)
    } else if (hasInvestment && !hasProceeds) {
      // Investment cash flows exist but proceeds aren't attributed to this round yet.
      // Fall back to round-level totals if we have proceeds date + amounts.
      const totalRoundProceeds = round.totalRealized
      if (totalRoundProceeds > 0 && round.proceedsDate) {
        round.grossIrr = xirr([...rcf, { date: new Date(round.proceedsDate), amount: totalRoundProceeds }])
      } else if (companyStatus !== 'exited' && round.currentValue > 0) {
        round.grossIrr = xirr([...rcf, { date: asOfDate, amount: round.currentValue }])
      }
    }
  }

  let fmv: number
  if (companyStatus === 'exited') {
    fmv = totalRealized
  } else if (companyStatus === 'written-off') {
    fmv = 0
  } else {
    fmv = unrealizedValue
  }

  const moic = totalInvested > 0 ? (totalRealized + unrealizedValue) / totalInvested : null

  // Compute gross IRR
  let grossIrr: number | null = null
  if (cashFlows.length > 0) {
    const terminalValue = companyStatus === 'written-off' ? 0 : unrealizedValue
    if (terminalValue > 0 || totalRealized > 0) {
      if (companyStatus !== 'exited' && terminalValue > 0) {
        cashFlows.push({ date: asOfDate, amount: terminalValue })
      }
      grossIrr = xirr(cashFlows)
    }
  }

  return {
    totalInvested,
    totalIncomeBasis,
    totalIncome,
    totalShares,
    totalRealized,
    totalWrittenOff,
    latestSharePrice,
    unrealizedValue,
    fmv,
    moic,
    grossIrr,
    rounds,
  }
}


// ---------------------------------------------------------------------------
// Effective status — what the tracker shows, regardless of the status column
// ---------------------------------------------------------------------------

const BASIS_EPSILON = 0.01

/**
 * The position state as the transactions tell it. `companies.status` is a hand-set column and
 * can lag the ledger: a company whose every dollar of basis has been exited or written off is
 * not "active". Read-only — nothing is written back.
 *
 * "Closed out" = there was invested basis (summary rounds, so fees, conversions and in-kind
 * income are counted as computeSummary counts them) and the cost basis exited across the
 * proceeds rows covers all of it. Closed out with nothing received (proceeds_received +
 * proceeds_escrow == 0) and a write-off or exited basis on record is 'written-off'; otherwise
 * 'exited'. A partial exit, no transactions, or a status already 'exited'/'written-off' is
 * returned unchanged.
 */
export function effectiveCompanyStatus(
  transactions: InvestmentTransaction[],
  status: CompanyStatus,
): CompanyStatus {
  if (status !== 'active' || transactions.length === 0) return status

  const summary = computeSummary(transactions, status)
  const basis = summary.rounds.reduce((sum, r) => sum + r.investmentCost, 0)
  if (basis <= BASIS_EPSILON) return status

  let exitedBasis = 0
  let received = 0
  for (const t of transactions) {
    if (t.transaction_type !== 'proceeds') continue
    exitedBasis += Math.abs(t.cost_basis_exited ?? 0)
    received += (t.proceeds_received ?? 0) + (t.proceeds_escrow ?? 0)
  }
  if (basis - exitedBasis > BASIS_EPSILON) return status

  if (received === 0 && (summary.totalWrittenOff > 0 || exitedBasis > 0)) return 'written-off'
  return 'exited'
}

export const NEW_COMPANY_WINDOW_DAYS = 90

/**
 * "New" only when the company's first investment (created_at when it has none) is within the
 * last 90 days. A years-old holding with no metrics yet is just unreported, not new.
 */
export function isNewCompany(
  firstInvestmentDate: string | null,
  createdAt: string | null,
  now: Date = new Date(),
): boolean {
  const anchor = firstInvestmentDate ?? createdAt
  if (!anchor) return false
  const t = new Date(anchor).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t <= NEW_COMPANY_WINDOW_DAYS * 24 * 60 * 60 * 1000
}
