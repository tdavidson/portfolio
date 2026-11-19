// Pulling an admin-reported vehicle's figures from Carta, with the asking member's own Carta sign-in.
//
// Carta's MCP server reaches its fund administration warehouse through `read_tool`, which runs a read
// command by name; `dwh__execute__query` runs one SELECT. Two queries per pull, both for one fund and
// one date:
//
//   FUND_ADMIN.PARTNER_MONTHLY_NAV_CALCULATIONS   each partner's cumulative commitment, contributions,
//                                                 distributions and ending NAV at the month end
//   FUND_ADMIN.TEMPORAL_FUND_COHORT_BENCHMARKS    the fund's net LP-only IRR (a percent), TVPI and DPI
//                                                 for the quarter
//
// Carta keeps both by date, so any past quarter can be pulled; nothing is scheduled. The figures come
// back exactly as Carta states them, shaped for cleanAdminFigures. RVPI and the call receivable are
// not pulled: Carta keeps no LP-only RVPI by quarter, and its receivable is current only.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMcpServerForUser } from '@/lib/mcp-client/connections'
import { callMcpTool, type McpToolsError } from '@/lib/mcp-client/tools'
import type { FetchLike } from '@/lib/mcp-client/oauth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}$/
const READ_TOOL = 'read_tool'
const QUERY_COMMAND = 'dwh__execute__query'

/** The two SELECTs for one fund and date. Inputs are checked here, so nothing else reaches the SQL. */
export function cartaQueries(fundRef: string, asOf: string): { positions: string; fund: string } {
  if (!UUID.test(fundRef)) throw new Error("The vehicle's Carta fund id must be a UUID.")
  if (!ISO.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new Error('as_of must be a date (YYYY-MM-DD).')
  return {
    positions:
      'select partner_uuid, partner_name, cumulative_total_commitment, cumulative_total_contributions, ' +
      'cumulative_total_distributions, ending_total_nav from FUND_ADMIN.PARTNER_MONTHLY_NAV_CALCULATIONS ' +
      `where fund_id = '${fundRef}' and month_end_date = '${asOf}' order by partner_uuid`,
    fund:
      'select net_lp_irr, lp_tvpi, lp_dpi from FUND_ADMIN.TEMPORAL_FUND_COHORT_BENCHMARKS ' +
      `where fund_uuid = '${fundRef}' and performance_quarter_start_date = '${asOf}'`,
  }
}

/**
 * The rows of a query's reply. Carta answers with a short header line and then one JSON object per
 * row (ndjson), sometimes wrapped as {"result": "..."}.
 */
export function parseCartaRows(text: string): Record<string, unknown>[] {
  let body = text.trim()
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).result === 'string') body = (parsed as any).result
      else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [parsed as Record<string, unknown>]
    } catch { /* ndjson: more than one object */ }
  }
  const rows: Record<string, unknown>[] = []
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith('{')) continue
    try {
      const row = JSON.parse(l)
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        // Column names come back in either case; read them lower-cased.
        rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v])))
      }
    } catch { /* a line that isn't a row */ }
  }
  return rows
}

/** A pull's figures from the two replies, in the shape cleanAdminFigures takes. */
export function cartaFigures(asOf: string, positionRows: Record<string, unknown>[], fundRows: Record<string, unknown>[]) {
  const fund = fundRows[0] ?? {}
  const irr = fund.net_lp_irr
  return {
    as_of: asOf,
    source: 'Carta',
    positions: positionRows.map(r => ({
      external_id: r.partner_uuid,
      name: r.partner_name,
      commitment: r.cumulative_total_commitment,
      paid_in: r.cumulative_total_contributions,
      distributions: r.cumulative_total_distributions,
      nav: r.ending_total_nav,
    })),
    fund: {
      // Carta states the IRR as a percent (6.08 for 6.08%); say so, so a small one isn't read as a fraction.
      irr: irr == null || irr === '' ? null : `${irr}%`,
      tvpi: fund.lp_tvpi ?? null,
      dpi: fund.lp_dpi ?? null,
    },
  }
}

export type CartaPull =
  | { ok: true; input: ReturnType<typeof cartaFigures>; raw: { positions: Record<string, unknown>[]; fund: Record<string, unknown>[] } }
  | { ok: false; error: string }

/** Pull one date's figures from Carta with this member's own connection. Writes nothing. */
export async function pullFromCarta(
  admin: SupabaseClient, userId: string, fundRef: string, asOf: string, opts: { fetchImpl?: FetchLike } = {},
): Promise<CartaPull> {
  let queries: { positions: string; fund: string }
  try { queries = cartaQueries(fundRef, asOf) } catch (e: any) { return { ok: false, error: e.message } }
  const server = await getMcpServerForUser(admin, userId, 'carta', opts)
  if (!server) {
    return { ok: false, error: 'Connect your Carta account in Settings → Connectors first (an admin turns Carta on for the fund).' }
  }
  if (!server.allowedTools?.includes(READ_TOOL)) {
    return { ok: false, error: "Your Carta connection doesn't offer the read command the pull needs. Reconnect Carta in Settings." }
  }
  const run = (sql: string) => callMcpTool(server.url, server.authorizationToken!, READ_TOOL, {
    name: QUERY_COMMAND,
    arguments: { sql, format: 'ndjson', response_mode: 'inline' },
    _instrumentation_v2: { plugins: [], skills: [], surface: 'other' },
  }, { fetchImpl: opts.fetchImpl })
  try {
    const [posText, fundText] = await Promise.all([run(queries.positions), run(queries.fund)])
    const positions = parseCartaRows(posText)
    const fund = parseCartaRows(fundText)
    if (positions.length === 0) {
      return { ok: false, error: `Carta has no partner figures for that fund at ${asOf}. Check the date is a month end Carta has closed, and the fund id.` }
    }
    return { ok: true, input: cartaFigures(asOf, positions, fund), raw: { positions, fund } }
  } catch (e) {
    return { ok: false, error: `Carta didn't answer the pull: ${(e as McpToolsError)?.message ?? 'unknown error'}` }
  }
}
