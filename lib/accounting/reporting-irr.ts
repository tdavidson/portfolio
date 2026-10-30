import { xirr } from '@/lib/xirr'
import type { CapitalPosting } from './capital-account'
import { isIrrFlow } from './irr-flows'
import type { CapitalEvidence } from './capital-evidence'

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
  if (Math.abs(nav) >= 0.005) flows.push({ date: new Date(evidence.asOf + 'T00:00:00Z'), amount: nav })
  return flows.length >= 2 ? xirr(flows) : null
}
