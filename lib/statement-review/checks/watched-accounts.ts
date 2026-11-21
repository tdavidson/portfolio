// Watched accounts: the accounts the reviewer asked to look at every period (review settings).
//
// Each one is reported with its balance and its movement in the period, with the reviewer's note.
// It becomes a warning when it moved by more than the reviewer's threshold, or when the package
// states a line of the same name that disagrees with the books: a balance sheet line against the
// balance, a statement of operations line against the movement (signed as it adds to net income).

import { compare, fmt } from '../compare'
import type { Finding, ShadowAccount, StatedLine } from '../types'
import { normName, push, type Check } from './shared'

function findAccount(accounts: ShadowAccount[], ref: string): ShadowAccount | null {
  const r = ref.trim()
  const byCode = accounts.find(a => a.code === r)
  if (byCode) return byCode
  const n = normName(r)
  const exact = accounts.filter(a => normName(a.name) === n)
  if (exact.length === 1) return exact[0]
  const partial = accounts.filter(a => normName(a.name).includes(n))
  return partial.length === 1 ? partial[0] : null
}

const findLine = (lines: StatedLine[] | undefined, a: ShadowAccount) =>
  (lines ?? []).find(l => normName(l.label) === normName(a.name) || l.label.trim() === a.code)

export const watchedAccounts: Check = ({ pkg, shadow, settings }, ctx) => {
  const findings: Finding[] = []
  const watch = settings?.watchAccounts ?? []
  if (!watch.length) {
    return { outcome: { check: 'watched_accounts', ran: false, compared: 0, note: 'No accounts are on the watch list. Add them in the review settings.' }, findings }
  }
  if (!shadow?.accounts) {
    return { outcome: { check: 'watched_accounts', ran: false, compared: 0, note: "The app's books for this vehicle couldn't be read." }, findings }
  }
  let compared = 0
  for (const w of watch) {
    const a = findAccount(shadow.accounts, w.account)
    if (!a) {
      findings.push({
        check: 'watched_accounts', severity: 'warning', subject: { kind: 'account', label: w.account },
        message: `"${w.account}" is on the watch list but isn't an account in this vehicle's chart, or matches more than one.`,
        cites: [], status: 'open',
      })
      continue
    }
    compared++
    const label = `${a.code} ${a.name}`
    const subject: Finding['subject'] = { kind: 'account', id: a.code, label }
    const over = w.threshold != null && Math.abs(a.movement) > w.threshold
    findings.push({
      check: 'watched_accounts', severity: over ? 'warning' : 'info', subject,
      stated: a.balance,
      message: `${label} ended the period at ${fmt(a.balance)}, having moved ${fmt(a.movement)}` +
        `${over ? `, more than the ${fmt(w.threshold as number)} you set` : ''}.${w.note ? ` Watch for: ${w.note}` : ''}`,
      cites: [], status: 'open',
    })
    const isFlow = ['income', 'expense'].includes(a.type)
    const line = isFlow ? findLine(pkg.fund?.operations?.lines, a) : findLine([...(pkg.fund?.balanceSheet?.assets ?? []), ...(pkg.fund?.balanceSheet?.liabilities ?? [])], a)
    if (line) {
      compared++
      const expected = isFlow ? (a.type === 'expense' ? -a.movement : a.movement) : a.balance
      push(findings, compare(ctx, {
        check: 'watched_accounts', subject, stated: line.amount, expected,
        message: (s, e, d) => `The package states ${line.label} as ${s}, but ${label} ${isFlow ? 'moved' : 'holds'} ${e} in the books (${d} apart).`,
        cites: line.cite ? [line.cite] : [],
      }))
    }
  }
  return { outcome: { check: 'watched_accounts', ran: true, compared }, findings }
}
