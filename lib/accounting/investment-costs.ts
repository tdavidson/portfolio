import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from './load'
import { investmentCostRows } from './soi'
import type { InvestmentTransaction } from '@/lib/types/database'

/** A vehicle's investments, dated, at cost — the rows the Investments tab's invested capital sums. */
export async function loadInvestmentCosts(admin: SupabaseClient, fundId: string, vehicle: string): Promise<{ date: string | null; cost: number }[]> {
  const rows = await fetchAllRows<InvestmentTransaction>((f, t) => (admin as any).from('investment_transactions').select('*')
    .eq('fund_id', fundId).eq('portfolio_group', vehicle).eq('transaction_type', 'investment').range(f, t))
  return investmentCostRows(rows, vehicle)
}
