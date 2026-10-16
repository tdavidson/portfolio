import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvestmentTransaction } from '@/lib/types/database'

export type LoadTransactions = (companyIds: string[]) => Promise<InvestmentTransaction[]>

/** Construct inside a request, after access resolution. Callers supply authorised company IDs;
 * the service-role query is also pinned to the resolved fund. Sharing this loader between the
 * dashboard and its entity picker avoids fetching the same history twice. No cross-request cache.
 */
export function createTransactionLoader(admin: SupabaseClient, fundId: string): LoadTransactions {
  const byCompany = new Map<string, Promise<InvestmentTransaction[]>>()

  async function read(companyIds: string[]) {
    const rows: InvestmentTransaction[] = []
    // Bound URL length and page through history: PostgREST's row cap is not a financial total.
    for (let start = 0; start < companyIds.length; start += 100) {
      const ids = companyIds.slice(start, start + 100)
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await admin.from('investment_transactions')
          .select('*').eq('fund_id', fundId).in('company_id', ids)
          .order('transaction_date', { ascending: true, nullsFirst: false })
          .order('id').range(offset, offset + 499)
        if (error) throw new Error('Could not load portfolio investments')
        rows.push(...(data ?? []) as InvestmentTransaction[])
        if ((data?.length ?? 0) < 500) break
      }
    }
    return rows
  }

  return async companyIds => {
    const ids = [...new Set(companyIds)]
    const missing = ids.filter(id => !byCompany.has(id))
    if (missing.length) {
      const batch = read(missing).then(rows => {
        const grouped = new Map<string, InvestmentTransaction[]>()
        for (const row of rows) {
          const group = grouped.get(row.company_id) ?? []
          group.push(row)
          grouped.set(row.company_id, group)
        }
        return grouped
      })
      for (const id of missing) byCompany.set(id, batch.then(groups => groups.get(id) ?? []))
    }
    return (await Promise.all(ids.map(id => byCompany.get(id)!))).flat()
  }
}
