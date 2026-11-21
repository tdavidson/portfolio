// Running a statement review for one vehicle and period, saving it, and reading saved reviews back.
//
// One write path, shared by the in-app Run, the statement_review_run tool (assistant over MCP or the
// API) and anything later. A run:
//
//   1. builds the package: from a saved administrator pull, a CSV, a package given whole, or the
//      administrator's documents (the vehicle's entity documents), read by the fund's model or by the
//      person's assistant (extract.ts); figures read from documents are checked against their text
//   2. matches its partners to the vehicle's (the admin-reporting matcher: saved link, then the id
//      the caller gives, then the exact name)
//   3. loads the previous period's review, the partners the app knows in the vehicle, the vehicle's
//      review settings (materiality, watched accounts, known adjustments) and the shadow: the app's
//      own books, bank feed and portfolio for the period (shadow.ts)
//   4. runs the checks (run.ts) and saves the package, the checks and the findings in statement_reviews
//
// Runs are kept: the latest run for a period is that period's review, earlier ones stay as history.
// Review never writes to the books or to an admin-reported vehicle's figures.
//
// Service-role client only; callers have passed their gate (lp_capital).

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/accounting/load'
import { cleanAdminFigures, matchPartners, type LinkRef, type PartnerRef } from '@/lib/admin-reporting/figures'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { cleanPackage, isDate } from './clean'
import { packageFromCsv } from './csv'
import { packageInputFromPull } from './from-admin-pull'
import { runChecks } from './run'
import { loadSettings } from './settings'
import { loadShadow } from './shadow'
import { extractWithServerModel, loadSourceDocuments, packageDocuments, type SourceDocument } from './extract'
import type { KnownPartner } from './checks/shared'
import {
  DEFAULT_MATERIALITY,
  type CheckOutcome, type Finding, type Materiality, type PackageInput, type PartnerStatement, type Severity, type StatementPackage,
} from './types'

export interface ReviewSummary {
  id: string
  periodStart: string
  periodEnd: string
  source: StatementPackage['source']
  input: PackageInput
  counts: Record<Severity, number>
  partners: number
  runAt: string
  runBy: string | null
  /** True for the latest run of its period, which is that period's review. */
  current: boolean
}

export interface StoredReview extends ReviewSummary {
  vehicle: string
  package: StatementPackage
  checks: CheckOutcome[]
  findings: Finding[]
  materiality: Materiality
  threshold: number
  nav: number | null
}

export interface RunRequest {
  /** Where the figures come from. */
  input: PackageInput
  periodEnd?: unknown
  periodStart?: unknown
  /** admin_pull: the saved pull, else the one saved for period_end. */
  pullId?: unknown
  /** csv: the file's text and name. */
  csv?: unknown
  fileName?: unknown
  /** csv: the fund's own statements, given alongside the partner schedule. */
  fund?: unknown
  /** csv: ending cash by account, given alongside the partner schedule. */
  cash?: unknown
  /** csv: the schedule of investments, given alongside the partner schedule. */
  holdings?: unknown
  /** package: the whole package. With document_ids and no package, the fund's model reads the documents. */
  package?: unknown
  /** package: the vehicle's documents the figures were read from (or are to be read from). */
  documentIds?: unknown
  materiality?: unknown
}

function cleanMateriality(v: any, fallback: Materiality): Materiality | string {
  if (v == null) return fallback
  const amount = v.amount == null || v.amount === '' ? fallback.amount : Number(v.amount)
  let navShare = v.nav_share ?? v.navShare
  navShare = navShare == null || navShare === '' ? fallback.navShare : Number(navShare)
  if (!Number.isFinite(amount) || amount < 0) return 'materiality.amount must be an amount of zero or more'
  // "0.5%" style input: a share above 1 is read as a percent.
  if (!Number.isFinite(navShare) || navShare < 0) return 'materiality.nav_share must be a share of NAV: 0.005 for 0.5%'
  return { amount, navShare: navShare > 1 ? navShare / 100 : navShare }
}

/** The fund's partners and the vehicle's saved administrator links, for matching. */
async function loadMatchContext(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<{ partners: PartnerRef[]; links: LinkRef[] }> {
  const [entRes, linkRes] = await Promise.all([
    (admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', fundId),
    (admin as any).from('admin_lp_links').select('external_id, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId),
  ])
  if (entRes.error) throw new Error(entRes.error.message)
  return {
    partners: ((entRes.data as any[]) ?? []).map(e => ({ id: e.id as string, name: (e.entity_name ?? '') as string })),
    // A database without admin reporting has no links: matching falls back to ids and names.
    links: linkRes.error ? [] : ((linkRes.data as any[]) ?? []).map(l => ({ externalId: l.external_id as string, lpEntityId: l.lp_entity_id as string })),
  }
}

/**
 * The partners the app knows in the vehicle on a date: anyone with a commitment left there (the
 * commitment events summed to the date), and anyone in the latest stored positions on or before it
 * (an admin-reported vehicle's last saved pull). Null when neither could be read.
 */
export async function loadKnownPartners(admin: SupabaseClient, fundId: string, vehicleId: string, asOf: string, names: Map<string, string>): Promise<KnownPartner[] | null> {
  let readAny = false
  const ids = new Set<string>()
  try {
    const events = await fetchAllRows<any>((from, to) => (admin as any).from('commitment_events')
      .select('id, lp_entity_id, amount').eq('fund_id', fundId).eq('vehicle_id', vehicleId).lte('effective_date', asOf)
      .order('id').range(from, to))
    readAny = true
    const byLp = new Map<string, number>()
    for (const e of events) byLp.set(e.lp_entity_id, (byLp.get(e.lp_entity_id) ?? 0) + Number(e.amount ?? 0))
    for (const [id, total] of Array.from(byLp.entries())) if (Math.abs(total) > 0.005) ids.add(id)
  } catch { /* fall through to positions */ }
  try {
    const { data: latest, error } = await (admin as any).from('lp_positions').select('as_of_date')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).lte('as_of_date', asOf)
      .order('as_of_date', { ascending: false }).limit(1)
    if (!error) {
      readAny = true
      const date = (latest as any[])?.[0]?.as_of_date
      if (date) {
        const { data: rows } = await (admin as any).from('lp_positions').select('lp_entity_id')
          .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('as_of_date', date)
        for (const r of (rows as any[]) ?? []) if (r.lp_entity_id) ids.add(r.lp_entity_id)
      }
    }
  } catch { /* not readable */ }
  if (!readAny) return null
  return Array.from(ids).map(id => ({ lpEntityId: id, name: names.get(id) ?? 'A partner' })).sort((a, b) => a.name.localeCompare(b.name))
}

const REVIEW_COLUMNS = 'id, vehicle_id, period_start, period_end, source, input, package, checks, findings, counts, materiality, threshold, nav, run_by, run_at'

/** The latest run for the latest period before `periodEnd`: what this period carries on from. */
async function loadPrior(admin: SupabaseClient, fundId: string, vehicleId: string, periodEnd: string): Promise<{ periodEnd: string; partners: PartnerStatement[]; materiality: Materiality | null } | null> {
  const { data, error } = await (admin as any).from('statement_reviews')
    .select('period_end, package, materiality')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).lt('period_end', periodEnd)
    .order('period_end', { ascending: false }).order('run_at', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  const row = (data as any[])?.[0]
  if (!row) return null
  return { periodEnd: row.period_end, partners: (row.package?.partners ?? []) as PartnerStatement[], materiality: row.materiality ?? null }
}

/** Build the package a run asks for, before matching. */
async function buildPackage(
  admin: SupabaseClient, fundId: string, vehicle: { id: string; name: string }, req: RunRequest, userId: string | null,
): Promise<Outcome<{ pkg: StatementPackage; pullId: string | null; sources?: SourceDocument[]; warnings?: string[] }>> {
  const vehicleId = vehicle.id
  if (req.input === 'admin_pull') {
    let q = (admin as any).from('admin_pulls').select('id, as_of, figures, flags, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    if (typeof req.pullId === 'string' && req.pullId) q = q.eq('id', req.pullId)
    else if (isDate(req.periodEnd)) q = q.eq('as_of', req.periodEnd).eq('status', 'saved')
    else return fail(400, 'Name the pull to review: pull_id, or the period_end it was saved for.')
    const { data, error } = await q.order('saved_at', { ascending: false }).limit(1)
    if (error) return dbFail(error, 'statement-review-pull')
    const row = (data as any[])?.[0]
    if (!row) return fail(404, 'No administrator pull is saved for that date. Pull and save the figures first, or upload the package as a CSV.')
    const figures = cleanAdminFigures(row.figures)
    if (typeof figures === 'string') return fail(422, `The saved pull can't be read: ${figures}`)
    const matches = Array.isArray(row.flags?.matches) ? row.flags.matches : []
    const pkg = cleanPackage({ ...packageInputFromPull(figures, matches), ...(isDate(req.periodStart) ? { period_start: req.periodStart } : {}) }, vehicleId)
    if (typeof pkg === 'string') return fail(400, pkg)
    return done({ pkg, pullId: row.id as string })
  }
  if (req.input === 'csv') {
    if (typeof req.csv !== 'string' || !req.csv.trim()) return fail(400, 'csv is required: the partner capital schedule as CSV text.')
    if (req.csv.length > 2_000_000) return fail(413, 'The file is too large.')
    const name = typeof req.fileName === 'string' && req.fileName.trim() ? req.fileName.trim().slice(0, 200) : 'CSV upload'
    const parsed = packageFromCsv(req.csv, name)
    if (typeof parsed === 'string') return fail(400, parsed)
    const fund = req.fund && typeof req.fund === 'object' ? { ...(req.fund as object) } as Record<string, unknown> : {}
    if (parsed.totals && fund.partner_totals == null && fund.partnerTotals == null) fund.partner_totals = parsed.totals
    const pkg = cleanPackage({
      period_end: req.periodEnd, period_start: req.periodStart, source: 'administrator',
      documents: [{ name, kind: 'csv' }], partners: parsed.partners, fund,
      ...(Array.isArray(req.cash) && req.cash.length ? { cash: req.cash } : {}),
      ...(Array.isArray(req.holdings) && req.holdings.length ? { holdings: req.holdings } : {}),
    }, vehicleId)
    if (typeof pkg === 'string') return fail(400, pkg)
    return done({ pkg, pullId: null })
  }
  if (req.input === 'package') {
    let given = req.package && typeof req.package === 'object' ? req.package as Record<string, unknown> : null
    let docs: SourceDocument[] | undefined
    const warnings: string[] = []
    if (req.documentIds != null) {
      const loaded = await loadSourceDocuments(admin, fundId, vehicleId, req.documentIds)
      if (typeof loaded === 'string') return fail(400, loaded)
      docs = loaded
      if (!given) {
        const read = await extractWithServerModel(admin, fundId, userId, docs, {
          vehicle: vehicle.name, ...(isDate(req.periodEnd) ? { periodEnd: req.periodEnd } : {}),
        })
        if ('failed' in read) return fail(read.noKey ? 422 : 502, read.failed)
        given = read.package
        if (read.truncated.length) warnings.push(`Only part of ${read.truncated.join(', ')} was read: the package is longer than one reading.`)
      }
      if (Array.isArray(given.warnings)) warnings.push(...given.warnings.filter((w): w is string => typeof w === 'string').map(w => w.slice(0, 500)).slice(0, 20))
    }
    if (!given) return fail(400, 'package is required, or document_ids for the fund\'s model to read.')
    const pkg = cleanPackage({
      ...given,
      ...(given.period_end == null && given.periodEnd == null && req.periodEnd ? { period_end: req.periodEnd } : {}),
      ...(given.period_start == null && given.periodStart == null && req.periodStart ? { period_start: req.periodStart } : {}),
      ...(docs ? { documents: packageDocuments(docs) } : {}),
    }, vehicleId)
    if (typeof pkg === 'string') return fail(400, docs ? `The package read from the documents can't be used: ${pkg}` : pkg)
    return done({ pkg, pullId: null, ...(docs ? { sources: docs } : {}), ...(warnings.length ? { warnings } : {}) })
  }
  return fail(400, "input must be 'admin_pull', 'csv' or 'package'")
}

function toSummary(r: any, current: boolean): ReviewSummary {
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    source: r.source,
    input: r.input,
    counts: { error: 0, warning: 0, info: 0, ...(r.counts ?? {}) },
    partners: Array.isArray(r.package?.partners) ? r.package.partners.length : 0,
    runAt: r.run_at,
    runBy: r.run_by ?? null,
    current,
  }
}

function toStored(r: any, vehicle: string, current: boolean): StoredReview {
  return {
    ...toSummary(r, current),
    vehicle,
    package: r.package,
    checks: r.checks ?? [],
    findings: r.findings ?? [],
    materiality: r.materiality ?? DEFAULT_MATERIALITY,
    threshold: Number(r.threshold ?? 0),
    nav: r.nav == null ? null : Number(r.nav),
  }
}

/** Run the checks on a package and save the review. */
export async function runReview(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string | null },
  vehicle: { id: string; name: string },
  req: RunRequest,
): Promise<Outcome<StoredReview>> {
  const built = await buildPackage(admin, ctx.fundId, vehicle, req, ctx.userId)
  if (!built.ok) return built
  const { pkg, pullId, sources, warnings } = built.value

  let match: Awaited<ReturnType<typeof loadMatchContext>>
  let prior: Awaited<ReturnType<typeof loadPrior>>
  let settings: Awaited<ReturnType<typeof loadSettings>>
  let shadow: Awaited<ReturnType<typeof loadShadow>>
  try {
    ;[match, prior, settings, shadow] = await Promise.all([
      loadMatchContext(admin, ctx.fundId, vehicle.id),
      loadPrior(admin, ctx.fundId, vehicle.id, pkg.periodEnd),
      loadSettings(admin, ctx.fundId, vehicle.id),
      loadShadow(admin, ctx.fundId, vehicle, { start: pkg.periodStart, end: pkg.periodEnd }),
    ])
  } catch (e: any) {
    return dbFail(e, 'statement-review-load')
  }
  // The vehicle's setting, unless this run names its own.
  const materiality = cleanMateriality(req.materiality, settings.materiality)
  if (typeof materiality === 'string') return fail(400, materiality)

  // Map the package's partners to the vehicle's. Unmatched ones stay, and completeness flags them.
  const matches = matchPartners(pkg.partners ?? [], match.partners, match.links)
  if (pkg.partners) {
    pkg.partners = pkg.partners.map((p, i) => {
      const { lpEntityId: _given, ...rest } = p
      return matches[i]?.lpEntityId ? { ...rest, lpEntityId: matches[i].lpEntityId as string } : rest
    })
  }
  const names = new Map(match.partners.map(p => [p.id, p.name]))
  const known = await loadKnownPartners(admin, ctx.fundId, vehicle.id, pkg.periodEnd, names)

  const result = runChecks({
    pkg, prior, known, matches, shadow, settings,
    ...(sources ? { sources: sources.map(d => ({ name: d.name, text: d.text })) } : {}),
  }, materiality)
  // What the reader said it was unsure of travels with the package, so a reviewer sees it.
  if (warnings?.length) pkg.readingWarnings = warnings

  const { data, error } = await (admin as any).from('statement_reviews').insert({
    fund_id: ctx.fundId,
    vehicle_id: vehicle.id,
    period_start: pkg.periodStart,
    period_end: pkg.periodEnd,
    source: pkg.source,
    input: req.input,
    admin_pull_id: pullId,
    package: pkg,
    checks: result.checks,
    findings: result.findings,
    counts: result.counts,
    materiality,
    threshold: result.threshold,
    nav: result.nav,
    run_by: ctx.userId,
  }).select(REVIEW_COLUMNS).single()
  if (error || !data) return dbFail(error, 'statement-review-save')
  return done(toStored(data, vehicle.name, true))
}

/** A vehicle's reviews, newest period first, every run of each period with the latest marked current. */
export async function listReviews(admin: SupabaseClient, fundId: string, vehicleId: string, limit = 60): Promise<ReviewSummary[]> {
  const { data, error } = await (admin as any).from('statement_reviews')
    .select('id, period_start, period_end, source, input, counts, package, run_by, run_at')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .order('period_end', { ascending: false }).order('run_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200))
  if (error || !Array.isArray(data)) return []
  const seen = new Set<string>()
  return (data as any[]).map(r => {
    const current = !seen.has(r.period_end)
    seen.add(r.period_end)
    return toSummary(r, current)
  })
}

/** One review: by id, or the current one for a period end, or the latest of all. */
export async function getReview(
  admin: SupabaseClient, fundId: string, vehicle: { id: string; name: string },
  which: { id?: unknown; periodEnd?: unknown },
): Promise<Outcome<StoredReview>> {
  let q = (admin as any).from('statement_reviews').select(REVIEW_COLUMNS).eq('fund_id', fundId).eq('vehicle_id', vehicle.id)
  if (typeof which.id === 'string' && which.id) q = q.eq('id', which.id)
  else if (which.periodEnd != null) {
    if (!isDate(which.periodEnd)) return fail(400, 'period_end must be a date (YYYY-MM-DD)')
    q = q.eq('period_end', which.periodEnd)
  }
  const { data, error } = await q.order('period_end', { ascending: false }).order('run_at', { ascending: false }).limit(1)
  if (error) return dbFail(error, 'statement-review-get')
  const row = (data as any[])?.[0]
  if (!row) return fail(404, `No statement review for ${vehicle.name}${which.periodEnd ? ` for ${which.periodEnd}` : ''} yet.`)
  // Current when no later run exists for the same period.
  const { data: later } = await (admin as any).from('statement_reviews').select('id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicle.id).eq('period_end', row.period_end).gt('run_at', row.run_at).limit(1)
  return done(toStored(row, vehicle.name, !((later as any[])?.length)))
}
