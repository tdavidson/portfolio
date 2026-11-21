// Contributions and distributions: each partner's flows for the period match the app's books.
//
// The books are the shadow's partners: contributions and distributions posted to each partner's
// capital in the period. A partner the books show money moving for who isn't in the package is
// flagged too. Runs only when the books hold capital activity for the vehicle.

import { citesFor, compare, fmt, tolerance } from '../compare'
import type { Finding } from '../types'
import { partnerSubject, push, type Check } from './shared'

export const ledgerFlows: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  const partners = pkg.partners ?? []
  if (!partners.length) {
    return { outcome: { check: 'ledger_flows', ran: false, compared: 0, note: 'The package has no partner capital accounts.' }, findings }
  }
  if (!shadow?.partners) {
    return { outcome: { check: 'ledger_flows', ran: false, compared: 0, note: "The app's books hold no capital activity for this vehicle to compare with." }, findings }
  }
  if (!partners.some(p => p.contributions != null || p.distributions != null)) {
    return { outcome: { check: 'ledger_flows', ran: false, compared: 0, note: "The package states no contributions or distributions for the period." }, findings }
  }

  const books = new Map(shadow.partners.map(p => [p.lpEntityId, p]))
  const seen = new Set<string>()
  let compared = 0
  let unmatched = 0
  for (const p of partners) {
    if (!p.lpEntityId) { unmatched++; continue }
    seen.add(p.lpEntityId)
    const b = books.get(p.lpEntityId) ?? { contributions: 0, distributions: 0 }
    for (const [field, label] of [['contributions', 'contributions'], ['distributions', 'distributions']] as const) {
      const stated = p[field]
      if (stated == null) continue
      compared++
      push(findings, compare(ctx, {
        check: 'ledger_flows', subject: partnerSubject(p), stated, expected: b[field],
        message: (s, e, d) => `${p.name}'s ${label} for the period are ${s}, but the books record ${e} (${d} apart).`,
        cites: citesFor(p, [field]),
      }))
    }
  }
  for (const b of shadow.partners) {
    if (seen.has(b.lpEntityId)) continue
    if (Math.abs(b.contributions) <= tolerance() && Math.abs(b.distributions) <= tolerance()) continue
    compared++
    findings.push({
      check: 'ledger_flows', severity: 'error', subject: { kind: 'partner', id: b.lpEntityId, label: b.name },
      message: `The books record ${b.contributions ? `contributions of ${fmt(b.contributions)}` : ''}${b.contributions && b.distributions ? ' and ' : ''}${b.distributions ? `distributions of ${fmt(b.distributions)}` : ''} for ${b.name} this period, but the package has no capital account for them.`,
      cites: [], status: 'open',
    })
  }
  return {
    outcome: {
      check: 'ledger_flows', ran: compared > 0, compared,
      ...(unmatched ? { note: `${unmatched} partner${unmatched === 1 ? ' is' : 's are'} not matched to a partner in the app, so their flows weren't compared.` } : {}),
    },
    findings,
  }
}
