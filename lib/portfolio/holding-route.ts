// The preamble every per-holding configuration route shares: the holding, in the caller's fund,
// linked to one of the caller's entities — and which of the caller's entities hold it. The API
// gate already 404s a holding none of the caller's entities hold (lib/access/entity-gate.ts); this
// repeats that check because `api/companies/[id]` is GATED in entity-scope-routes.test.ts, so the
// handler is the only thing that scopes its per-entity parts.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEntityScope, type EntityScope } from '@/lib/access/entity-scope'
import type { SoiCompany } from '@/lib/accounting/soi'
import { holdingEntities, type HoldingEntity } from './holding-entities'

export interface HoldingContext {
  holding: SoiCompany & { fund_id: string; holding_type: 'company' | 'fund' | 'crypto' }
  scope: EntityScope
  /** The caller's entities that hold or are assigned this holding. */
  entities: HoldingEntity[]
}

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export async function holdingForRequest(
  admin: SupabaseClient,
  gate: { fundId: string; userId: string; role: string },
  companyId: string,
): Promise<HoldingContext | NextResponse> {
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })
  const unread = (what: string) => NextResponse.json({ error: `Could not read ${what}.` }, { status: 500 })
  const { data: holding, error } = await (admin as any).from('companies')
    .select('id, fund_id, name, holding_type, status, industry, stage, portfolio_group')
    .eq('id', companyId).eq('fund_id', gate.fundId).maybeSingle()
  if (error) return unread('the holding')
  if (!holding) return notFound()
  const scope = await loadEntityScope(admin, gate)
  if (scope.companyIds !== null && !scope.companyIds.includes(companyId)) return notFound()
  let entities: HoldingEntity[]
  try {
    entities = await holdingEntities(admin, gate.fundId, companyId, scope.access)
  } catch {
    return unread("the holding's entities")
  }
  return { holding: { ...holding, holding_type: holding.holding_type ?? 'company' }, scope, entities }
}
