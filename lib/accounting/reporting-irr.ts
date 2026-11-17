import { xirr } from '@/lib/xirr'
import type { CapitalPosting } from './capital-account'
import { isIrrFlow } from './irr-flows'
import type { CapitalEvidence } from './capital-evidence'

/**
 * A partner's IRR is an annual rate, and annualizing a very short history inflates it: 5,000 paid
 * in five days before the report date and worth 5,175 on it reads as about 1,130%. So a partner
 * (or a fund) whose first cash flow is less than three months before the report date has no IRR
 * yet. From three months on the IRR is shown, annualized, even inside the first year; the fund
 * chose that over the GIPS convention of waiting a full year, so new SPVs report a rate.
 */
export const IRR_MIN_HISTORY_DAYS = 90

export function tooNewForIrr(flows: { date: Date }[], asOf: Date): boolean {
  if (flows.length === 0) return true
  const first = Math.min(...flows.map(f => f.date.getTime()))
  return asOf.getTime() - first < IRR_MIN_HISTORY_DAYS * 86_400_000
}

/**
 * Shared across LP reports, capital statements, fund summaries, and charts. `postings` are one
 * partner's rows from `irrFlowPostings` (lib/accounting/irr-flows.ts), so an assignment's history has
 * already moved to its new holder.
 */
export function reportingIrr(postings: CapitalPosting[], nav: number, evidence: CapitalEvidence | undefined): number | null {
  if (!evidence || evidence.missing.length > 0) return null
  if (evidence.basis === 'reported') return evidence.reportedIrr
  // A disagreement with an imported figure is a warning, not a veto: the books are the record.
  if (!evidence.canCalculateIrr) return evidence.reportedIrr
  if (!evidence.asOf) return null
  const flows = postings.flatMap(p => p.entryDate && isIrrFlow(p)
    ? [{ date: new Date(p.entryDate + 'T00:00:00Z'), amount: p.amount }] : [])
  const asOf = new Date(evidence.asOf + 'T00:00:00Z')
  if (tooNewForIrr(flows, asOf)) return null
  if (Math.abs(nav) >= 0.005) flows.push({ date: asOf, amount: nav })
  return flows.length >= 2 ? xirr(flows) : null
}
