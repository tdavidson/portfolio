// Cash: the package's ending cash matches the books and, where the bank feed reaches the period end,
// the bank. The package's cash comes from its cash lines, else from the balance sheet's asset lines
// whose label says cash.

import { compare } from '../compare'
import type { Citation, Finding } from '../types'
import { fundSubject, push, type Check } from './shared'

export const cash: Check = ({ pkg, shadow }, ctx) => {
  const findings: Finding[] = []
  let lines: { amount: number; cite?: Citation }[] = (pkg.cash ?? []).map(c => ({ amount: c.balance, cite: c.cite }))
  let from = 'cash lines'
  if (!lines.length) {
    lines = (pkg.fund?.balanceSheet?.assets ?? []).filter(l => /\bcash\b/i.test(l.label)).map(l => ({ amount: l.amount, cite: l.cite }))
    from = 'balance sheet'
  }
  if (!lines.length) {
    return { outcome: { check: 'cash', ran: false, compared: 0, note: 'The package states no cash balance.' }, findings }
  }
  if (!shadow?.cash) {
    return { outcome: { check: 'cash', ran: false, compared: 0, note: "The app's books hold no cash account for this vehicle." }, findings }
  }
  const stated = lines.reduce((s, l) => s + l.amount, 0)
  const cites = lines.flatMap(l => (l.cite ? [l.cite] : []))
  let compared = 1
  push(findings, compare(ctx, {
    check: 'cash', subject: fundSubject('Cash'), stated, expected: shadow.cash.ledger, terms: lines.length,
    message: (s, e, d) => `Cash at the period end is ${s} per the package's ${from}, but the books hold ${e} (${d} apart).`,
    cites,
  }))
  if (shadow.cash.bank != null) {
    compared++
    push(findings, compare(ctx, {
      check: 'cash', subject: fundSubject('Cash'), stated, expected: shadow.cash.bank, terms: lines.length,
      message: (s, e, d) => `Cash at the period end is ${s} per the package, but the bank feed shows ${e} (${d} apart).`,
      cites,
    }))
  }
  return {
    outcome: {
      check: 'cash', ran: true, compared,
      ...(shadow.cash.bank == null ? { note: "The bank feed doesn't reach the period end, so cash was compared with the books only." } : {}),
    },
    findings,
  }
}
