import type { SupabaseClient } from '@supabase/supabase-js'
import { generateLiveReport, type LiveInvestmentRow } from '@/lib/accounting/live-report'
import { currentLiveReport } from '@/lib/accounting/live-report-cache'
import { linkedLiveRows } from '@/lib/fund-connections'
import { reportedThrough } from '@/lib/report-card-footer'

// The LIVE LP report cards, many at once.
//
// The fund's live report is built (or read from the stored report) ONCE, and every investor's
// card is cut from it: a vehicle's rows depend only on that vehicle's books, so an investor's rows
// in the whole-fund report are exactly the rows a build scoped to that investor gives them
// (generateLiveReport entityIds). Building per investor instead repeats the whole fund's capital
// accounts for every card, which is what made a run of cards slow.
//
// Each card is the one /lps/cards/<investor> shows: one investor's positions across the vehicles
// (and, through approved connections, connected funds), with its own "As of" — the latest date
// that investor's figures run through. The on-screen batch, the zip of PDFs and the assistant's
// bulk link all read this, so the three agree card for card. The PDFs are lib/lp-report-cards-zip.ts,
// kept apart so the on-screen route does not carry Chromium.

export interface CardRow {
  /** Stable key: entity + vehicle (with the fund for a connected fund's row). */
  key: string
  entityName: string
  row: LiveInvestmentRow
}

export interface LiveCard {
  investorId: string
  investorName: string
  rows: CardRow[]
  /** The latest date this investor's own figures are reported through (falls back to the report's). */
  asOf: string | null
}

export interface LiveCards {
  asOf: string | null
  /** When today's figures were built; null for a past date, which is always built fresh. */
  refreshedAt: string | null
  cards: LiveCard[]
}

export interface LiveCardsOptions {
  /** A past date; absent = today, from the stored report while it is current. */
  asOf?: string
  /** Rebuild today's stored report regardless. */
  refresh?: boolean
  /** Only these investors' cards; absent or null = every investor. One investor with `asOf` builds
   *  only the vehicles they hold. */
  investorIds?: string[] | null
  /** Narrow the fund's rows before grouping (a member's entity scope). */
  selectRows?: (rows: LiveInvestmentRow[], investorOf: (entityId: string) => string) => LiveInvestmentRow[]
  /** Positions to leave out, by vehicle → LP entity ids (carry recipients, for a caller without
   *  gp_economics). */
  omit?: Map<string, Set<string>>
  /** Add each investor's positions in connected funds (lib/fund-connections). */
  includeConnected?: boolean
  /** With includeConnected: leave out the connected funds' carry recipients too. */
  omitConnectedCarry?: boolean
}

interface EntityInfo { entityName: string; investorId: string; investorName: string }

/** Group report rows into cards. Pure: the loading is buildLiveReportCards'. */
export function groupIntoCards(
  rows: LiveInvestmentRow[],
  entInfo: Map<string, EntityInfo>,
  entityNames: Map<string, string>,
  linked: { investorId: string; fundId: string; entityName: string; row: LiveInvestmentRow }[],
  reportAsOf: string | null,
): LiveCard[] {
  const byInvestor = new Map<string, { investorId: string; investorName: string; rows: CardRow[] }>()
  for (const r of rows) {
    const fallback = entityNames.get(r.entity_id) ?? r.entity_id
    const info = entInfo.get(r.entity_id) ?? { entityName: fallback, investorId: r.entity_id, investorName: fallback }
    const g = byInvestor.get(info.investorId) ?? { investorId: info.investorId, investorName: info.investorName, rows: [] }
    g.rows.push({ key: `${r.entity_id}-${r.portfolio_group}`, entityName: info.entityName, row: r })
    byInvestor.set(info.investorId, g)
  }
  // Only onto a card this caller already gets.
  for (const l of linked) {
    const g = byInvestor.get(l.investorId)
    if (!g) continue
    g.rows.push({ key: `${l.fundId}-${l.row.entity_id}-${l.row.portfolio_group}`, entityName: l.entityName, row: l.row })
  }
  return Array.from(byInvestor.values())
    .map(g => ({ ...g, asOf: reportedThrough(g.rows.map(c => c.row)) ?? reportAsOf }))
    .sort((a, b) => a.investorName.localeCompare(b.investorName))
}

export async function buildLiveReportCards(admin: SupabaseClient, fundId: string, opts: LiveCardsOptions = {}): Promise<LiveCards> {
  const { data: ents, error: entsError } = await (admin as any).from('lp_entities').select('id, entity_name, investor_id, lp_investors(id, name)').eq('fund_id', fundId)
  const entInfo = new Map<string, EntityInfo>()
  for (const e of ((ents as any[]) ?? [])) {
    const inv = Array.isArray(e.lp_investors) ? e.lp_investors[0] : e.lp_investors
    entInfo.set(e.id, { entityName: e.entity_name, investorId: e.investor_id ?? e.id, investorName: inv?.name ?? e.entity_name })
  }
  const investorOf = (entityId: string) => entInfo.get(entityId)?.investorId ?? entityId

  const wanted = opts.investorIds ? new Set(opts.investorIds) : null
  // A past date for a few investors builds only the vehicles they hold.
  const entityIds = wanted && !entsError
    ? ((ents as any[]) ?? []).filter(e => wanted.has(e.investor_id ?? e.id)).map(e => e.id as string)
    : null
  const report = opts.asOf
    ? await generateLiveReport(admin, fundId, opts.asOf, entityIds ? { entityIds } : {})
    : await currentLiveReport(admin, fundId, { refresh: !!opts.refresh })

  let rows = opts.selectRows ? opts.selectRows(report.rows, investorOf) : report.rows
  if (wanted) rows = rows.filter(r => wanted.has(investorOf(r.entity_id)))
  if (opts.omit) rows = rows.filter(r => !opts.omit!.get(r.portfolio_group)?.has(r.entity_id))

  const investorIds = Array.from(new Set(rows.map(r => investorOf(r.entity_id))))
  const linked = opts.includeConnected && investorIds.length > 0
    ? await linkedLiveRows(admin as any, { fundId, investorIds, asOf: opts.asOf, omitCarryRecipients: !!opts.omitConnectedCarry })
    : { rows: [] }

  return {
    asOf: report.asOf,
    refreshedAt: (() => { const at = (report as { computedAt?: unknown }).computedAt; return typeof at === 'string' ? at : null })(),
    cards: groupIntoCards(rows, entInfo, report.entityNames, linked.rows, report.asOf),
  }
}
