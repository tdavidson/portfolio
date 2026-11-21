// Allocations: income, expenses and gains are split across the partners the way the vehicle's terms
// say. Each category's total, as the package states it across its partners, is shared out on the
// allocation basis (commitments, or capital balances) with the partner terms applied: a partner left
// out of a category gets nothing, a negotiated weight replaces the basis. Each partner's stated share
// is compared with that.
//
// The management fee and carry have their own checks. Without the app's terms, the package's own
// commitments are the basis and no partner is left out.

import { allocationWeights, type PartnerTerms } from '@/lib/accounting/terms'
import { citesFor, compare } from '../compare'
import type { AllocationKey, Finding, PartnerStatement, TermsCategory } from '../types'
import { partnerSubject, push, type Check } from './shared'

const CATEGORIES: { key: AllocationKey; category: TermsCategory; label: string }[] = [
  { key: 'income', category: 'income', label: 'income' },
  { key: 'expenses', category: 'partnership_expense', label: 'expenses' },
  { key: 'realized', category: 'realized_gain', label: 'realized gain' },
  { key: 'unrealized', category: 'valuation', label: 'unrealized gain' },
]

const keyOf = (p: PartnerStatement) => p.lpEntityId ?? `ext:${p.externalId}`

export const allocation: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  const partners = (pkg.partners ?? []).filter(p => p.allocations)
  const no = (note: string) => ({ outcome: { check: 'allocation' as const, ran: false, compared: 0, note }, findings })
  if (partners.length < 2) return no('The package needs allocations for at least two partners to check how they were split.')

  const terms = shadow?.terms ?? null
  const basis = terms?.basis ?? 'commitment'
  const notes: string[] = []
  if (!terms) notes.push("The vehicle's terms couldn't be read, so the package's own commitments were used as the basis.")

  // Each partner's basis amount. Capital balances: the balance before the period's allocations.
  const basisOf = (p: PartnerStatement): number | null => {
    if (basis === 'capital_balance') {
      if (p.beginning == null) return null
      return p.beginning + (p.contributions ?? 0) - (p.distributions ?? 0)
    }
    const fromApp = p.lpEntityId && terms ? terms.commitments[p.lpEntityId] : undefined
    return fromApp ?? p.commitment ?? null
  }
  const inputs = partners.map(p => ({ p, amount: basisOf(p) }))
  const missing = inputs.filter(i => i.amount == null)
  if (missing.length === inputs.length) {
    return no(basis === 'capital_balance'
      ? 'The vehicle splits on capital balances, but the package states no beginning capital.'
      : 'Neither the package nor the app gives the partners\' commitments.')
  }
  if (missing.length) notes.push(`${missing.length} partner${missing.length === 1 ? ' has' : 's have'} no ${basis === 'capital_balance' ? 'beginning capital' : 'commitment'}, so the split was checked without them.`)
  const usable = inputs.filter(i => i.amount != null)
  const partnerTerms = (terms?.partnerTerms ?? []) as PartnerTerms[]
  const approx = basis === 'capital_balance'

  let compared = 0
  for (const c of CATEGORIES) {
    if (!usable.some(i => i.p.allocations?.[c.key] != null)) continue
    const total = usable.reduce((s, i) => s + (i.p.allocations?.[c.key] ?? 0), 0)
    if (Math.abs(total) <= 0.01) continue
    const weights = allocationWeights(usable.map(i => ({ lpEntityId: keyOf(i.p), basisAmount: i.amount! })), partnerTerms, c.category as any)
    const sum = weights.reduce((s, w) => s + w.commitment, 0)
    if (sum <= 0) continue
    const share = new Map(weights.map(w => [w.lpEntityId, w.commitment / sum]))
    for (const { p } of usable) {
      compared++
      const w = share.get(keyOf(p)) ?? 0
      const expected = total * w
      const f = compare(ctx, {
        check: 'allocation', subject: partnerSubject(p), stated: p.allocations?.[c.key] ?? 0, expected, terms: 3,
        message: (s, e, d) => w === 0
          ? `${p.name} is allocated ${s} of ${c.label}, but the terms leave them out of it (${d} apart).`
          : `${p.name} is allocated ${s} of ${c.label}; a ${(w * 100).toFixed(2)}% share on ${basis === 'capital_balance' ? 'capital balances' : 'commitments'} is ${e} (${d} apart).`,
        cites: citesFor(p, [`allocations.${c.key}`]),
      })
      // Capital balances are measured from the package, not the close's own balances, so a
      // difference there is worth a look rather than an error.
      if (f && approx && f.severity === 'error') f.severity = 'warning'
      push(findings, f)
    }
  }
  if (!compared) return no('The package allocates no income, expenses or gains for the period.')
  return { outcome: { check: 'allocation', ran: true, compared, ...(notes.length ? { note: notes.join(' ') } : {}) }, findings }
}
