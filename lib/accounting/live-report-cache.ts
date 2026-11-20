import type { SupabaseClient } from '@supabase/supabase-js'
import { generateLiveReport, type LiveReport, type LiveInvestmentRow } from './live-report'

// The stored LP report: the report cards and their PDF read the last whole-fund result instead of
// rebuilding every vehicle's capital accounts on each load.
//
// A stored report is served only while the fund's data version (fund_data_versions, bumped by
// triggers on every table the report reads) is still the one it was built at. Anything posted,
// closed, pulled from an administrator or edited since makes the next read rebuild it. A report
// for a past date (asOf) is never stored: it is built as before.
//
// Older than MAX_AGE_MS, a stored report is rebuilt anyway, as a backstop for a source the triggers
// don't cover. Before the migration is applied the tables are missing, and every read builds
// the report as before.

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface StoredLiveReport extends LiveReport {
  /** When these figures were built (ISO timestamp). */
  computedAt: string
  /** True when the figures came from the stored report rather than a fresh build. */
  fromCache: boolean
}

interface SerializedReport {
  asOf: string | null
  rows: LiveInvestmentRow[]
  vehicles: LiveReport['vehicles']
  entityNames: [string, string][]
}

export function serializeReport(report: LiveReport): SerializedReport {
  return { asOf: report.asOf, rows: report.rows, vehicles: report.vehicles, entityNames: Array.from(report.entityNames.entries()) }
}

export function deserializeReport(s: SerializedReport): LiveReport {
  return { asOf: s.asOf ?? null, rows: s.rows ?? [], vehicles: s.vehicles ?? [], entityNames: new Map(s.entityNames ?? []) }
}

async function readVersion(admin: SupabaseClient, fundId: string): Promise<number | null> {
  try {
    const { data, error } = await (admin as any).from('fund_data_versions').select('version').eq('fund_id', fundId).maybeSingle()
    if (error) return null
    return data ? Number(data.version) : 0
  } catch {
    // No stored report to trust: build it.
    return null
  }
}

/**
 * The fund's LP report as of today, from the stored report when it is still current.
 *
 * It covers the whole fund. A vehicle's rows depend only on that vehicle's books, so it gives any
 * entity exactly the rows a build scoped to that entity gives it (generateLiveReport entityIds),
 * and callers keep the rows they want, as they already do with a scoped build. `refresh` rebuilds
 * regardless.
 */
export async function currentLiveReport(
  admin: SupabaseClient,
  fundId: string,
  opts: { refresh?: boolean; now?: () => Date } = {},
): Promise<StoredLiveReport> {
  const now = opts.now ?? (() => new Date())
  // Read the version BEFORE building: a change that lands mid-build bumps it past the stored one.
  const version = await readVersion(admin, fundId)

  let report: LiveReport | null = null
  let computedAt: string | null = null
  let fromCache = false
  if (version != null && !opts.refresh) {
    const { data, error } = await (admin as any).from('lp_report_cache').select('data_version, report, computed_at').eq('fund_id', fundId).maybeSingle()
    if (!error && data && Number(data.data_version) === version
      && now().getTime() - new Date(data.computed_at).getTime() < MAX_AGE_MS) {
      report = deserializeReport(data.report as SerializedReport)
      computedAt = new Date(data.computed_at).toISOString()
      fromCache = true
    }
  }

  if (!report) {
    report = await generateLiveReport(admin, fundId)
    computedAt = now().toISOString()
    if (version != null) {
      // Best effort: a failed write only means the next read builds again.
      await (admin as any).from('lp_report_cache').upsert({
        fund_id: fundId, data_version: version, report: serializeReport(report), computed_at: computedAt,
      }, { onConflict: 'fund_id' }).then(() => undefined, () => undefined)
    }
  }

  return {
    ...report,
    computedAt: computedAt!,
    fromCache,
  }
}
