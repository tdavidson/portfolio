// Every DB read the reminder sources need, for one fund. Kept apart from the sources so those
// stay pure and testable over fixtures.

import { loadComplianceData } from '@/lib/compliance/calendar'
import type { SupabaseClient } from '@supabase/supabase-js'
import { lastEndedQuarter, metricQuarter, responseKey } from '@/lib/requests/response-status'
import type { FundReminderData } from './collect'
import type { OpenCall } from './sources/calls'
import type { FeesData } from './sources/fees'
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

  const [compliance, requestsRes, companiesRes, metrics, overridesRes, dueCallsRes, currencyRes] = await Promise.all([
    // Filings from last year through next (a Q4 item stays visible into January), with each
    // vehicle's closes for Form D and Blue Sky.
    loadComplianceData(admin, fundId, y - 1, y + 1, 'reminders: '),
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
  const requests = rowsOf('email_requests', requestsRes) ?? []
  const companies = rowsOf('companies', companiesRes) ?? []
  const overrides = rowsOf('ask_response_overrides', overridesRes) ?? []
  const dueCalls = rowsOf<{ id: string; vehicle_id: string | null }[]>('capital_calls', dueCallsRes) ?? []
  const currency = (rowsOf<{ currency?: string }>('fund_settings', currencyRes)?.currency as string | undefined) ?? 'USD'

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
  const fees = await loadDueFeePeriods(db, fundId, today, vehicleById, currency)

  return {
    calls: { openCalls },
    ...(fees ? { fees } : {}),
    onboarding,
    compliance,
    asks: {
      sendOffsetDays: asksSendOffsetDays,
      requests,
      companies,
      hasData,
      overrides: overrideMap,
    },
  }
}

/**
 * Fee periods not yet booked whose due date is within 60 days (the longest lead time) or past, with
 * each vehicle's lead time from its fee schedule. Null when the table is absent (migration
 * 20261124030000 not applied) or nothing is waiting.
 */
async function loadDueFeePeriods(db: any, fundId: string, today: string, vehicleById: Map<string, string>, currency: string): Promise<FeesData | null> {
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await db.from('management_fee_periods').select('id, vehicle_id, period_start, due_date, status')
    .eq('fund_id', fundId).in('status', ['scheduled', 'drafted']).lte('due_date', horizon)
  if (error || !data?.length) return null
  const rows = data as { id: string; vehicle_id: string; period_start: string; due_date: string; status: 'scheduled' | 'drafted' }[]
  const { data: settings } = await db.from('vehicle_accounting_settings').select('vehicle_id, fee_schedule')
    .eq('fund_id', fundId).in('vehicle_id', Array.from(new Set(rows.map(r => r.vehicle_id))))
  const lead = new Map<string, number>(((settings ?? []) as any[]).map(s => [s.vehicle_id, Number(s.fee_schedule?.reminderDays ?? 5)]))
  const { data: lines } = await db.from('management_fee_period_lines').select('period_id, amount').eq('fund_id', fundId).in('period_id', rows.map(r => r.id))
  const totals = new Map<string, number>()
  for (const l of (lines ?? []) as { period_id: string; amount: number }[]) totals.set(l.period_id, (totals.get(l.period_id) ?? 0) + Number(l.amount))
  return {
    periods: rows.filter(r => vehicleById.has(r.vehicle_id) && lead.has(r.vehicle_id)).map(r => ({
      id: r.id, vehicleId: r.vehicle_id, vehicle: vehicleById.get(r.vehicle_id)!, start: r.period_start, dueDate: r.due_date,
      status: r.status, total: Math.round((totals.get(r.id) ?? 0) * 100) / 100, leadDays: lead.get(r.vehicle_id) ?? 5, currency,
    })),
  }
}
