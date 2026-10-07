// The diligence domain's context block for the unified Analyst: the fund's diligence pipeline.
//
// Fund-wide and deliberately shallow — names, status, and where each deal is in the memo process.
// The deep per-deal evidence (claims, research findings, Q&A, checklist) is what
// lib/diligence/qa-chat-context.ts assembles for the per-deal Q&A; pulling that for every deal
// would blow the prompt. /api/analyst appends this ONLY for a user the `diligence` feature is
// visible to. See plans/plan-unified-analyst.md.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { visibleVehicleIds } from '@/lib/access/scope'

/** Deals beyond this are old closed ones; active work sorts first, so the tail is what's cut. */
const MAX_DEALS = 60
const MAX_NOTES_CHARS = 300

/** Live work first — a passed deal from a year ago matters less than what's on the desk now. */
const STATUS_ORDER: Record<string, number> = { active: 0, on_hold: 1, won: 2, lost: 3, passed: 4 }

export async function buildDiligenceContext(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's access. Required: only records owned by their entities reach the prompt. */
  access: Pick<AccessContext, 'vehicles'>,
): Promise<string> {
  let query = admin
    .from('diligence_deals' as any)
    .select('name, sector, stage_at_consideration, deal_status, current_memo_stage, notes_summary, created_at')
    .eq('fund_id', fundId)
  // Filtered only for a scoped caller: vehicle_id exists once the entity migration has run.
  const vehicleIds = visibleVehicleIds(access)
  if (vehicleIds !== null) query = query.in('vehicle_id', vehicleIds)
  const { data } = await query.order('created_at', { ascending: false })

  const deals = (data as any[]) ?? []
  if (deals.length === 0) return ''

  const sorted = [...deals].sort(
    (a, b) => (STATUS_ORDER[a.deal_status] ?? 9) - (STATUS_ORDER[b.deal_status] ?? 9),
  )
  const shown = sorted.slice(0, MAX_DEALS)

  const counts = new Map<string, number>()
  for (const d of deals) counts.set(d.deal_status, (counts.get(d.deal_status) ?? 0) + 1)

  const lines = shown.map(d => {
    const bits = [
      d.sector,
      d.stage_at_consideration,
      `memo: ${d.current_memo_stage}`,
      `added ${String(d.created_at).slice(0, 10)}`,
    ].filter(Boolean)
    const notes = d.notes_summary ? ` — ${String(d.notes_summary).slice(0, MAX_NOTES_CHARS)}` : ''
    return `  [${d.deal_status}] ${d.name} (${bits.join(', ')})${notes}`
  })

  const summary = Array.from(counts.entries())
    .sort((a, b) => (STATUS_ORDER[a[0]] ?? 9) - (STATUS_ORDER[b[0]] ?? 9))
    .map(([status, n]) => `${n} ${status}`)
    .join(', ')

  return [
    `PIPELINE: ${deals.length} deals — ${summary}`,
    `DEALS (${shown.length}${deals.length > shown.length ? ` of ${deals.length}, active work first` : ''}):\n${lines.join('\n')}`,
  ].join('\n\n')
}

export const DILIGENCE_ANALYST_GUIDE = `The user is in the Diligence section. The fund's diligence pipeline is below.

What the fields mean:
- deal_status: active (in progress), on_hold, passed (declined), won / lost (a competitive process).
- memo stage, in order: not_started → ingest → research → qa → draft → score → render → finalized. It says how far the memo agent has taken that deal, NOT how good the deal is.

This is the pipeline at a glance: names, status, and progress. You do NOT have each deal's underlying evidence here — its documents, research findings, Q&A, or checklist. For questions across the pipeline (what's active, what's stalled, what's in which sector) answer from this. For a question that needs one deal's evidence, say that the deal's own Q&A has it rather than guessing from the summary line.

Diligence deals are a separate pipeline from inbound deals (the pitches that arrive by email). Don't conflate the two.`
