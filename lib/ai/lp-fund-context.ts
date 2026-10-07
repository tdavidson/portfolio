// The LP domain's context block for the unified Analyst: every LP's capital position across the
// whole fund, derived live from the ledger.
//
// Not to be confused with lib/ai/lp-analyst-context.ts, which is the LP-PORTAL-facing analyst —
// scoped to one investor and only to what has been shared with them. This one is GP-facing and
// fund-wide, and /api/analyst appends it ONLY for a user the `lps` feature is visible to. See
// plans/plan-unified-analyst.md.

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { lpRatios } from '@/lib/lp-metrics'
import { scopeLiveReport } from '@/lib/access/lp-scope'

/** A fund with more LPs than this is summarised by its largest positions — the tail is noise in a
 *  prompt, and the totals line still accounts for all of it. */
const MAX_LP_LINES = 100

const money = (n: number | null) => n == null ? 'unknown' : n.toFixed(2)
const add = (a: number | null, b: number | null): number | null => a == null || b == null ? null : a + b
const ratio = (r: number | null) => (r == null ? 'n/a' : `${r.toFixed(2)}x`)
const pct = (r: number | null) => (r == null ? 'n/a' : `${(r * 100).toFixed(1)}%`)

export async function buildLpContext(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's entity names (null = every entity). Required: the prompt carries only these. */
  visibleNames: string[] | null,
): Promise<string> {
  const report = scopeLiveReport(await generateLiveReport(admin, fundId), visibleNames)
  if (report.rows.length === 0) return ''

  // One LP can hold across several vehicles — roll those rows up per LP, the way every other
  // consumer of live-report rows does.
  interface Agg {
    name: string
    commitment: number
    called: number | null
    distributions: number | null
    nav: number | null
    outstanding: number | null
    vehicles: string[]
    /** Only meaningful for a single-vehicle LP: IRRs don't sum across positions. */
    irr: number | null
    rowCount: number
  }
  const byEntity = new Map<string, Agg>()
  for (const r of report.rows) {
    let a = byEntity.get(r.entity_id)
    if (!a) {
      a = {
        name: report.entityNames.get(r.entity_id) ?? r.entity_id.slice(0, 8),
        commitment: 0, called: 0, distributions: 0, nav: 0, outstanding: 0,
        vehicles: [], irr: null, rowCount: 0,
      }
      byEntity.set(r.entity_id, a)
    }
    a.commitment += r.commitment
    a.called = add(a.called, r.paid_in_capital)
    a.distributions = add(a.distributions, r.distributions)
    a.nav = add(a.nav, r.nav)
    a.outstanding = add(a.outstanding, r.outstanding_balance)
    a.vehicles.push(r.lookThroughVia ? `${r.portfolio_group} (via ${r.lookThroughVia})` : r.portfolio_group)
    a.irr = r.irr
    a.rowCount += 1
  }

  const all = Array.from(byEntity.values()).sort((x, y) => y.commitment - x.commitment)
  const shown = all.slice(0, MAX_LP_LINES)

  const lpLines = shown.map(a => {
    const rr = lpRatios({ commitment: a.commitment, paidIn: a.called, distributions: a.distributions, nav: a.nav })
    // An LP in two vehicles has two IRRs and no meaningful combined one — say so rather than
    // publishing a number that isn't real.
    const irr = a.rowCount === 1 ? pct(a.irr) : 'n/a (multi-vehicle)'
    return `  ${a.name}: commit ${money(a.commitment)}, called ${money(a.called)}, outstanding ${money(a.outstanding)}, distributions ${money(a.distributions)}, NAV ${money(a.nav)}, DPI ${ratio(rr.dpi)}, TVPI ${ratio(rr.tvpi)}, IRR ${irr} — in ${a.vehicles.join('; ')}`
  })

  const totals = all.reduce<Omit<Agg, "name" | "vehicles" | "irr" | "rowCount">>(
    (t, a) => ({
      commitment: t.commitment + a.commitment,
      called: add(t.called, a.called),
      distributions: add(t.distributions, a.distributions),
      nav: add(t.nav, a.nav),
      outstanding: add(t.outstanding, a.outstanding),
    }),
    { commitment: 0, called: 0, distributions: 0, nav: 0, outstanding: 0 },
  )
  const tr = lpRatios({ commitment: totals.commitment, paidIn: totals.called, distributions: totals.distributions, nav: totals.nav })

  const parts = [
    `AS OF: ${report.asOf ?? 'today (all data)'}`,
    `VEHICLES (name, capital source, LP count):\n${report.vehicles.map(v => `  ${v.group} (${v.source}, ${v.lps} LPs)`).join('\n')}`,
    `LPs (${shown.length}${all.length > shown.length ? ` of ${all.length}, largest by commitment` : ''}):\n${lpLines.join('\n')}`,
    `FUND TOTALS: commit ${money(totals.commitment)}, called ${money(totals.called)}, outstanding ${money(totals.outstanding)}, distributions ${money(totals.distributions)}, NAV ${money(totals.nav)}, DPI ${ratio(tr.dpi)}, TVPI ${ratio(tr.tvpi)}, ${all.length} LPs`,
  ]
  return parts.join('\n\n')
}

export const LP_ANALYST_GUIDE = `The user is in the LP section. Every LP's capital position across the fund is below, resolved LIVE from reported balances and accounting records — not from a stored snapshot — so it reflects the books as they stand right now.

Definitions, which are easy to get wrong:
- "called" and "paid-in" are THE SAME NUMBER: capital is recognised when it is CALLED, and may still be unfunded. What differs from both is FUNDED (called − outstanding): the cash that actually arrived. "outstanding" is the receivable — called but not yet wired.
- DPI = distributions / called. TVPI = (distributions + NAV) / called. Neither is annualised.
- Calculated IRR is per-LP and call-dated (dated at recognition, not at the wire), so it runs slightly high where LPs fund late. It is shown only for an LP in a single vehicle — IRRs don't sum across positions, and a combined figure would be fabricated.
- Unknown means an input is missing; never substitute zero. Reported IRRs retain their source definition.
- An LP shown "via" an associate holds that position THROUGH a GP/associate vehicle (a look-through), not directly. It is not double-counting.

Answer from these figures, citing LP names and amounts. Never invent an LP, a vehicle, or a number that isn't here, and don't recompute an IRR yourself.`
