// Foots: each statement's lines add up to the totals it states.
//
//   - the partner schedule's total row is the sum of its partners, field by field
//   - a stated net allocation is the sum of its parts (per partner, on the total row, for the fund)
//   - the balance sheet's assets and liabilities add up, and assets less liabilities is partners' capital
//   - the statement of operations' lines add up to net income
//   - the schedule of investments' lines add up to its stated cost and fair value

import { citesFor, compare, fieldValue, FIELD_LABELS, SUMMABLE_FIELDS } from '../compare'
import { ALLOCATION_KEYS, type CapitalFigures, type Finding, type StatedLine } from '../types'
import { fundSubject, partnerSubject, push, type Check } from './shared'

const sum = (lines: StatedLine[]) => lines.reduce((s, l) => s + l.amount, 0)

export const foots: Check = ({ pkg }, ctx) => {
  const findings: Finding[] = []
  let compared = 0
  const partners = pkg.partners ?? []
  const fund = pkg.fund ?? {}

  // The partner schedule's total row.
  const totals = fund.partnerTotals
  if (totals && partners.length) {
    for (const field of SUMMABLE_FIELDS) {
      const stated = fieldValue(totals, field)
      if (stated == null) continue
      const values = partners.map(p => fieldValue(p, field))
      // A column some partners leave blank is still a column: blank reads as nothing.
      if (values.every(v => v == null)) continue
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Partner schedule total'),
        stated, expected: values.reduce<number>((s, v) => s + (v ?? 0), 0), terms: partners.length,
        message: (s, e, d) => `The partner schedule's total ${FIELD_LABELS[field]} is ${s}, but its partners add up to ${e} (${d} apart).`,
        cites: citesFor(totals, [field]),
      }))
    }
  }

  // A stated net allocation against its parts.
  const allocationFoot = (f: CapitalFigures, subject: Finding['subject'], who: string) => {
    const a = f.allocations
    if (!a || a.total == null) return
    const parts = ALLOCATION_KEYS.map(k => a[k]).filter((v): v is number => v != null)
    if (parts.length < 2) return
    compared++
    push(findings, compare(ctx, {
      check: 'foots', subject, stated: a.total, expected: parts.reduce((s, v) => s + v, 0), terms: parts.length,
      message: (s, e, d) => `${who} net allocation is stated as ${s}, but its income, expense and gain lines add up to ${e} (${d} apart).`,
      cites: citesFor(f, ['allocations.total']),
    }))
  }
  for (const p of partners) allocationFoot(p, partnerSubject(p), `${p.name}'s`)
  if (totals) allocationFoot(totals, fundSubject('Partner schedule total'), "The partner schedule's")
  if (fund.partnersCapital) allocationFoot(fund.partnersCapital, fundSubject(), "The fund's")

  // Balance sheet.
  const bs = fund.balanceSheet
  if (bs) {
    if (bs.assets?.length && bs.totalAssets != null) {
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Balance sheet'), stated: bs.totalAssets, expected: sum(bs.assets), terms: bs.assets.length,
        message: (s, e, d) => `Total assets are stated as ${s}, but the asset lines add up to ${e} (${d} apart).`,
        cites: citesFor(bs, ['totalAssets']),
      }))
    }
    if (bs.liabilities?.length && bs.totalLiabilities != null) {
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Balance sheet'), stated: bs.totalLiabilities, expected: sum(bs.liabilities), terms: bs.liabilities.length,
        message: (s, e, d) => `Total liabilities are stated as ${s}, but the liability lines add up to ${e} (${d} apart).`,
        cites: citesFor(bs, ['totalLiabilities']),
      }))
    }
    const assets = bs.totalAssets ?? (bs.assets?.length ? sum(bs.assets) : null)
    const liabilities = bs.totalLiabilities ?? (bs.liabilities ? sum(bs.liabilities) : null)
    if (bs.partnersCapital != null && assets != null && liabilities != null) {
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Balance sheet'), stated: bs.partnersCapital, expected: assets - liabilities, terms: 2,
        message: (s, e, d) => `Partners' capital on the balance sheet is ${s}, but assets less liabilities is ${e} (${d} apart).`,
        cites: citesFor(bs, ['partnersCapital', 'totalAssets', 'totalLiabilities']),
      }))
    }
    if (bs.totalLiabilitiesAndCapital != null && liabilities != null && bs.partnersCapital != null) {
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Balance sheet'), stated: bs.totalLiabilitiesAndCapital, expected: liabilities + bs.partnersCapital, terms: 2,
        message: (s, e, d) => `Total liabilities and partners' capital is stated as ${s}, but the two add up to ${e} (${d} apart).`,
        cites: citesFor(bs, ['totalLiabilitiesAndCapital']),
      }))
    }
  }

  // Statement of operations.
  const ops = fund.operations
  if (ops?.lines?.length && ops.netIncome != null) {
    compared++
    push(findings, compare(ctx, {
      check: 'foots', subject: fundSubject('Statement of operations'), stated: ops.netIncome, expected: sum(ops.lines), terms: ops.lines.length,
      message: (s, e, d) => `Net income is stated as ${s}, but the lines of the statement of operations add up to ${e} (${d} apart).`,
      cites: citesFor(ops, ['netIncome']),
    }))
  }

  // Schedule of investments.
  const holdings = pkg.holdings ?? []
  const soi = fund.soi
  if (soi && holdings.length) {
    for (const key of ['cost', 'fairValue'] as const) {
      const stated = soi[key]
      const values = holdings.map(h => h[key])
      if (stated == null || values.every(v => v == null)) continue
      compared++
      push(findings, compare(ctx, {
        check: 'foots', subject: fundSubject('Schedule of investments'),
        stated, expected: values.reduce<number>((s, v) => s + (v ?? 0), 0), terms: holdings.length,
        message: (s, e, d) => `The schedule of investments states total ${key === 'cost' ? 'cost' : 'fair value'} of ${s}, but its holdings add up to ${e} (${d} apart).`,
        cites: citesFor(soi, [key]),
      }))
    }
  }

  return {
    outcome: compared
      ? { check: 'foots', ran: true, compared }
      : { check: 'foots', ran: false, compared: 0, note: 'The package states no totals to foot: no total row, net allocation, balance sheet, statement of operations or schedule of investments totals.' },
    findings,
  }
}
