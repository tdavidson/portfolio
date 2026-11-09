// The character of a distribution RECEIVED from a fund holding, worked out rather than typed.
//
// Cost recovery: a distribution returns our capital until the cost still carried on the holding is
// gone, and only what comes after that is realized gain. Income the manager states as income (a
// notice's char_income) stays income and is taken out first. So nobody decides by hand whether a
// distribution was a return of capital: the books already know how much cost is left.
//
// Remaining cost is the holding's cost on one entity, at the distribution's date: every investment
// transaction's cost less every proceeds transaction's cost basis exited, the distribution itself
// left out. Recalculating a holding's distributions oldest first therefore re-derives each against
// the corrected ones before it.

import type { SupabaseClient } from '@supabase/supabase-js'

const CENT = 0.005

export interface CostRecoveryCharacter {
  returnOfCapital: number
  realizedGain: number
  income: number
}

const cents = (n: number) => Math.round(n * 100) / 100

/** Split a distribution by cost recovery against the cost still carried. */
export function costRecoverySplit(amount: number, remainingCost: number, income = 0): CostRecoveryCharacter {
  const inc = Math.min(Math.max(0, income), amount)
  const rest = amount - inc
  const returnOfCapital = cents(Math.min(rest, Math.max(0, remainingCost)))
  return { returnOfCapital, realizedGain: cents(rest - returnOfCapital), income: cents(inc) }
}

/**
 * The holding's cost carried on one entity at a date: investment cost less cost basis exited, over
 * transactions dated on or before it, leaving out `excludeTxnId` (the distribution being split).
 * Never below zero.
 */
export async function remainingCostAt(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  vehicleName: string,
  date: string,
  excludeTxnId?: string | null,
): Promise<number> {
  const { data, error } = await (admin as any).from('investment_transactions')
    .select('id, transaction_type, transaction_date, investment_cost, cost_basis_exited')
    .eq('fund_id', fundId).eq('company_id', companyId).eq('portfolio_group', vehicleName)
    .lte('transaction_date', date)
  if (error) throw new Error(`Could not read the holding's cost: ${error.message}`)
  let cost = 0
  for (const t of (data as any[]) ?? []) {
    if (excludeTxnId && t.id === excludeTxnId) continue
    // A cost transfer's investment_cost is signed: out of the holding lowers its cost.
    if (t.transaction_type === 'investment' || t.transaction_type === 'cost_transfer') cost += Number(t.investment_cost ?? 0)
    else if (t.transaction_type === 'proceeds') cost -= Number(t.cost_basis_exited ?? 0)
  }
  return cost > CENT ? cents(cost) : 0
}

/** True when no character was stated: all three buckets zero. */
export function isUncharacterised(c: { charReturnOfCapital?: number; charRealizedGain?: number; charIncome?: number }): boolean {
  return !(Number(c.charReturnOfCapital ?? 0) > CENT || Number(c.charRealizedGain ?? 0) > CENT || Number(c.charIncome ?? 0) > CENT)
}
