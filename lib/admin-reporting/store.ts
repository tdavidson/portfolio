// Saving an administrator's figures for an admin-reported vehicle, and reading back what was saved.
//
// One write path, shared by the in-app Save, the staged apply_admin_figures action (assistant over
// MCP or the API) and anything later. It checks the pull again at the moment of saving (the partners
// may have changed since the preview), then stores it:
//
//   lp_positions             one row per LP for the date, source 'admin', with the pull's id
//   vehicle_reported_figures the fund's net IRR, TVPI and DPI for the date
//   admin_pulls              the pull as it arrived, with its flags; earlier pulls for the date superseded
//   admin_lp_links           partners matched for the first time, so later pulls match by id
//
// Service-role client only; callers have passed their gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { recordReportedFigures } from '@/lib/accounting/reported-figures'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { adapterFor, fundAdminServer, MANUAL_SOURCES } from './adapters'
import { fundAdminMcpServers } from '@/lib/mcp-client/servers'
import {
  PROVIDER_ID, checkPull, cleanAdminFigures,
  type AdminFigures, type AdminProvider, type LinkRef, type PartnerRef, type PullChannel, type PullFlags, type RecordSource,
} from './figures'

export interface PullContext {
  partners: PartnerRef[]
  links: LinkRef[]
  previous: { id: string; figures: AdminFigures; matches: { externalId: string; lpEntityId: string }[] } | null
}

/** The partners, saved links and the last saved pull on or before the date, for checking a pull. */
export async function loadPullContext(admin: SupabaseClient, fundId: string, vehicleId: string, asOf: string): Promise<PullContext> {
  const [entRes, linkRes, prevRes] = await Promise.all([
    (admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', fundId),
    (admin as any).from('admin_lp_links').select('external_id, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    (admin as any).from('admin_pulls').select('id, figures, flags')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'saved').lte('as_of', asOf)
      .order('as_of', { ascending: false }).order('saved_at', { ascending: false }).limit(1),
  ])
  if (entRes.error) throw new Error(entRes.error.message)
  if (linkRes.error) throw new Error(linkRes.error.message)
  if (prevRes.error) throw new Error(prevRes.error.message)
  const partners = ((entRes.data as any[]) ?? []).map(e => ({ id: e.id as string, name: (e.entity_name ?? '') as string }))
  const links = ((linkRes.data as any[]) ?? []).map(l => ({ externalId: l.external_id as string, lpEntityId: l.lp_entity_id as string }))
  const prevRow = ((prevRes.data as any[]) ?? [])[0]
  let previous: PullContext['previous'] = null
  if (prevRow) {
    const figures = cleanAdminFigures(prevRow.figures)
    const matches = (Array.isArray(prevRow.flags?.matches) ? prevRow.flags.matches : [])
      .filter((m: any) => m?.externalId && m?.lpEntityId)
      .map((m: any) => ({ externalId: String(m.externalId), lpEntityId: String(m.lpEntityId) }))
    if (typeof figures !== 'string') previous = { id: prevRow.id, figures, matches }
  }
  return { partners, links, previous }
}

export interface PullPreview {
  vehicle: string
  figures: AdminFigures
  flags: PullFlags
  /** True when nothing blocks saving. */
  ready: boolean
}

/** Clean and check a pull without saving anything. */
export async function previewAdminPull(
  admin: SupabaseClient, fundId: string, vehicle: { id: string; name: string }, input: unknown,
): Promise<Outcome<PullPreview>> {
  const figures = cleanAdminFigures(input)
  if (typeof figures === 'string') return fail(400, figures)
  let ctx: PullContext
  try { ctx = await loadPullContext(admin, fundId, vehicle.id, figures.asOf) } catch (e: any) { return dbFail(e, 'admin-pull-preview') }
  const flags = checkPull({ figures, partners: ctx.partners, links: ctx.links, previous: ctx.previous })
  return done({ vehicle: vehicle.name, figures, flags, ready: flags.blocking.length === 0 })
}

export interface SavedPull {
  pullId: string
  vehicle: string
  asOf: string
  partners: number
  fundFigures: string[]
  superseded: number
  warnings: string[]
}

/**
 * Save a pull. Refused when anything blocks it; the caller shows the flags and the person fixes the
 * partners or the figures first.
 */
export async function saveAdminPull(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string | null; vehicleNames: string[] | null; channel: PullChannel },
  vehicle: { id: string; name: string },
  input: unknown,
  raw?: unknown,
): Promise<Outcome<SavedPull>> {
  const preview = await previewAdminPull(admin, ctx.fundId, vehicle, input)
  if (!preview.ok) return preview
  const { figures, flags } = preview.value
  if (flags.blocking.length) return fail(409, `The pull can't be saved yet. ${flags.blocking.join(' ')}`, { flags })
  if (ctx.vehicleNames !== null && !ctx.vehicleNames.includes(vehicle.name)) return fail(403, "You don't have access to that entity.")

  const now = new Date().toISOString()
  const { data: pull, error: pullErr } = await (admin as any).from('admin_pulls').insert({
    fund_id: ctx.fundId,
    vehicle_id: vehicle.id,
    as_of: figures.asOf,
    source: figures.source,
    channel: ctx.channel,
    figures,
    raw: raw === undefined ? null : raw,
    flags,
    status: 'saved',
    saved_by: ctx.userId,
    saved_at: now,
  }).select('id').single()
  if (pullErr || !pull) return dbFail(pullErr, 'admin-pull-save')
  const pullId = pull.id as string

  const matchBy = new Map(flags.matches.map(m => [m.externalId, m.lpEntityId as string]))
  const rows = figures.positions.map(p => ({
    fund_id: ctx.fundId,
    vehicle_id: vehicle.id,
    lp_entity_id: matchBy.get(p.externalId),
    as_of_date: figures.asOf,
    commitment: p.commitment,
    called_capital: p.paidIn,
    distributions: p.distributions,
    nav: p.nav,
    receivable: p.receivable ?? null,
    carried_interest: p.carriedInterest ?? null,
    // The fund's net LP-only IRR, which an admin vehicle shows on every LP's row.
    irr: figures.fund.irr,
    source: 'admin',
    pull_id: pullId,
    imported_by: ctx.userId,
    imported_at: now,
  }))
  const { error: posErr } = await (admin as any).from('lp_positions')
    .upsert(rows, { onConflict: 'fund_id,vehicle_id,lp_entity_id,as_of_date' })
  if (posErr) {
    await (admin as any).from('admin_pulls').delete().eq('id', pullId)
    return dbFail(posErr, 'admin-pull-positions')
  }
  // The pull is the whole set for its date: a position on that date for a partner it leaves out
  // (an earlier paste, say) would otherwise sit beside it.
  const kept = rows.map(r => r.lp_entity_id as string)
  const { error: dropErr } = await (admin as any).from('lp_positions').delete()
    .eq('fund_id', ctx.fundId).eq('vehicle_id', vehicle.id).eq('as_of_date', figures.asOf)
    .not('lp_entity_id', 'in', `(${kept.join(',')})`)
  if (dropErr) console.error('[admin-pull-positions] stale rows left:', dropErr.message)

  const fundFigures = (['irr', 'tvpi', 'dpi'] as const)
    .filter(k => figures.fund[k] != null)
    .map(k => ({ metric: k, basis: 'net', value: figures.fund[k] as number }))
  if (fundFigures.length) {
    const recorded = await recordReportedFigures(admin, { fundId: ctx.fundId, userId: ctx.userId, vehicleNames: ctx.vehicleNames }, {
      vehicle: vehicle.name, as_of: figures.asOf, source: figures.source, figures: fundFigures,
    })
    if (!recorded.ok) return fail(recorded.status, `Positions saved, but the fund figures were not: ${recorded.error}`)
  }

  const { data: older } = await (admin as any).from('admin_pulls').update({ status: 'superseded' })
    .eq('fund_id', ctx.fundId).eq('vehicle_id', vehicle.id).eq('as_of', figures.asOf).eq('status', 'saved').neq('id', pullId)
    .select('id')

  const newLinks = flags.matches
    .filter(m => m.lpEntityId && (m.by === 'name' || m.by === 'explicit'))
    .map(m => ({ fund_id: ctx.fundId, vehicle_id: vehicle.id, external_id: m.externalId, lp_entity_id: m.lpEntityId, external_name: m.name }))
  if (newLinks.length) {
    const { error: linkErr } = await (admin as any).from('admin_lp_links').upsert(newLinks, { onConflict: 'vehicle_id,external_id' })
    if (linkErr) console.error('[admin-pull-links]', linkErr.message)
  }

  return done({
    pullId,
    vehicle: vehicle.name,
    asOf: figures.asOf,
    partners: rows.length,
    fundFigures: fundFigures.map(f => f.metric),
    superseded: Array.isArray(older) ? older.length : 0,
    warnings: flags.warnings,
  })
}

/** Set whether a vehicle keeps its own books or reports its administrator's figures. */
export async function setVehicleRecordSource(
  admin: SupabaseClient, fundId: string, vehicleId: string,
  input: { recordSource: unknown; provider?: unknown; fundRef?: unknown },
): Promise<Outcome<{ recordSource: RecordSource; provider: AdminProvider | null; fundRef: string | null }>> {
  const recordSource = input.recordSource
  if (recordSource !== 'books' && recordSource !== 'admin') return fail(400, 'record_source must be books or admin')
  let provider: AdminProvider | null = null
  let fundRef: string | null = null
  if (recordSource === 'admin') {
    const p = String(input.provider ?? '').trim().toLowerCase()
    const server = fundAdminServer(p)
    if (!PROVIDER_ID.test(p) || (!server && !(MANUAL_SOURCES as readonly string[]).includes(p))) {
      const ids = [...fundAdminMcpServers().map(s => s.id), ...MANUAL_SOURCES]
      return fail(400, `provider must be one of ${ids.join(', ')}: a fund administrator's MCP server, or csv / other for figures given by hand`)
    }
    provider = p
    fundRef = typeof input.fundRef === 'string' && input.fundRef.trim() ? input.fundRef.trim().slice(0, 200) : null
    const adapter = adapterFor(server)
    if (adapter) {
      const problem = adapter.checkFundRef(fundRef ?? '')
      if (problem) return fail(400, `fund_ref is needed for ${server!.name} (${adapter.fundRefHint}). ${problem}`)
    }
  }
  const { error } = await (admin as any).from('fund_vehicles')
    .update({ record_source: recordSource, admin_provider: provider, admin_fund_ref: fundRef })
    .eq('fund_id', fundId).eq('id', vehicleId)
  if (error) return dbFail(error, 'admin-record-source')
  return done({ recordSource, provider, fundRef })
}

export interface PullSummary {
  id: string
  asOf: string
  source: string
  channel: PullChannel
  status: 'saved' | 'superseded'
  partners: number
  fund: AdminFigures['fund'] | null
  savedAt: string
  savedBy: string | null
}

/** A vehicle's saved pulls, newest date first. */
export async function listAdminPulls(admin: SupabaseClient, fundId: string, vehicleId: string, limit = 40): Promise<PullSummary[]> {
  const { data, error } = await (admin as any).from('admin_pulls')
    .select('id, as_of, source, channel, status, figures, saved_at, saved_by')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .order('as_of', { ascending: false }).order('saved_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200))
  if (error || !Array.isArray(data)) return []
  return (data as any[]).map(r => ({
    id: r.id,
    asOf: r.as_of,
    source: r.source,
    channel: r.channel,
    status: r.status,
    partners: Array.isArray(r.figures?.positions) ? r.figures.positions.length : 0,
    fund: r.figures?.fund ?? null,
    savedAt: r.saved_at,
    savedBy: r.saved_by ?? null,
  }))
}
