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
