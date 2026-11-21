// Running every check on one package. Pure: the caller loads the prior package and the app's
// partners (store.ts) and passes them in.

import { contextFor } from './compare'
import { completeness } from './checks/completeness'
import { continuity } from './checks/continuity'
import { foots } from './checks/foots'
import { partnersSum } from './checks/partners-sum'
import { rollForward } from './checks/roll-forward'
import { ledgerFlows } from './checks/ledger-flows'
import { cash } from './checks/cash'
import { soi } from './checks/soi'
import { watchedAccounts } from './checks/watched-accounts'
import type { Check, CheckInput } from './checks/shared'
import { DEFAULT_MATERIALITY, ROUNDING_TOLERANCE, type CheckOutcome, type Finding, type KnownAdjustment, type Materiality, type Severity, type StatementPackage } from './types'

/**
 * In the order a reviewer reads them: does it add up, does it roll, does it carry on, is everyone
 * there; then does it agree with the books, the bank and the portfolio; then the accounts the
 * reviewer asked to watch.
 */
export const CHECKS: Check[] = [foots, partnersSum, rollForward, continuity, completeness, ledgerFlows, cash, soi, watchedAccounts]

/**
 * The known adjustment that explains a finding, if any. An adjustment matches on every part it
 * names (check, part of the subject, the difference within its tolerance) and must name at least
 * one of subject and amount, so a bare check name can't wave a whole check through.
 */
export function adjustmentFor(f: Finding, adjustments: KnownAdjustment[]): KnownAdjustment | null {
  for (const a of adjustments) {
    if (a.subject == null && a.amount == null) continue
    if (a.check && a.check !== f.check) continue
    if (a.subject && !f.subject.label.toLowerCase().includes(a.subject.trim().toLowerCase())) continue
    if (a.amount != null) {
      if (f.difference == null) continue
      const tol = Math.max(ROUNDING_TOLERANCE, a.tolerance ?? 0)
      // Either sign: a reviewer writes the difference the way they think of it.
      if (Math.abs(Math.abs(f.difference) - Math.abs(a.amount)) > tol) continue
    }
    return a
  }
  return null
}

/** Mark the findings a known adjustment explains: explained, noted, and information rather than an error. */
export function applyAdjustments(findings: Finding[], adjustments: KnownAdjustment[]): Finding[] {
  if (!adjustments.length) return findings
  return findings.map(f => {
    if (f.check === 'watched_accounts' && f.severity === 'info') return f
    const a = adjustmentFor(f, adjustments)
    if (!a) return f
    return { ...f, adjustedFrom: f.severity, severity: 'info', status: 'explained', note: `Known adjustment: ${a.description}` }
  })
}

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
  const adjusted = applyAdjustments(findings, input.settings?.adjustments ?? [])
  // Worst first, keeping each check's own order within a severity.
  const sorted = adjusted.map((f, i) => ({ f, i })).sort((a, b) => ORDER[a.f.severity] - ORDER[b.f.severity] || a.i - b.i).map(x => x.f)
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of sorted) counts[f.severity]++
  return { checks, findings: sorted, counts, nav, threshold: ctx.threshold }
}
