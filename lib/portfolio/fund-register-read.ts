// One fund holding's register as this member sees it: terms, capital notices and NAV statements
// for one of their entities. The holding page's GET (app/api/portfolio/fund-holdings/[id]) and the
// fund_register tool both read through here, so the entity rules are written once.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'
import { computeFundPositions, type NavBasis } from './fof-metrics'

export interface FundRegisterRows {
  holding: { id: string; name: string; holding_type: string | null } | null
  /** The shown entity's terms row, or null. */
  terms: Record<string, any> | null
  events: Record<string, any>[]
  navStatements: Record<string, any>[]
  /** The entity shown; null until the holding's first notice or statement names one. */
  vehicleId: string | null
  /** Every entity of this holding the caller can see, by name. */
  vehicles: { id: string; name: string }[]
}

export async function loadFundRegister(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  access: AccessContext,
  requestedEntity?: string | null,
): Promise<FundRegisterRows> {
  const db = admin as any
  const [holding, terms, events, navs] = await Promise.all([
    db.from('companies').select('id, name, holding_type').eq('id', companyId).eq('fund_id', fundId).maybeSingle(),
    db.from('fund_holding_terms').select('*').eq('company_id', companyId).eq('fund_id', fundId),
    db.from('fund_capital_events').select('*').eq('company_id', companyId).eq('fund_id', fundId).order('event_date'),
    db.from('fund_nav_statements').select('*').eq('company_id', companyId).eq('fund_id', fundId).order('as_of_date', { ascending: false }),
  ])
  if (!holding.data) return { holding: null, terms: null, events: [], navStatements: [], vehicleId: null, vehicles: [] }

  // A holding two funds commit to is one company row; the gate admitted the caller on either.
  // Everything per-entity — terms, notices, statements — is shown for THEIR entities only.
  const visible = visibleVehicleIds(access)
  const termRows = scopeCompanyRows((terms.data as any[]) ?? [], visible, 'vehicle_id')
  const eventRows = scopeCompanyRows((events.data as any[]) ?? [], visible, 'vehicle_id')
  const navRows = scopeCompanyRows((navs.data as any[]) ?? [], visible, 'vehicle_id')

  // THE ENTITIES THAT HOLD THIS FUND, of those the caller can see — from its register rows (nothing
  // on `companies` carries the vehicle). One entity at a time: two entities' positions in one fund
  // are two positions (lib/portfolio/fof-holdings.ts).
  const entityIds = Array.from(new Set([...termRows, ...eventRows, ...navRows].map(r => r.vehicle_id).filter(Boolean))) as string[]
  const lookup = Array.from(new Set([...entityIds, ...(requestedEntity ? [requestedEntity] : [])]))
  const { data: vehicleRows } = lookup.length > 0
    ? await db.from('fund_vehicles').select('id, name').eq('fund_id', fundId).in('id', lookup)
    : { data: [] as any[] }
  const names = new Map(((vehicleRows as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const vehicles = entityIds.filter(id => names.has(id))
    .map(id => ({ id, name: names.get(id)! }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // The one asked for when it is in this fund and the caller's (it may hold nothing here yet — the
  // first notice or statement names it), else the holding's first entity, else none.
  const selected = requestedEntity && names.has(requestedEntity) && canSeeVehicle(access, requestedEntity)
    ? requestedEntity
    : vehicles[0]?.id ?? null
  // Legacy rows naming no entity belong with the holding's only entity, or stand alone when it has none.
  const forEntity = (rows: any[]) => rows.filter(r =>
    (r.vehicle_id ?? null) === selected || (r.vehicle_id == null && vehicles.length <= 1))

  return {
    holding: holding.data,
    terms: forEntity(termRows).sort((a, b) => (a.vehicle_id ? 0 : 1) - (b.vehicle_id ? 0 : 1))[0] ?? null,
    events: forEntity(eventRows),
    navStatements: forEntity(navRows),
    vehicleId: selected,
    vehicles,
  }
}

const n = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const d = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null)

/**
 * The register in the shape the fund_register tool returns: terms with commitment and unfunded,
 * notices, and each NAV statement with the mark it booked. A statement dated before the ledger's
 * start books nothing (memo-only) and says so.
 */
export async function describeFundRegister(admin: SupabaseClient, fundId: string, reg: FundRegisterRows, asOf: string) {
  const txnIds = Array.from(new Set([...reg.navStatements, ...reg.events]
    .map(r => r.investment_transaction_id).filter((id): id is string => !!id)))
  const booked = new Map<string, { id: string; transaction_type: string; transaction_date: string | null; unrealized_value_change: number | null; current_share_price: number | null }>()
  for (let i = 0; i < txnIds.length; i += 200) {
    const { data, error } = await (admin as any).from('investment_transactions')
      .select('id, transaction_type, transaction_date, unrealized_value_change, current_share_price')
      .eq('fund_id', fundId).in('id', txnIds.slice(i, i + 200))
    if (error) throw new Error(`The marks these statements booked could not be read: ${error.message}`)
    for (const t of (data as any[]) ?? []) booked.set(t.id, t)
  }

  const t = reg.terms
  const commitment = n(t?.commitment) ?? 0
  const companyId = reg.holding!.id
  const [position] = computeFundPositions({
    terms: [{ companyId, name: reg.holding!.name, managerName: t?.manager_name ?? null, vintageYear: n(t?.vintage_year), strategy: t?.strategy ?? null, commitment }],
    events: reg.events.map(e => ({
      companyId, kind: e.kind, eventDate: d(e.event_date)!, amount: n(e.amount) ?? 0, recallableAmount: n(e.recallable_amount) ?? 0,
      charReturnOfCapital: n(e.char_return_of_capital) ?? 0, charRealizedGain: n(e.char_realized_gain) ?? 0, charIncome: n(e.char_income) ?? 0,
    })),
    navs: reg.navStatements.map(s => ({ companyId, asOfDate: d(s.as_of_date)!, reportedNav: n(s.reported_nav) ?? 0, basis: (s.basis ?? 'final') as NavBasis })),
    asOf,
  })

  return {
    terms: t ? {
      manager_name: t.manager_name ?? null,
      vintage_year: n(t.vintage_year),
      fund_size: n(t.fund_size),
      strategy: t.strategy ?? null,
      geography: t.geography ?? null,
      commitment,
      commitment_date: d(t.commitment_date),
      final_close_date: d(t.final_close_date),
      term_end_date: d(t.term_end_date),
      notes: t.notes ?? null,
    } : null,
    position: {
      as_of: asOf,
      commitment,
      contributed: position.contributed,
      distributed: position.distributed,
      recallable_returned: position.recallableReturned,
      unfunded: position.unfunded,
      pct_called: position.pctCalled,
      reported_nav: position.reportedNav,
      nav_as_of: position.navAsOf,
      carrying_value: position.carryingValue,
    },
    notices: reg.events.map(e => ({
      id: e.id,
      kind: e.kind,
      event_date: d(e.event_date),
      due_date: d(e.due_date),
      notice_number: e.notice_number ?? null,
      description: e.description ?? null,
      amount: n(e.amount),
      purpose: e.kind === 'call' ? { investments: n(e.purpose_investments), fees: n(e.purpose_fees), expenses: n(e.purpose_expenses) } : undefined,
      character: e.kind === 'distribution' ? { return_of_capital: n(e.char_return_of_capital), realized_gain: n(e.char_realized_gain), income: n(e.char_income), recallable: n(e.recallable_amount) } : undefined,
      status: e.status ?? null,
      transaction_id: e.investment_transaction_id ?? null,
      memo_only: e.status === 'confirmed' && !e.investment_transaction_id,
    })),
    nav_statements: reg.navStatements.map(s => {
      const mark = s.investment_transaction_id ? booked.get(s.investment_transaction_id) : undefined
      return {
        id: s.id,
        as_of_date: d(s.as_of_date),
        received_date: d(s.received_date),
        reported_nav: n(s.reported_nav),
        basis: s.basis ?? null,
        reported_contributions: n(s.reported_contributions),
        reported_distributions: n(s.reported_distributions),
        reported_unfunded: n(s.reported_unfunded),
        source: s.source ?? null,
        mark_transaction_id: s.investment_transaction_id ?? null,
        /** The value change the statement booked; null when it booked nothing. */
        mark_amount: mark ? n(mark.unrealized_value_change) : null,
        mark_date: mark ? d(mark.transaction_date) : null,
        /** No transaction: dated before the ledger's start, or its mark was removed. It still values the holding. */
        memo_only: !s.investment_transaction_id,
      }
    }),
  }
}
