import { xirr } from '@/lib/xirr'
import type { CapitalPosting } from './capital-account'
import { isIrrFlow } from './irr-flows'
import type { CapitalEvidence } from './capital-evidence'

/**
 * A partner's IRR is an annual rate, and annualizing less than a year of history inflates it: 5,000
 * paid in five days before the report date and worth 5,175 on it reads as about 1,130%. Performance
 * standards (GIPS) say not to annualize under a year, so a partner whose first cash flow is less than
 * 365 days before the report date has no IRR yet.
 */
export function heldUnderAYear(flows: { date: Date }[], asOf: Date): boolean {
  if (flows.length === 0) return true
  const first = Math.min(...flows.map(f => f.date.getTime()))
  return asOf.getTime() - first < 365 * 86_400_000
}

/**
 * Shared across LP reports, capital statements, fund summaries, and charts. `postings` are one
 * partner's rows from `irrFlowPostings` (lib/accounting/irr-flows.ts), so an assignment's history has
 * already moved to its new holder.
 */
export function reportingIrr(postings: CapitalPosting[], nav: number, evidence: CapitalEvidence | undefined): number | null {
  if (!evidence || evidence.missing.length > 0) return null
  if (evidence.basis === 'reported') return evidence.reportedIrr
  if (evidence.conflict) return null
  if (!evidence.canCalculateIrr) return evidence.reportedIrr
  if (!evidence.asOf) return null
  const flows = postings.flatMap(p => p.entryDate && isIrrFlow(p)
    ? [{ date: new Date(p.entryDate + 'T00:00:00Z'), amount: p.amount }] : [])
  const asOf = new Date(evidence.asOf + 'T00:00:00Z')
  if (heldUnderAYear(flows, asOf)) return null
  if (Math.abs(nav) >= 0.005) flows.push({ date: asOf, amount: nav })
  return flows.length >= 2 ? xirr(flows) : null
}
