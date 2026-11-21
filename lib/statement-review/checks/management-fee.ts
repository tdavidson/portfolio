// Management fee: each partner's fee for the period matches what the vehicle's fee schedule charges.
//
// The expected fee is the shadow's: the schedule (basis, rate, step-downs, offsets and side letters)
// run for each fee period that starts in the review period, the same figures the close books. The
// package states a fee as an allocation that reduces the account, so it is compared negated. Where
// the package gives no fee per partner, the fund's stated total is compared instead.

import { citesFor, compare } from '../compare'
import type { Finding } from '../types'
import { fundSubject, partnerSubject, push, type Check } from './shared'

const r2 = (n: number) => Math.round(n * 100) / 100

export const managementFee: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  const no = (note: string) => ({ outcome: { check: 'management_fee' as const, ran: false, compared: 0, note }, findings })
  const terms = shadow?.terms
  if (!terms) return no("The vehicle's terms couldn't be read.")
  if (!terms.fees) return no(terms.feeNote ?? 'The vehicle has no fee schedule.')

  const expected = new Map(terms.fees.map(f => [f.lpEntityId, f.fee]))
  const expectedTotal = r2(terms.fees.reduce((s, f) => s + f.fee, 0))
  const partners = pkg.partners ?? []
  const stating = partners.filter(p => p.allocations?.managementFee != null)

  if (stating.length) {
    let compared = 0
    let unmatched = 0
    for (const p of stating) {
      if (!p.lpEntityId) { unmatched++; continue }
      compared++
      const fee = expected.get(p.lpEntityId) ?? 0
      push(findings, compare(ctx, {
        check: 'management_fee', subject: partnerSubject(p), stated: p.allocations!.managementFee!, expected: -fee,
        message: (s, e, d) => `${p.name}'s management fee is ${s}, but the fee schedule charges ${e} for the period (${d} apart).`,
        cites: citesFor(p, ['allocations.managementFee']),
      }))
    }
    // A partner the schedule charges who the package shows no fee for.
    const stated = new Set(stating.map(p => p.lpEntityId).filter(Boolean))
    for (const p of partners) {
      if (!p.lpEntityId || stated.has(p.lpEntityId) || !p.allocations) continue
      const fee = expected.get(p.lpEntityId) ?? 0
      if (Math.abs(fee) <= 0.01) continue
      compared++
      push(findings, compare(ctx, {
        check: 'management_fee', subject: partnerSubject(p), stated: 0, expected: -fee,
        message: (_s, e) => `The package shows no management fee for ${p.name}, but the fee schedule charges ${e} for the period.`,
      }))
    }
    const note = [
      unmatched ? `${unmatched} partner${unmatched === 1 ? ' is' : 's are'} not matched to a partner in the app, so their fee wasn't compared.` : '',
      terms.feeNote ?? '',
    ].filter(Boolean).join(' ')
    return { outcome: { check: 'management_fee', ran: compared > 0, compared, ...(note ? { note } : {}) }, findings }
  }

  const fund = pkg.fund?.partnersCapital ?? pkg.fund?.partnerTotals
  const total = fund?.allocations?.managementFee
  if (total == null) return no('The package states no management fee, by partner or for the fund.')
  push(findings, compare(ctx, {
    check: 'management_fee', subject: fundSubject(), stated: total, expected: -expectedTotal, terms: terms.fees.length,
    message: (s, e, d) => `The fund's management fee is ${s}, but the fee schedule charges ${e} for the period (${d} apart).`,
    cites: citesFor(fund, ['allocations.managementFee']),
  }))
  return { outcome: { check: 'management_fee', ran: true, compared: 1, note: 'The package gives the fee for the fund only, so the total was compared.' }, findings }
}
