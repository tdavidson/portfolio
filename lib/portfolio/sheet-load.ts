import type { SupabaseClient } from '@supabase/supabase-js'
import { buildStatementPackage } from '@/lib/accounting/statement-package'
import { buildPortfolioSheet, type CompanyMeta, type ListedQuote, type PortfolioSheet } from './sheet'

/**
 * The portfolio sheet over these entities. The CALLER decides which entities — one for an entity's
 * sheet, the viewer's visible ones for the dashboard — and must never pass one the viewer cannot
 * see: everything here reads with the service role.
 */
export async function loadPortfolioSheet(admin: SupabaseClient, fundId: string, vehicles: string[]): Promise<PortfolioSheet> {
  const today = new Date().toISOString().slice(0, 10)
  // Inception to date: the sheet is "what we hold now", the same rows the schedule reports.
  const byVehicle = await Promise.all(vehicles.map(async vehicle => {
    const pkg = await buildStatementPackage(admin, fundId, vehicle, new URLSearchParams({ preset: 'itd' }))
    return { vehicle, rows: pkg.payload.scheduleOfInvestments.rows }
  }))

  const companyIds = Array.from(new Set(byVehicle.flatMap(v => v.rows.map(r => r.companyId).filter((id): id is string => !!id))))
  if (companyIds.length === 0) return buildPortfolioSheet({ byVehicle })

  const [{ data: companies }, { data: emails }, { data: cashMetrics }, { data: feeds }] = await Promise.all([
    (admin as any).from('companies').select('id, stage, status').eq('fund_id', fundId).in('id', companyIds),
    (admin as any).from('inbound_emails').select('company_id, received_at').eq('fund_id', fundId).in('company_id', companyIds)
      .order('received_at', { ascending: false }).limit(5000),
    (admin as any).from('metrics').select('id, company_id, name').in('company_id', companyIds).eq('is_active', true).ilike('name', '%cash%'),
    (admin as any).from('price_feeds').select('id, company_id, symbol, active_from, active_until').eq('fund_id', fundId)
      .in('company_id', companyIds).lte('active_from', today),
  ])

  const meta = new Map<string, CompanyMeta>()
  for (const c of (companies as any[]) ?? []) meta.set(c.id, { stage: c.stage, status: c.status })
  for (const e of (emails as any[]) ?? []) {
    const m = meta.get(e.company_id)
    if (m && !m.lastReportAt) m.lastReportAt = e.received_at
  }

  // Latest cash: the newest value of the company's metric named "cash" — the dashboard's rule.
  const cashByMetric = new Map<string, string>()
  for (const m of (cashMetrics as any[]) ?? []) {
    if (/\bcash\b/i.test(m.name) && !Array.from(cashByMetric.values()).includes(m.company_id)) cashByMetric.set(m.id, m.company_id)
  }
  if (cashByMetric.size > 0) {
    const { data: values } = await (admin as any).from('metric_values').select('metric_id, value_number')
      .in('metric_id', Array.from(cashByMetric.keys())).not('value_number', 'is', null)
      .order('period_year', { ascending: false }).order('created_at', { ascending: false })
    for (const v of (values as any[]) ?? []) {
      const m = meta.get(cashByMetric.get(v.metric_id)!)
      if (m && m.latestCash == null) m.latestCash = Number(v.value_number)
    }
  }

  // A listed stock is a company with a live quote source; its last observed price.
  const liveFeeds = ((feeds as any[]) ?? []).filter(f => !f.active_until || f.active_until >= today)
  const quotes = new Map<string, ListedQuote>()
  if (liveFeeds.length > 0) {
    const { data: obs } = await (admin as any).from('price_observations').select('feed_id, price, as_of_date')
      .in('feed_id', liveFeeds.map(f => f.id)).order('as_of_date', { ascending: false }).limit(2000)
    for (const f of liveFeeds) {
      const last = ((obs as any[]) ?? []).find(o => o.feed_id === f.id)
      quotes.set(f.company_id, { symbol: f.symbol, price: last ? Number(last.price) : null, asOf: last?.as_of_date ?? null })
    }
  }

  return buildPortfolioSheet({ byVehicle, meta, quotes })
}
