// Roll-forward: beginning + contributions − distributions ± allocations = ending, for each partner,
// for the partner schedule's total row and for the fund. And unfunded = commitment − paid-in to date
// where all three are stated.
//
// A partner's blank contributions or distributions read as none, but only when the package states
// that column for someone: a package with no distributions column at all can't be rolled forward.

import { citesFor, compare, netAllocation } from '../compare'
import type { CapitalFigures, Finding } from '../types'
import { fundSubject, partnerSubject, push, type Check } from './shared'

export const rollForward: Check = ({ pkg }, ctx) => {
  const findings: Finding[] = []
  let compared = 0
  const partners = pkg.partners ?? []
  const fund = pkg.fund ?? {}
  const sets: { f: CapitalFigures; subject: Finding['subject']; who: string }[] = [
    ...partners.map(p => ({ f: p as CapitalFigures, subject: partnerSubject(p), who: `${p.name}'s` })),
    ...(fund.partnerTotals ? [{ f: fund.partnerTotals, subject: fundSubject('Partner schedule total'), who: "The partner schedule's total" }] : []),
    ...(fund.partnersCapital ? [{ f: fund.partnersCapital, subject: fundSubject(), who: "The fund's" }] : []),
  ]
  if (!sets.length) {
    return { outcome: { check: 'roll_forward', ran: false, compared: 0, note: 'The package has no capital accounts.' }, findings }
  }

  const has = (k: 'contributions' | 'distributions') => sets.some(s => s.f[k] != null)
  const flowsStated = has('contributions') && has('distributions')
  const missing: string[] = []
  if (!sets.some(s => s.f.beginning != null)) missing.push('beginning capital')
  if (!sets.some(s => s.f.ending != null)) missing.push('ending capital')
  if (!flowsStated) missing.push(!has('contributions') && !has('distributions') ? 'contributions and distributions' : !has('contributions') ? 'contributions' : 'distributions')
  if (!sets.some(s => netAllocation(s.f))) missing.push('allocations')

  let skipped = 0
  if (!missing.length) {
    for (const { f, subject, who } of sets) {
      const net = netAllocation(f)
      if (f.beginning == null || f.ending == null || !net) { skipped++; continue }
      const expected = f.beginning + (f.contributions ?? 0) - (f.distributions ?? 0) + net.value
      compared++
      push(findings, compare(ctx, {
        check: 'roll_forward', subject, stated: f.ending, expected, terms: 3 + net.terms,
        message: (s, e, d) => `${who} ending capital is ${s}, but beginning capital plus contributions, less distributions, plus allocations comes to ${e} (${d} apart).`,
        cites: citesFor(f, ['ending', 'beginning', 'contributions', 'distributions', 'allocations.total']),
      }))
    }
  }

  // Unfunded commitment, where commitment, paid-in to date and unfunded are all stated.
  for (const { f, subject, who } of sets) {
    if (f.commitment == null || f.paidInToDate == null || f.unfunded == null) continue
    compared++
    push(findings, compare(ctx, {
      check: 'roll_forward', subject, stated: f.unfunded, expected: f.commitment - f.paidInToDate, terms: 2,
      message: (s, e, d) => `${who} unfunded commitment is ${s}, but commitment less paid-in to date is ${e} (${d} apart).`,
      cites: citesFor(f, ['unfunded', 'commitment', 'paidInToDate']),
    }))
  }

  const notes: string[] = []
  if (missing.length) notes.push(`The capital roll-forward needs ${missing.join(', ')}, which the package doesn't state.`)
  if (skipped) notes.push(`${skipped} account${skipped === 1 ? ' was' : 's were'} left out for a blank beginning, ending or allocation.`)
  return {
    outcome: { check: 'roll_forward', ran: compared > 0, compared, ...(notes.length ? { note: notes.join(' ') } : {}) },
    findings,
  }
}
