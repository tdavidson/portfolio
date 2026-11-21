// Carried interest: the carry the package allocates follows the vehicle's carry terms and the books.
//
// - A vehicle with no carry terms shows no carry.
// - A partner the terms charge no carry (a recipient, unless the GP commit bears carry, or a
//   partner left out of carry) isn't charged any.
// - When a carry recipient is in the package, what the LPs are charged and what the recipients
//   receive net to zero.
// - Where the books hold carry for the period (the close accrues it with the vehicle's waterfall),
//   each partner's carry matches the books.

import { citesFor, compare } from '../compare'
import type { Finding } from '../types'
import { fundSubject, partnerSubject, push, type Check } from './shared'

const r2 = (n: number) => Math.round(n * 100) / 100

export const carry: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  const partners = pkg.partners ?? []
  const terms = shadow?.terms ?? null
  const no = (note: string) => ({ outcome: { check: 'carry' as const, ran: false, compared: 0, note }, findings })
  if (!partners.length) return no('The package has no partner capital accounts.')

  const stating = partners.filter(p => p.allocations?.carry != null)
  const booksCarry = new Map((shadow?.partners ?? []).map(b => [b.lpEntityId, b.carry ?? 0]))
  const booksHaveCarry = [...booksCarry.values()].some(v => Math.abs(v) > 0.01)
  if (!stating.length && !booksHaveCarry) return no('Neither the package nor the books show carried interest for the period.')

  let compared = 0
  const notes: string[] = []
  if (!terms) notes.push("The vehicle's carry terms couldn't be read.")

  // No carry terms, yet the package allocates carry.
  const noCarry = terms && (terms.carry.kind === 'none' || terms.carry.rate <= 0)
  if (noCarry && stating.length) {
    const charged = r2(stating.reduce((s, p) => s + Math.min(0, p.allocations!.carry!), 0))
    compared++
    push(findings, compare(ctx, {
      check: 'carry', subject: fundSubject(), stated: charged, expected: 0,
      message: s => `The package charges ${s} of carried interest, but the vehicle has no carry terms.`,
    }))
  }

  // Carry charged to a partner the terms charge none.
  if (terms && !noCarry) {
    const free = new Set(terms.carry.carryFree)
    const recipients = new Set(terms.carry.recipients)
    for (const p of stating) {
      if (!p.lpEntityId || !free.has(p.lpEntityId)) continue
      const v = p.allocations!.carry!
      // A recipient's positive carry is what it receives, not a charge.
      if (recipients.has(p.lpEntityId) && v >= 0) continue
      compared++
      push(findings, compare(ctx, {
        check: 'carry', subject: partnerSubject(p), stated: v, expected: 0,
        message: s => `${p.name} is charged ${s} of carried interest, but the terms charge them none.`,
        cites: citesFor(p, ['allocations.carry']),
      }))
    }
    // Charged and received net to zero when a recipient is in the package.
    if (stating.some(p => p.lpEntityId && recipients.has(p.lpEntityId))) {
      const net = stating.reduce((s, p) => s + p.allocations!.carry!, 0)
      compared++
      push(findings, compare(ctx, {
        check: 'carry', subject: fundSubject(), stated: net, expected: 0, terms: stating.length,
        message: s => `The carry charged to the partners and the carry the recipients receive don't net to zero: ${s} is left over.`,
      }))
    }
  }

  // Against the books.
  if (booksHaveCarry) {
    let unmatched = 0
    const seen = new Set<string>()
    for (const p of partners) {
      if (!p.lpEntityId) { if (p.allocations?.carry != null) unmatched++; continue }
      seen.add(p.lpEntityId)
      const books = booksCarry.get(p.lpEntityId) ?? 0
      const stated = p.allocations?.carry
      if (stated == null && (Math.abs(books) <= 0.01 || !p.allocations)) continue
      compared++
      push(findings, compare(ctx, {
        check: 'carry', subject: partnerSubject(p), stated: stated ?? 0, expected: books,
        message: (s, e, d) => stated == null
          ? `The package shows no carried interest for ${p.name}, but the books accrue ${e} for the period.`
          : `${p.name}'s carried interest is ${s}, but the books accrue ${e} for the period (${d} apart).`,
        cites: citesFor(p, ['allocations.carry']),
      }))
    }
    if (unmatched) notes.push(`${unmatched} partner${unmatched === 1 ? ' is' : 's are'} not matched to a partner in the app, so their carry wasn't compared with the books.`)
  } else if (stating.length && terms && !noCarry) {
    notes.push("The books hold no carry for the period, so the package's carry wasn't compared with the waterfall. Close the period to accrue it.")
  }

  if (!compared) return no(notes.join(' ') || 'Nothing to compare.')
  return { outcome: { check: 'carry', ran: true, compared, ...(notes.length ? { note: notes.join(' ') } : {}) }, findings }
}
