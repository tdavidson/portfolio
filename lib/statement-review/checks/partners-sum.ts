// Partners sum to fund: the partners' capital accounts add up to the fund's own statements.
//
//   - each field of the fund's statement of changes in partners' capital is the sum of the partners'
//   - the balance sheet's partners' capital is the partners' ending capital
//   - the fund's net allocation is the statement of operations' net income

import { citesFor, compare, fieldValue, FIELD_LABELS, netAllocation, SUMMABLE_FIELDS } from '../compare'
import type { Finding } from '../types'
import { fundSubject, push, type Check } from './shared'

export const partnersSum: Check = ({ pkg }, ctx) => {
  const findings: Finding[] = []
  let compared = 0
  const partners = pkg.partners ?? []
  const fund = pkg.fund ?? {}

  if (!partners.length) {
    return { outcome: { check: 'partners_sum', ran: false, compared: 0, note: 'The package has no partner capital accounts.' }, findings }
  }

  const pc = fund.partnersCapital
  if (pc) {
    for (const field of SUMMABLE_FIELDS) {
      const stated = fieldValue(pc, field)
      if (stated == null) continue
      const values = partners.map(p => fieldValue(p, field))
      if (values.every(v => v == null)) continue
      compared++
      push(findings, compare(ctx, {
        check: 'partners_sum', subject: fundSubject("Statement of changes in partners' capital"),
        stated, expected: values.reduce<number>((s, v) => s + (v ?? 0), 0), terms: partners.length,
        message: (s, e, d) => `The fund's ${FIELD_LABELS[field]} is ${s}, but the partners' capital accounts add up to ${e} (${d} apart).`,
        cites: citesFor(pc, [field]),
      }))
    }
  }

  const bs = fund.balanceSheet
  const endings = partners.map(p => p.ending)
  if (bs?.partnersCapital != null && endings.some(v => v != null)) {
    compared++
    push(findings, compare(ctx, {
      check: 'partners_sum', subject: fundSubject('Balance sheet'),
      stated: bs.partnersCapital, expected: endings.reduce<number>((s, v) => s + (v ?? 0), 0), terms: partners.length,
      message: (s, e, d) => `Partners' capital on the balance sheet is ${s}, but the partners' ending capital adds up to ${e} (${d} apart).`,
      cites: citesFor(bs, ['partnersCapital']),
    }))
  }

  const ops = fund.operations
  if (ops?.netIncome != null) {
    // The fund's own statement of changes where it has one; otherwise the partners'.
    const fundNet = pc ? netAllocation(pc) : null
    const partnerNets = partners.map(p => netAllocation(p))
    const expected = fundNet ?? (partnerNets.some(n => n) ? { value: partnerNets.reduce((s, n) => s + (n?.value ?? 0), 0), terms: partners.length } : null)
    if (expected) {
      compared++
      push(findings, compare(ctx, {
        check: 'partners_sum', subject: fundSubject('Statement of operations'),
        stated: ops.netIncome, expected: expected.value, terms: expected.terms + 1,
        message: (s, e, d) => `Net income on the statement of operations is ${s}, but ${fundNet ? 'the fund allocates' : 'the partners are allocated'} ${e} (${d} apart).`,
        cites: citesFor(ops, ['netIncome']),
      }))
    }
  }

  return {
    outcome: compared
      ? { check: 'partners_sum', ran: true, compared }
      : { check: 'partners_sum', ran: false, compared: 0, note: "The package has no fund-level figures to add the partners up to: no statement of changes in partners' capital, balance sheet or statement of operations." },
    findings,
  }
}
