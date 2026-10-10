import { reportingIrr } from '@/lib/accounting/reporting-irr'
import { advanceBalances } from '@/lib/accounting/call-extras'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadEntityNames, loadEntityClasses } from '@/lib/accounting/load'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { computeCapitalAccounts, totalNav, type CapitalPosting } from '@/lib/accounting/capital-account'
import { lpIrr } from '@/lib/accounting/live-report'
import { latestPositionIrr } from '@/lib/accounting/lp-positions'
import { lpCapitalSummary, listCapitalCalls } from '@/lib/accounting/capital-calls'
import { loadStrandedCapital } from '@/lib/accounting/pooled-capital-check'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'

// GET — per-LP capital-account roll-forward for a vehicle.
//
// Returns TWO roll-forwards per LP: `period` (activity within the statement period,
// opening with the balance carried in) and `itd` (inception to date). A capital
// account statement shows both columns side by side.
//
// `source` says where those numbers came from — 'ledger' (posted journal entries) or
// 'events' (lp_capital_events, for a vehicle tracked at the capital-account level only).
// The page is the same either way; it just grows an event-entry surface in 'events' mode
// and drops the double-entry-only affordances (issuing a call, the administrator tie-out).
//
//   ?preset=this_quarter|last_quarter|ytd|prior_year|itd   — or —
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD                       (custom window)
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const sp = req.nextUrl.searchParams
  const preset = sp.get('preset') as PeriodPreset | null
  const start = sp.get('start')
  const end = sp.get('end')
  // "As of" sets the report date the preset window ends at — resolvePeriod computes the window
  // relative to it (ITD ends there, this-quarter is the quarter containing it, etc.). Absent = today.
  const asOfRaw = sp.get('asOf')
  const asOf = asOfRaw && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? new Date(`${asOfRaw}T00:00:00`) : undefined
  const period = preset && preset !== 'custom' ? resolvePeriod(preset, asOf) : customPeriod(start, end)

  // One load, unfiltered by date: both roll-forwards are computed from it, and the
  // period one needs the pre-period history anyway to open with a carried-in balance.
  // `summary` and `calls` fold the old Capital calls page into this one — commitment,
  // called, funded, and unfunded were the duplicated half of it.
  const [{ source, postings: capitalPostings, evidenceByLp }, names, classes, summary, calls, stranded] = await Promise.all([
    loadCapitalPostings(admin, gate.fundId, group, period.end ?? undefined),
    loadEntityNames(admin, gate.fundId, group),
    loadEntityClasses(admin, gate.fundId, group),
    lpCapitalSummary(admin, gate.fundId, group, period.end ?? undefined),
    listCapitalCalls(admin, gate.fundId, group),
    // Capital sitting on the pooled account reaches no partner, which reads on this page as
    // a fund where nobody has contributed. Surface it rather than render the zeroes.
    loadStrandedCapital(admin, gate.fundId, group),
  ])

  // Money each partner sent before it was called, not yet applied to a call (call-extras.ts).
  const advances = await advanceBalances(admin, gate.fundId, group)
  const periodAccounts = computeCapitalAccounts(capitalPostings, period)
  const itdAccounts = computeCapitalAccounts(capitalPostings, { end: period.end })
  const summaryByLp = new Map(summary.map(s => [s.lpEntityId, s]))

  // Per-LP Net IRR. Ledger: derive from each LP's dated flows + terminal NAV at the report date.
  // Events: the reported IRR pasted on the latest position.
  const irrByLp = new Map<string, number>()
  for (const [lp, evidence] of evidenceByLp) {
    const value = reportingIrr(capitalPostings.filter(p => p.lpEntityId === lp), itdAccounts.get(lp)?.ending ?? 0, evidence)
    if (value != null) irrByLp.set(lp, value)
  }

  // Every partner with a commitment OR a capital account — a partner who has committed
  // but never been called still belongs on the roll-forward.
  const lpIds = Array.from(new Set([...Array.from(itdAccounts.keys()), ...summary.map(s => s.lpEntityId), ...Array.from(evidenceByLp.keys())]))

  const rows = lpIds
    .map(lpEntityId => {
      const itd = itdAccounts.get(lpEntityId) ?? computeCapitalAccounts([]).get(lpEntityId) ?? null
      const s = summaryByLp.get(lpEntityId)
      const zero = computeCapitalAccounts([{ lpEntityId, amount: 0, sourceType: 'manual' }]).get(lpEntityId)!
      return {
        lpEntityId,
        evidence: evidenceByLp.get(lpEntityId),
        name: names.get(lpEntityId) ?? s?.name ?? lpEntityId,
        partnerClass: classes.get(lpEntityId) ?? s?.partnerClass ?? 'lp',
        commitment: s?.commitment ?? 0,
        called: s ? s.called : null,
        funded: s ? s.funded : null,
        outstanding: s ? s.outstanding : null,
        receivable: s ? s.receivable : null,
        advance: advances.get(lpEntityId) ?? 0,
        fundedUnderflow: s?.fundedUnderflow ?? false,
        period: periodAccounts.get(lpEntityId) ?? null,
        itd: itd ?? zero,
        irr: irrByLp.get(lpEntityId) ?? null,
        // The flat spread keeps the previous response shape working for existing
        // consumers (reconciliation view, agent tools) — it's the ITD roll-forward.
        ...(itd ?? zero),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return NextResponse.json({
    rows,
    nav: rows.some(r => r.evidence?.values.nav === null) ? null : Array.from(evidenceByLp.values()).reduce((n, e) => n + (e.values.nav ?? 0), 0),
    period,
    calls,
    source,
    stranded,
  })
}
