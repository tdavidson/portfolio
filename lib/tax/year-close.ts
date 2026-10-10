// Closing and reopening a tax year.
//
// The fiscal-period close locks the actual book. This locks the tax book, on the boundary the
// tax cycle actually uses. Together they mean a K-1 that has been issued stays supported by the
// books it was derived from.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { K1_EXPECTED_HOLDING_TYPE, reportK1Dependencies, type ReceivedK1 } from './received-k1s'

export interface TaxYearState {
  taxYear: number
  closed: boolean
  closedAt: string | null
  reopenedAt: string | null
  reopenedReason: string | null
  /** Packages for the year, so the caller can see what a reopen would put at risk. */
  packages: { id: string; version: number; status: string }[]
  /** Underlying funds that still owe this vehicle a K-1 for the year. */
  outstandingK1s: ReceivedK1[]
  /** Upstream K-1s that were amended after arriving — a prompt to amend ours. */
  amendedK1s: ReceivedK1[]
  /** Every close and reopen of the year, oldest first (tax_year_close_events). */
  history: { action: 'closed' | 'reopened'; at: string; reason: string | null }[]
}

export async function taxYearState(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  taxYear: number,
): Promise<TaxYearState | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const [{ data: close }, { data: packages }, { data: events }] = await Promise.all([
    admin
      .from('tax_year_closes' as any)
      .select('*')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .eq('tax_year', taxYear)
      .maybeSingle(),
    admin
      .from('k1_packages' as any)
      .select('id, version, status')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .eq('tax_year', taxYear)
      .order('version', { ascending: true }),
    admin
      .from('tax_year_close_events' as any)
      .select('action, reason, created_at')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .eq('tax_year', taxYear)
      .order('created_at', { ascending: true }),
  ])

  const deps = await loadK1Dependencies(admin, fundId, vehicleId, taxYear)

  const row = close as any
  return {
    taxYear,
    closed: row?.status === 'closed',
    closedAt: row?.closed_at ?? null,
    reopenedAt: row?.reopened_at ?? null,
    reopenedReason: row?.reopened_reason ?? null,
    packages: ((packages as any[]) ?? []).map(p => ({ id: p.id, version: p.version, status: p.status })),
    outstandingK1s: deps.outstanding,
    amendedK1s: deps.amended,
    history: ((events as any[]) ?? []).map(e => ({ action: e.action, at: e.created_at, reason: e.reason ?? null })),
  }
}

/**
 * Which underlying funds owe this vehicle a K-1, and which have delivered.
 *
 * The expectation is DERIVED from the holdings rather than entered: every `fund` holding files a
 * partnership return and therefore owes one. A holding added last week appears in the chase list
 * without anyone remembering to add it, which is the whole point.
 */
export async function loadK1Dependencies(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  taxYear: number,
) {
  // THIS vehicle's fund holdings only. Read firm-wide, one fund's missing K-1 blocked every other
  // fund's year close, and a status recorded for one vehicle answered for all of them.
  const { data: vehicle } = await admin.from('fund_vehicles' as any).select('name').eq('id', vehicleId).eq('fund_id', fundId).maybeSingle()
  const group = (vehicle as any)?.name as string | undefined
  if (!group) return reportK1Dependencies([], taxYear)
  const [{ data: holdings }, { data: statuses }] = await Promise.all([
    // Filtered in SQL, not in JS: holding-type.test.ts requires every company-shaped query to
    // answer the discriminator question, and a fund holding is the only kind that files a
    // partnership return. The constant is shared with shouldExpectK1 so the rule lives once.
    admin
      .from('companies' as any)
      .select('id, name, holding_type')
      .eq('fund_id', fundId)
      .eq('holding_type', K1_EXPECTED_HOLDING_TYPE)
      .contains('portfolio_group', [group]),
    admin
      .from('received_k1s' as any)
      .select('company_id, tax_year, status, received_date, vehicle_id')
      .eq('fund_id', fundId)
      .eq('tax_year', taxYear),
  ])

  // A status recorded for this vehicle wins; one recorded without a vehicle (older rows) still counts.
  const statusRows = ((statuses as any[]) ?? []).filter(r => !r.vehicle_id || r.vehicle_id === vehicleId)
    .sort((a, b) => (a.vehicle_id ? 1 : 0) - (b.vehicle_id ? 1 : 0))
  const statusByCompany = new Map(statusRows.map(r => [r.company_id as string, r]))
  const rows: ReceivedK1[] = ((holdings as any[]) ?? []).map(h => {
    const s = statusByCompany.get(h.id)
    return {
      companyId: h.id,
      companyName: h.name,
      taxYear,
      // No row yet means nobody has said it arrived, which is exactly 'expected'.
      status: (s?.status ?? 'expected') as ReceivedK1['status'],
      receivedDate: s?.received_date ?? null,
    }
  })

  return reportK1Dependencies(rows, taxYear)
}

/**
 * Close a tax year.
 *
 * REFUSES ON AN UNFINALIZED DRAFT. Closing the year while a draft is outstanding would freeze
 * the books under a package nobody issued — the draft could then never be corrected into
 * something issuable without a reopen, which is a worse position than not having closed. Either
 * issue it or discard it first.
 *
 * Closing with NO package at all is allowed: a vehicle with no partners, or one whose K-1s a
 * preparer produced elsewhere, still wants its tax books frozen.
 */
export async function closeTaxYear(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  taxYear: number,
): Promise<{ ok: true } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const state = await taxYearState(admin, fundId, group, taxYear)
  if ('error' in state) return state
  if (state.closed) return { error: `Tax year ${taxYear} is already closed.` }

  // A year that depends on a K-1 nobody has received is not finished, whatever the books say.
  // Closing it would freeze figures everyone involved knows are provisional.
  if (state.outstandingK1s.length > 0) {
    const deps = reportK1Dependencies(state.outstandingK1s, taxYear)
    return { error: deps.blocker ?? `Underlying K-1s for ${taxYear} are outstanding.` }
  }

  const drafts = state.packages.filter(p => p.status === 'draft')
  if (drafts.length > 0) {
    return {
      error:
        `The ${taxYear} K-1 package (v${drafts[0].version}) is still a draft. Issue it or discard ` +
        'it before closing the year — closing now would freeze the books under a package nobody issued.',
    }
  }

  const { error } = await admin.from('tax_year_closes' as any).upsert(
    {
      fund_id: fundId,
      vehicle_id: vehicleId,
      tax_year: taxYear,
      status: 'closed',
      closed_at: new Date().toISOString(),
      closed_by: userId,
      // The last reopen stays on the row — "closed, reopened in March because the underlying fund
      // amended, closed again" is the history this record exists for. Every close and reopen is
      // also logged in tax_year_close_events.
    },
    { onConflict: 'fund_id,vehicle_id,tax_year' },
  )
  if (error) return { error: error.message }
  await logTaxYearEvent(admin, fundId, vehicleId, taxYear, 'closed', userId, null)
  return { ok: true }
}

/** Append-only history of a tax year's closes and reopens. Best effort: the close itself stands. */
async function logTaxYearEvent(
  admin: SupabaseClient, fundId: string, vehicleId: string, taxYear: number,
  action: 'closed' | 'reopened', userId: string | null, reason: string | null,
) {
  await admin.from('tax_year_close_events' as any).insert({ fund_id: fundId, vehicle_id: vehicleId, tax_year: taxYear, action, actor_id: userId, reason })
}

/**
 * Reopen a closed tax year.
 *
 * A REASON IS REQUIRED. Reopening after K-1s have gone out is the moment that most needs an
 * explanation attached, and asking for one at the point of the decision is the only time anybody
 * will write it. It is recorded on the row rather than replacing the close, so the history of
 * "closed, then reopened in March because the underlying fund amended its own K-1" survives.
 *
 * This does not touch the packages. A final package stays final and its numbers stay frozen —
 * correcting them means amending, which creates a new version. Reopening only unlocks the books
 * so the correction can be made.
 */
export async function reopenTaxYear(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  taxYear: number,
  reason: string,
): Promise<{ ok: true; issuedPackages: number } | { error: string }> {
  const trimmed = (reason ?? '').trim()
  if (trimmed.length < 3) {
    return { error: 'A reason is required to reopen a closed tax year.' }
  }

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const state = await taxYearState(admin, fundId, group, taxYear)
  if ('error' in state) return state
  if (!state.closed) return { error: `Tax year ${taxYear} is not closed.` }

  const { error } = await admin
    .from('tax_year_closes' as any)
    .update({
      status: 'reopened',
      reopened_at: new Date().toISOString(),
      reopened_by: userId,
      reopened_reason: trimmed.slice(0, 1000),
    })
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('tax_year', taxYear)
  if (error) return { error: error.message }
  await logTaxYearEvent(admin, fundId, vehicleId, taxYear, 'reopened', userId, trimmed.slice(0, 1000))

  // Reported, not refused: the caller should be able to say "three issued K-1 packages depend on
  // this year" without the reopen being impossible. Correcting an issued K-1 is exactly why one
  // reopens.
  return { ok: true, issuedPackages: state.packages.filter(p => p.status !== 'draft').length }
}
