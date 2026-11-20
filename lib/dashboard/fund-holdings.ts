import type { SupabaseClient } from '@supabase/supabase-js'
import type { PageSupabase } from '@/lib/pages/context'

/**
 * The dashboard's fund holdings (companies.holding_type = 'fund'): the identity a card needs to
 * sit in the same grid as the companies, sorted and filtered the same way. The figures (NAV,
 * commitment, called) come from the portfolio sheet the page already fetches, so a card shows the
 * same numbers as the schedule of investments.
 */
export interface DashboardFundHoldingRow {
  id: string
  name: string
  status: string
  created_at: string | null
  tags: string[]
  aliases: string[] | null
  portfolio_group: string[] | null
}

export async function loadDashboardFundHoldingRows(client: PageSupabase, fundId: string, companyIds: string[] | null): Promise<DashboardFundHoldingRow[]> {
  if (companyIds?.length === 0) return []
  let query = client.from('companies')
    .select('id, name, status, created_at, tags, aliases, portfolio_group')
    .eq('fund_id', fundId).eq('holding_type', 'fund')
    .order('name').order('id')
  if (companyIds !== null) query = query.in('id', companyIds)
  const { data, error } = await query.returns<DashboardFundHoldingRow[]>()
  if (error) throw new Error('Could not load fund holdings')
  return data ?? []
}

/**
 * The first capital call per fund holding, in the viewer's entities only (`vehicleIds` null means
 * every entity). The dashboard's "invested" sort uses it the way it uses a company's first
 * investment.
 */
export async function loadFirstCallDates(admin: SupabaseClient, fundId: string, holdingIds: string[], vehicleIds: string[] | null): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (holdingIds.length === 0 || vehicleIds?.length === 0) return out
  let query = (admin as any).from('fund_capital_events').select('company_id, event_date')
    .eq('fund_id', fundId).eq('kind', 'call').in('company_id', holdingIds)
  if (vehicleIds !== null) query = query.in('vehicle_id', vehicleIds)
  const { data, error } = await query.order('event_date', { ascending: true }).limit(5000)
  if (error) throw new Error('Could not load fund capital calls')
  for (const e of (data as { company_id: string; event_date: string }[]) ?? []) {
    if (!out.has(e.company_id)) out.set(e.company_id, e.event_date)
  }
  return out
}
