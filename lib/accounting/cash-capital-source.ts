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
  if (!cash.length || !capital.length || cash.length + capital.length !== postings.length) return null
  if (cash.every(p => p.amount > 0) && capital.every(p => p.amount < 0)) return 'contribution'
  if (cash.every(p => p.amount < 0) && capital.every(p => p.amount > 0)) return 'distribution'
  return null
}
