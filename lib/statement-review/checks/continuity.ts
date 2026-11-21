// Continuity: this period picks up where the last one left off: the last signed-off period, or before
// anything is signed off, the latest earlier review.
//
//   - each partner's beginning capital is last period's ending capital
//   - paid-in to date is last period's plus this period's contributions (or at least no lower)
//   - distributions to date likewise
//   - commitment is unchanged, or the change is flagged for a transfer or an amendment to explain
//   - a partner with capital last period who is missing now is flagged
//
// Partners are paired across periods by the app partner they matched, else by the package's id.

import { citesFor, compare, fmt, tolerance } from '../compare'
import type { Finding, PartnerStatement } from '../types'
import { partnerSubject, push, type Check } from './shared'

const keyOf = (p: PartnerStatement) => p.lpEntityId ? `lp:${p.lpEntityId}` : `ext:${p.externalId}`

export const continuity: Check = ({ pkg, prior }, ctx) => {
  const findings: Finding[] = []
  const partners = pkg.partners ?? []
  if (!partners.length) {
    return { outcome: { check: 'continuity', ran: false, compared: 0, note: 'The package has no partner capital accounts.' }, findings }
  }
  if (!prior || !prior.partners.length) {
    return { outcome: { check: 'continuity', ran: false, compared: 0, note: 'There is no earlier review of this vehicle to carry on from.' }, findings }
  }

  let compared = 0
  const before = new Map(prior.partners.map(p => [keyOf(p), p]))
  const priorCite = { document: `Review for ${prior.periodEnd}` }

  for (const p of partners) {
    const b = before.get(keyOf(p))
    before.delete(keyOf(p))
    if (!b) continue
    const subject = partnerSubject(p)

    if (p.beginning != null && b.ending != null) {
      compared++
      push(findings, compare(ctx, {
        check: 'continuity', subject, stated: p.beginning, expected: b.ending,
        message: (s, e, d) => `${p.name}'s beginning capital is ${s}, but the ${prior.periodEnd} statement ended at ${e} (${d} apart).`,
        cites: [...citesFor(p, ['beginning']), priorCite],
      }))
    }

    for (const [toDate, flow, label] of [
      ['paidInToDate', 'contributions', 'paid-in to date'],
      ['distributedToDate', 'distributions', 'distributions to date'],
    ] as const) {
      const now = p[toDate]
      const was = b[toDate]
      if (now == null || was == null) continue
      compared++
      if (p[flow] != null) {
        push(findings, compare(ctx, {
          check: 'continuity', subject, stated: now, expected: was + (p[flow] as number), terms: 2,
          message: (s, e, d) => `${p.name}'s ${label} is ${s}, but ${prior.periodEnd}'s plus this period's ${flow} comes to ${e} (${d} apart).`,
          cites: [...citesFor(p, [toDate, flow]), priorCite],
        }))
      } else if (now < was - tolerance()) {
        findings.push({
          check: 'continuity', severity: 'error', subject, stated: now, expected: was, difference: Math.round((now - was) * 100) / 100,
          message: `${p.name}'s ${label} fell from ${fmt(was)} at ${prior.periodEnd} to ${fmt(now)}; a to-date total shouldn't go down.`,
          cites: [...citesFor(p, [toDate]), priorCite], status: 'open',
        })
      }
    }

    if (p.commitment != null && b.commitment != null) {
      compared++
      const d = Math.round((p.commitment - b.commitment) * 100) / 100
      if (Math.abs(d) > tolerance()) {
        findings.push({
          check: 'continuity', severity: 'warning', subject, stated: p.commitment, expected: b.commitment, difference: d,
          message: `${p.name}'s commitment moved from ${fmt(b.commitment)} to ${fmt(p.commitment)}; check for a transfer or an amended subscription.`,
          cites: [...citesFor(p, ['commitment']), priorCite], status: 'open',
        })
      }
    }
  }

  // Partners last period who are gone now. Only those who had capital or a commitment left.
  for (const b of Array.from(before.values())) {
    const left = Math.abs(b.ending ?? 0) > tolerance() || Math.abs(b.commitment ?? 0) > tolerance()
    if (!left) continue
    compared++
    findings.push({
      check: 'continuity', severity: 'error', subject: partnerSubject(b),
      ...(b.ending != null ? { expected: b.ending } : {}),
      message: `${b.name} ended ${prior.periodEnd} with ${b.ending != null ? `capital of ${fmt(b.ending)}` : 'a commitment'} but isn't in this package.`,
      cites: [priorCite], status: 'open',
    })
  }

  return { outcome: { check: 'continuity', ran: true, compared, note: prior.signedOff === false
    ? `Compared with the latest review for ${prior.periodEnd}, which isn't signed off.`
    : `Compared with the signed-off review for ${prior.periodEnd}.` }, findings }
}
