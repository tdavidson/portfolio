import { RECEIVABLE_CODE } from './chart'

/**
 * Classify only an unambiguous capital exchange; other imports keep their provenance.
 *
 * Cash against LP capital is a contribution or a distribution. LP capital against Due from LPs
 * (and nothing else) is a capital call recognized before the cash arrives, the same shape a native
 * call books, so it is called capital. That includes a call's reversal and a transfer that moves
 * called capital, and any unpaid part of it, from one partner to another.
 */
export function cashCapitalSource(
  postings: { accountId: string; amount: number }[],
  accounts: { id: string; code?: string | null; subtype?: string | null }[],
): 'contribution' | 'distribution' | 'capital_call' | null {
  const byId = new Map(accounts.map(account => [account.id, account]))
  const cash = postings.filter(posting => byId.get(posting.accountId)?.subtype === 'cash')
  const capital = postings.filter(posting => byId.get(posting.accountId)?.subtype === 'lp_capital')
  const receivable = postings.filter(posting => byId.get(posting.accountId)?.code === RECEIVABLE_CODE)
  if (!cash.length && capital.length && receivable.length && capital.length + receivable.length === postings.length) return 'capital_call'
  if (cash.length && capital.length && cash.length + capital.length === postings.length) {
    if (cash.every(p => p.amount > 0) && capital.every(p => p.amount < 0)) return 'contribution'
    if (cash.every(p => p.amount < 0) && capital.every(p => p.amount > 0)) return 'distribution'
    return null
  }
  return fundAdminCapitalSource(postings, byId)
}

/**
 * A fund administrator's export books the whole fund's side of a call or a distribution in one
 * entry: every limited partner's leg, the general partner's leg on its own capital account, and
 * sometimes an unallocated LP capital account, against cash, Due from LPs or Distributions
 * payable. The partners' legs are the same capital movement as the simple shapes above, so the
 * entry is classified by its cash side as long as nothing else is in it.
 *
 * - Distributions payable credited, LP capital debited: a distribution, recognized when declared
 *   (paying the payable later does not touch capital).
 * - Due from LPs debited, LP capital credited, no cash: a capital call.
 * - Cash debited, LP capital credited: a contribution, whether or not it also clears Due from LPs.
 *
 * Any other account in the entry (a fee, an expense, an investment) leaves it unclassified, and so
 * does a partner-to-partner transfer, which moves capital without any money changing hands.
 */
function fundAdminCapitalSource(
  postings: { accountId: string; amount: number }[],
  byId: Map<string, { id: string; code?: string | null; subtype?: string | null }>,
): 'contribution' | 'distribution' | 'capital_call' | null {
  const kind = (p: { accountId: string }) => {
    const account = byId.get(p.accountId)
    if (account?.subtype === 'cash') return 'cash'
    if (account?.code === RECEIVABLE_CODE) return 'receivable'
    if (account?.subtype === 'distributions_payable') return 'payable'
    if (account?.subtype === 'lp_capital') return 'lp'
    if (account?.subtype === 'gp_capital') return 'gp'
    return 'other'
  }
  if (postings.some(p => kind(p) === 'other')) return null
  if (!postings.some(p => kind(p) === 'lp')) return null
  const sum = (k: string) => postings.filter(p => kind(p) === k).reduce((total, p) => total + p.amount, 0)
  const has = (k: string) => postings.some(p => kind(p) === k)
  // Partners' legs can point both ways inside one whole-fund entry (a partner's offset, a GP true-up),
  // so the direction is the partners' net, read against the cash side.
  const partners = sum('lp'), cash = sum('cash'), receivable = sum('receivable'), payable = sum('payable')
  if (has('payable')) return payable < 0 && partners > 0 && !has('receivable') && cash <= 0 ? 'distribution' : null
  if (has('cash')) {
    if (cash > 0 && partners < 0) return 'contribution'
    if (cash < 0 && partners > 0 && !has('receivable')) return 'distribution'
    return null
  }
  if (has('receivable') && receivable > 0 && partners < 0) return 'capital_call'
  return null
}
