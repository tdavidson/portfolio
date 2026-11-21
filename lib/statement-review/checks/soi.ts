// Schedule of investments: each holding's cost and fair value match the app's portfolio tracker as
// of the period end, every holding the app carries is in the schedule, and nothing unknown is.
// Holdings are paired by name (case and punctuation ignored). When the package gives only totals,
// the totals are compared.
//
// Whether a new mark has support is left to the valuation policy work (stage 3).

import { citesFor, compare, fmt, tolerance } from '../compare'
import type { Finding } from '../types'
import { fundSubject, normName, push, type Check } from './shared'

export const soi: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  const lines = pkg.holdings ?? []
  const totals = pkg.fund?.soi
  if (!lines.length && totals?.cost == null && totals?.fairValue == null) {
    return { outcome: { check: 'soi', ran: false, compared: 0, note: 'The package has no schedule of investments.' }, findings }
  }
  if (!shadow?.holdings) {
    return { outcome: { check: 'soi', ran: false, compared: 0, note: "The app's portfolio holds no investments for this vehicle to compare with." }, findings }
  }
  const held = new Map(shadow.holdings.map(h => [normName(h.name), h]))
  let compared = 0

  if (!lines.length) {
    for (const key of ['cost', 'fairValue'] as const) {
      const stated = totals?.[key]
      if (stated == null) continue
      compared++
      push(findings, compare(ctx, {
        check: 'soi', subject: fundSubject('Schedule of investments'), stated,
        expected: shadow.holdings.reduce((s, h) => s + h[key], 0), terms: shadow.holdings.length,
        message: (s, e, d) => `The schedule's total ${key === 'cost' ? 'cost' : 'fair value'} is ${s}, but the portfolio carries ${e} (${d} apart).`,
        cites: citesFor(totals, [key]),
      }))
    }
    return { outcome: { check: 'soi', ran: compared > 0, compared, note: 'The package gives only totals, so holdings were not compared one by one.' }, findings }
  }

  const seen = new Set<string>()
  for (const line of lines) {
    const h = held.get(normName(line.name))
    const subject: Finding['subject'] = { kind: 'holding', ...(h ? { id: h.companyId } : {}), label: line.name }
    const cites = line.cite ? [line.cite] : []
    if (!h) {
      compared++
      findings.push({
        check: 'soi', severity: 'warning', subject,
        message: `${line.name} isn't a holding the app carries for this vehicle; add it, or check the name.`,
        cites, status: 'open',
      })
      continue
    }
    seen.add(normName(line.name))
    for (const key of ['cost', 'fairValue'] as const) {
      const stated = line[key]
      if (stated == null) continue
      compared++
      push(findings, compare(ctx, {
        check: 'soi', subject, stated, expected: h[key],
        message: (s, e, d) => `${line.name}'s ${key === 'cost' ? 'cost' : 'fair value'} is ${s} in the schedule, but the portfolio carries ${e} (${d} apart).`,
        cites,
      }))
    }
  }
  for (const h of shadow.holdings) {
    if (seen.has(normName(h.name))) continue
    if (Math.abs(h.fairValue) <= tolerance() && Math.abs(h.cost) <= tolerance()) continue
    compared++
    findings.push({
      check: 'soi', severity: 'error', subject: { kind: 'holding', id: h.companyId, label: h.name },
      expected: h.fairValue,
      message: `${h.name} is carried at ${fmt(h.fairValue)} (cost ${fmt(h.cost)}) but isn't in the schedule of investments.`,
      cites: [], status: 'open',
    })
  }
  return { outcome: { check: 'soi', ran: true, compared }, findings }
}
