// Running every check on one package. Pure: the caller loads the prior package and the app's
// partners (store.ts) and passes them in.

import { contextFor } from './compare'
import { completeness } from './checks/completeness'
import { continuity } from './checks/continuity'
import { foots } from './checks/foots'
import { partnersSum } from './checks/partners-sum'
import { rollForward } from './checks/roll-forward'
import type { Check, CheckInput } from './checks/shared'
import { DEFAULT_MATERIALITY, type CheckOutcome, type Finding, type Materiality, type Severity, type StatementPackage } from './types'

/** In the order a reviewer reads them: does it add up, does it roll, does it carry on, is everyone there. */
export const CHECKS: Check[] = [foots, partnersSum, rollForward, continuity, completeness]

export interface ReviewResult {
  checks: CheckOutcome[]
  findings: Finding[]
  counts: Record<Severity, number>
  /** The NAV materiality was measured against, where the package gives one. */
  nav: number | null
  threshold: number
}

/** The fund's NAV as the package states it: the fund's ending capital, else the balance sheet's, else the partners' sum. */
export function packageNav(pkg: StatementPackage): number | null {
  const f = pkg.fund
  const stated = f?.partnersCapital?.ending ?? f?.balanceSheet?.partnersCapital ?? f?.partnerTotals?.ending
  if (stated != null) return stated
  const endings = (pkg.partners ?? []).map(p => p.ending).filter((v): v is number => v != null)
  return endings.length ? endings.reduce((s, v) => s + v, 0) : null
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function runChecks(input: CheckInput, materiality: Materiality = DEFAULT_MATERIALITY): ReviewResult {
  const nav = packageNav(input.pkg)
  const ctx = contextFor(materiality, nav)
  const checks: CheckOutcome[] = []
  const findings: Finding[] = []
  for (const check of CHECKS) {
    const r = check(input, ctx)
    checks.push(r.outcome)
    findings.push(...r.findings)
  }
  // Worst first, keeping each check's own order within a severity.
  const sorted = findings.map((f, i) => ({ f, i })).sort((a, b) => ORDER[a.f.severity] - ORDER[b.f.severity] || a.i - b.i).map(x => x.f)
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of sorted) counts[f.severity]++
  return { checks, findings: sorted, counts, nav, threshold: ctx.threshold }
}
