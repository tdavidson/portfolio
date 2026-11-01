// The entity gate for routes about ONE company: `/api/companies/[id]/**` and the fund-holding
// routes (a fund holding is a company row). Runs in the API gate (proxy.ts) after the domain check,
// so a member cannot read, write or even confirm the existence of a company none of their entities
// holds — for every such route at once, without each handler remembering.
//
// Asks with the CALLER's client, not the service role: RLS on company_vehicles already returns only
// the caller's entities' links (20261007100100), so "any row" is the whole test.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from './effective'

/** Registry keys whose `[id]` segment is a company id. */
const COMPANY_ROUTE_PREFIXES = ['api/companies/[id]', 'api/portfolio/fund-holdings/[id]']

/** The company a request is about, or null when the route is about no single company. */
export function companyIdForRoute(key: string, pathname: string): string | null {
  const prefix = COMPANY_ROUTE_PREFIXES.find(p => key === p || key.startsWith(`${p}/`))
  if (!prefix) return null
  const at = prefix.split('/').indexOf('[id]')
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/')
  return parts[at] ? decodeURIComponent(parts[at]) : null
}

/**
 * 404 when the request is about a company none of the caller's entities is linked to; null to let
 * it through. 404 rather than 403: a refusal would confirm the company exists.
 */
export async function companyEntityDenial(
  supabase: SupabaseClient,
  key: string,
  pathname: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<NextResponse | null> {
  if (access.vehicles.all) return null
  const companyId = companyIdForRoute(key, pathname)
  if (!companyId) return null
  const { data } = await (supabase as any).from('company_vehicles').select('company_id').eq('company_id', companyId).limit(1)
  if (((data as any[]) ?? []).length > 0) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/** The deal a request is about, or null. */
export function dealIdForRoute(key: string, pathname: string): string | null {
  if (key !== 'api/deals/[id]' && !key.startsWith('api/deals/[id]/')) return null
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/')
  return parts[2] ? decodeURIComponent(parts[2]) : null
}

/**
 * 404 when the request is about a deal owned by none of the caller's entities — including a deal no
 * entity owns yet (the email pipeline leaves it unassigned), which only admins see until assigned.
 * Read with the caller's client: deal RLS already confines it to their fund.
 */
export async function dealEntityDenial(
  supabase: SupabaseClient,
  key: string,
  pathname: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<NextResponse | null> {
  if (access.vehicles.all) return null
  const dealId = dealIdForRoute(key, pathname)
  if (!dealId) return null
  const { data } = await (supabase as any).from('inbound_deals').select('vehicle_id').eq('id', dealId).maybeSingle()
  const vehicleId = (data as { vehicle_id: string | null } | null)?.vehicle_id ?? null
  if (vehicleId && access.vehicles.ids.includes(vehicleId)) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/**
 * Routes about ONE row of a table whose RLS already applies the entity rule — an LP letter
 * (lp_letters, 20261007100300), a diligence record (diligence_deals, 20261007100400). Reading the row
 * with the caller's own client is the whole test: if RLS hides it, it is not theirs.
 */
const RLS_ROW_ROUTES: { prefix: string; table: string }[] = [
  { prefix: 'api/lp-letters/[id]', table: 'lp_letters' },
  { prefix: 'api/diligence/[id]', table: 'diligence_deals' },
  // A note: its entity and its company (20261007100600). Before the company gate's route below, a
  // note on a shared company that another entity wrote would pass on the company alone.
  { prefix: 'api/companies/[id]/notes/[noteId]', table: 'company_notes' },
  { prefix: 'api/dashboard/notes/[noteId]', table: 'company_notes' },
]

export async function rlsRowDenial(
  supabase: SupabaseClient,
  key: string,
  pathname: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<NextResponse | null> {
  if (access.vehicles.all) return null
  const route = RLS_ROW_ROUTES.find(r => key === r.prefix || key.startsWith(`${r.prefix}/`))
  if (!route) return null
  const id = pathname.replace(/^\/+|\/+$/g, '').split('/')[route.prefix.split('/').length - 1]
  if (!id) return null
  const { data } = await (supabase as any).from(route.table).select('id').eq('id', decodeURIComponent(id)).maybeSingle()
  return data ? null : NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/** Kept for its callers and tests: the LP-letter case of rlsRowDenial. */
export const letterEntityDenial = rlsRowDenial

/**
 * Routes about ONE row that belongs to a company: an inbound email, a metric, a parsing review.
 * `nullVisible` says whether a row about no company is everyone's or for admins to triage (an email
 * the pipeline matched to nothing). Notes are not here: they belong to an entity (rlsRowDenial).
 */
const ROW_COMPANY_ROUTES: { prefix: string; table: string; nullVisible: boolean }[] = [
  { prefix: 'api/emails/[id]', table: 'inbound_emails', nullVisible: false },
  { prefix: 'api/metrics/[id]', table: 'metrics', nullVisible: false },
  { prefix: 'api/review/[id]', table: 'parsing_reviews', nullVisible: false },
]

/** 404 unless the row's company is linked to one of the caller's entities. */
export async function rowCompanyDenial(
  supabase: SupabaseClient,
  key: string,
  pathname: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<NextResponse | null> {
  if (access.vehicles.all) return null
  const route = ROW_COMPANY_ROUTES.find(r => key === r.prefix || key.startsWith(`${r.prefix}/`))
  if (!route) return null
  const at = route.prefix.split('/').length - 1
  const id = pathname.replace(/^\/+|\/+$/g, '').split('/')[at]
  if (!id) return null
  const notFound = NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: row } = await (supabase as any).from(route.table).select('company_id').eq('id', decodeURIComponent(id)).maybeSingle()
  if (!row) return notFound
  const companyId = (row as { company_id: string | null }).company_id
  if (!companyId) return route.nullVisible ? null : notFound
  const { data: links } = await (supabase as any).from('company_vehicles').select('company_id').eq('company_id', companyId).limit(1)
  return ((links as any[]) ?? []).length > 0 ? null : notFound
}

/**
 * A change to ONE company, deal, letter, diligence record, note or company row, from a member whose
 * level in the entities it belongs to is below write (fund_member_vehicles.level: read or propose).
 * The denials above answer "may they see it"; this answers "may they change it". A company held by
 * several entities may be changed by a member with write in any one of them.
 *
 * Runs only for a write-level request from a member with caps, so it costs nothing otherwise. The
 * rows are read with the caller's client, like the checks above: what RLS hides was refused there.
 */
export async function entityWriteDenial(
  supabase: SupabaseClient,
  key: string,
  pathname: string,
  access: Pick<AccessContext, 'vehicles'>,
  level: string,
): Promise<NextResponse | null> {
  if (level !== 'write' || access.vehicles.all) return null
  const caps = access.vehicles.caps
  if (!caps || Object.keys(caps).length === 0) return null
  const writable = (id: string | null | undefined) => !!id && access.vehicles.ids.includes(id) && !caps[id]
  const refused = NextResponse.json(
    { error: 'Your access to this entity is read-only. Ask an admin for more if you need to change it.' },
    { status: 403 },
  )
  const db = supabase as any
  const segment = (prefix: string) => {
    const id = pathname.replace(/^\/+|\/+$/g, '').split('/')[prefix.split('/').indexOf(prefix.includes('[noteId]') ? '[noteId]' : '[id]')]
    return id ? decodeURIComponent(id) : null
  }
  const companyWritable = async (companyId: string) => {
    const { data } = await db.from('company_vehicles').select('vehicle_id').eq('company_id', companyId)
    return ((data as { vehicle_id: string }[]) ?? []).some(r => writable(r.vehicle_id))
  }

  // Rows that carry their own entity, checked first: a note on a shared company belongs to one entity.
  const row = RLS_ROW_ROUTES.find(r => key === r.prefix || key.startsWith(`${r.prefix}/`))
  if (row) {
    const id = segment(row.prefix)
    if (!id) return null
    if (row.table === 'lp_letters') {
      const { data } = await db.from('lp_letters').select('portfolio_group').eq('id', id).maybeSingle()
      const group = (data as { portfolio_group: string | null } | null)?.portfolio_group
      if (!group) return refused
      const { data: vehicles } = await db.from('fund_vehicles').select('id, name, aliases')
      const match = ((vehicles as any[]) ?? []).find(v => v.name === group || ((v.aliases as string[] | null) ?? []).includes(group))
      return writable(match?.id) ? null : refused
    }
    const { data } = await db.from(row.table).select('vehicle_id').eq('id', id).maybeSingle()
    return writable((data as { vehicle_id: string | null } | null)?.vehicle_id) ? null : refused
  }

  const dealId = dealIdForRoute(key, pathname)
  if (dealId) {
    const { data } = await db.from('inbound_deals').select('vehicle_id').eq('id', dealId).maybeSingle()
    return writable((data as { vehicle_id: string | null } | null)?.vehicle_id) ? null : refused
  }

  const companyId = companyIdForRoute(key, pathname)
  if (companyId) return (await companyWritable(companyId)) ? null : refused

  const companyRow = ROW_COMPANY_ROUTES.find(r => key === r.prefix || key.startsWith(`${r.prefix}/`))
  if (companyRow) {
    const id = segment(companyRow.prefix)
    if (!id) return null
    const { data } = await db.from(companyRow.table).select('company_id').eq('id', id).maybeSingle()
    const cid = (data as { company_id: string | null } | null)?.company_id
    return cid && (await companyWritable(cid)) ? null : refused
  }
  return null
}
