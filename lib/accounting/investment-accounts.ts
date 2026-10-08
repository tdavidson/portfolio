//
// WHICH ACCOUNTS CARRY INVESTMENT VALUE. One answer, used by the reader that adopts entries, the
// backfill, the opening-balance guard and (in SQL, public.is_investment_account) the ownership
// trigger. By type, subtype and company — never by code: a management company's chart uses 1100
// for receivables, codes carry a short form of the company id, and the pooled 4200/4300 share the
// subtypes `unrealized`/`fx_translation` with the asset accounts while being income.
//
// Investment accounts: the asset accounts at cost (1100), unrealized (1200) and FX translation
// (1250), per company or pooled, and a company's own realized gain (4000-<id>). Pooled 4000,
// 4200, 4300, accrued note interest (1150-<id>) and escrow (1350) are context, not investment
// value. See plans/spec-ledger-one-writer.md, Definitions.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ChartAccount {
  id: string
  code: string
  type: string
  subtype: string | null
  companyId: string | null
}

type Shape = Pick<ChartAccount, 'type' | 'subtype' | 'companyId'>
export type InvestmentKind = 'cost' | 'unrealized' | 'fx' | 'realized'

const ASSET_KIND: Record<string, InvestmentKind> = { investment: 'cost', unrealized: 'unrealized', fx_translation: 'fx' }

export function investmentKind(a: Shape): InvestmentKind | null {
  if (a.type === 'asset' && a.subtype && ASSET_KIND[a.subtype]) return ASSET_KIND[a.subtype]
  if (a.subtype === 'realized_gain' && a.companyId) return 'realized'
  return null
}

export const isInvestmentAccount = (a: Shape): boolean => investmentKind(a) !== null
export const isPooledInvestmentAccount = (a: Shape): boolean => isInvestmentAccount(a) && !a.companyId

export async function loadVehicleChart(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<ChartAccount[]> {
  const results: ChartAccount[] = []
  let from = 0

  while (true) {
    const { data, error } = await admin.from('chart_of_accounts' as any)
      .select('id, code, type, subtype, company_id')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .order('id')
      .range(from, from + 999)

    if (error) {
      throw new Error(`Could not read the chart of accounts: ${error.message}`)
    }

    if (!data) {
      break
    }

    results.push(...data.map(a => ({
      id: a.id, code: a.code, type: a.type, subtype: a.subtype ?? null, companyId: a.company_id ?? null,
    })))

    // If we got fewer than 1000 rows, we've reached the end
    if (data.length < 1000) {
      break
    }

    from += 1000
  }

  return results
}
