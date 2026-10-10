// Every DB read the reminder sources need, for one fund. Kept apart from the sources so those
// stay pure and testable over fixtures.

import { loadCloseDates } from '@/lib/compliance/closes'
import type { SupabaseClient } from '@supabase/supabase-js'
import { lastEndedQuarter, metricQuarter, responseKey } from '@/lib/requests/response-status'
import type { FundReminderData } from './collect'
import type { ComplianceItemRow } from './sources/compliance'
import type { OpenCall } from './sources/calls'
import { loadOnboardingReminderData } from './sources/onboarding-load'
import { fromHeader } from './settings'
import { listCapitalCalls } from '@/lib/accounting/capital-calls'

type QueryResult<T> = { data: T | null; error: { message: string } | null }

/** A read's rows, or a throw naming the table. A failed read must not become an empty list:
 *  that is a wrong digest whose keys then get logged as delivered. */
function rowsOf<T = any>(table: string, res: QueryResult<unknown>): T | null {
  if (res.error) throw new Error(`reminders: ${table} load failed: ${res.error.message}`)
  return res.data as T | null
}

const PAGE = 1000

/** Every row of a read past PostgREST's 1000-row cap, throwing on a failed page (unlike
 *  lib/accounting/load's fetchAllRows). `page` must apply a stable, unique order. */
async function allRows<T>(table: string, page: (from: number, to: number) => PromiseLike<QueryResult<T[]>>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf<T[]>(table, await page(from, from + PAGE - 1)) ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export interface ReminderSettings {
  enabled: boolean
  recipients: string[]
  asksSendOffsetDays: number
  fundName: string
  /** The digest's From header, from the fund's system email identity (undefined: provider default). */
  from?: string
}

export async function loadReminderSettings(admin: SupabaseClient, fundId: string): Promise<ReminderSettings> {
  const [settingsRes, fundRes] = await Promise.all([
    (admin as any).from('fund_settings')
      .select('reminders_enabled, reminder_recipients, asks_send_offset_days, system_email_from_name, system_email_from_address')
      .eq('fund_id', fundId).maybeSingle(),
    admin.from('funds').select('name').eq('id', fundId).maybeSingle(),
  ])
  const s = rowsOf('fund_settings', settingsRes)
  const fund = rowsOf<{ name?: string }>('funds', fundRes)
  const name = fund?.name ?? null
  return {
    enabled: !!s?.reminders_enabled,
    recipients: (s?.reminder_recipients as string[] | null) ?? [],
    asksSendOffsetDays: (s?.asks_send_offset_days as number | null) ?? 0,
    fundName: name ?? 'Your fund',
    from: fromHeader({ name: s?.system_email_from_name ?? null, address: s?.system_email_from_address ?? null }, name),
  }
}

export async function loadFundReminderData(
  admin: SupabaseClient,
  fundId: string,
  today: string,
  asksSendOffsetDays: number,
): Promise<FundReminderData> {
  const y = Number(today.slice(0, 4))
  const rq = lastEndedQuarter(today)
  const db = admin as any

  const [itemsRes, profileRes, settingsRes, closed, vehiclesRes, closes, requestsRes, companiesRes, metrics, overridesRes, dueCallsRes, currencyRes] = await Promise.all([
    db.from('compliance_items')
      .select('id, name, short_name, frequency, scope, deadline_month, deadline_day, rolling_days')
      .order('sort_order'),
    db.from('fund_compliance_profile').select('*').eq('fund_id', fundId).maybeSingle(),
    db.from('compliance_fund_settings').select('compliance_item_id, portfolio_group, applies, dismissed').eq('fund_id', fundId),
    allRows<{ compliance_item_id: string; portfolio_group: string; quarter: number; year: number }>('compliance_deadlines', (from, to) =>
      db.from('compliance_deadlines').select('compliance_item_id, portfolio_group, quarter, year')
        .eq('fund_id', fundId).in('status', ['filed', 'not_applicable']).gte('year', y - 1)
        .order('id').range(from, to)),
    db.from('fund_vehicles').select('name').eq('fund_id', fundId),
    // Each vehicle's closes (closings, plus legacy commitment rows), for Form D and Blue Sky.
    loadCloseDates(admin, fundId, `${y - 1}-01-01`, `${y + 1}-12-31`, { errorPrefix: 'reminders: ' }),
    db.from('email_requests').select('quarter, year, due_date, status')
      .eq('fund_id', fundId).not('quarter', 'is', null).gte('year', rq.year - 1),
    db.from('companies').select('id, name')
      .eq('fund_id', fundId).eq('holding_type', 'company').eq('status', 'active').order('name'),
    allRows<{ company_id: string; period_year: number; period_quarter: number | null; period_month: number | null }>('metric_values', (from, to) =>
      db.from('metric_values').select('company_id, period_year, period_quarter, period_month')
        .eq('fund_id', fundId).eq('period_year', rq.year)
        .order('id').range(from, to)),
    db.from('ask_response_overrides').select('company_id, status')
      .eq('fund_id', fundId).eq('year', rq.year).eq('quarter', rq.quarter),
    // Calls with a due date: the register rows, so the vehicles that need a settlement pass are
    // known before the (heavier) per-vehicle ledger read below.
    db.from('capital_calls').select('id, vehicle_id').eq('fund_id', fundId).not('due_date', 'is', null),
    db.from('fund_settings').select('currency').eq('fund_id', fundId).maybeSingle(),
  ])
  const items = rowsOf('compliance_items', itemsRes) ?? []
  const profile = rowsOf('fund_compliance_profile', profileRes)
  const settings = rowsOf('compliance_fund_settings', settingsRes) ?? []
  const vehicles = rowsOf('fund_vehicles', vehiclesRes) ?? []
  const requests = rowsOf('email_requests', requestsRes) ?? []
  const companies = rowsOf('companies', companiesRes) ?? []
  const overrides = rowsOf('ask_response_overrides', overridesRes) ?? []
  const dueCalls = rowsOf<{ id: string; vehicle_id: string | null }[]>('capital_calls', dueCallsRes) ?? []
  const currency = (rowsOf<{ currency?: string }>('fund_settings', currencyRes)?.currency as string | undefined) ?? 'USD'

  const closeDates = closes

  const hasData = new Set<string>()
  for (const mv of metrics) {
    if (metricQuarter(mv) === rq.quarter) hasData.add(responseKey(mv.company_id, mv.period_year, rq.quarter))
  }

  const overrideMap = new Map<string, string>()
  for (const o of overrides as { company_id: string; status: string }[]) {
    overrideMap.set(responseKey(o.company_id, rq.year, rq.quarter), o.status)
  }

  // Open calls: one settlement pass per vehicle that has a dated call, through the same list the
  // capital-accounts page reads, so the digest and the page agree on what is outstanding.
  const openCalls: OpenCall[] = []
  const vehicleById = new Map<string, string>()
  const { data: vehicleRows } = await db.from('fund_vehicles').select('id, name').eq('fund_id', fundId)
  for (const v of ((vehicleRows ?? []) as { id: string; name: string }[])) vehicleById.set(v.id, v.name)
  const vehicleIds = Array.from(new Set(dueCalls.map(c => c.vehicle_id).filter(Boolean) as string[]))
  for (const vehicleId of vehicleIds) {
    const name = vehicleById.get(vehicleId)
    if (!name) continue
    const calls = await listCapitalCalls(admin, fundId, name, today)
    for (const c of calls) {
      if (!c.dueDate || c.outstanding <= 0.005) continue
      openCalls.push({
        id: c.id, vehicleId, vehicle: name, callDate: c.callDate, dueDate: c.dueDate, callNumber: c.callNumber,
        description: c.description, outstanding: c.outstanding,
        unfunded: c.lines.filter(l => l.outstanding > 0.005).map(l => l.name), currency,
      })
    }
  }

  const onboarding = await loadOnboardingReminderData(admin, fundId, today)

  return {
    calls: { openCalls },
    onboarding,
    compliance: {
      items: items as ComplianceItemRow[],
      profile: profile ?? null,
      settings,
      closed,
      portfolioGroups: (vehicles as { name: string }[]).map(v => v.name).sort(),
      closeDates,
    },
    asks: {
      sendOffsetDays: asksSendOffsetDays,
      requests,
      companies,
      hasData,
      overrides: overrideMap,
    },
  }
}
