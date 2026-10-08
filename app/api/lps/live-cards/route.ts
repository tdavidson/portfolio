import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { lastDataDates } from '@/lib/accounting/lp-positions'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeReportCardRows } from '@/lib/access/lp-scope'

// Everything the LIVE report cards need, in one call: fund header, per-investor rows
// (aggregated across vehicles), and the last-updated date PER VEHICLE.
//
// The cards are the live counterpart to the frozen snapshot cards. Same layout
// (components/lp-report-card), same browser-print path — only the data is live rather than
// a stored snapshot, so they always reflect the latest posted positions.
//
//   GET ?asOf=YYYY-MM-DD (optional) → { fund, currency, asOf, investors[], vehicleDates[] }

const ratio = (n: number | null, d: number): number | null => (n != null && d > 0 ? n / d : null)

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const asOf = req.nextUrl.searchParams.get('asOf') ?? undefined
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  }

  // The report is built fund-wide. The caller's entities decide WHICH LPs get a card; each card
  // carries every one of that LP's positions (scopeReportCardRows).
  const scope = await loadEntityScope(admin, gate)
  const [fullReport, { data: fund }, { data: settings }, { data: ents }] = await Promise.all([
    generateLiveReport(admin, gate.fundId, asOf),
    admin.from('funds' as any).select('name, logo_url, address').eq('id', gate.fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, lp_report_description, lp_report_footer').eq('fund_id', gate.fundId).maybeSingle(),
    admin.from('lp_entities' as any).select('id, entity_name, investor_id, lp_investors(id, name)').eq('fund_id', gate.fundId),
  ])

  const entInfo = new Map<string, { entityName: string; investorId: string; investorName: string }>()
  for (const e of ((ents as any[]) ?? [])) {
    const inv = Array.isArray(e.lp_investors) ? e.lp_investors[0] : e.lp_investors
    entInfo.set(e.id, { entityName: e.entity_name, investorId: e.investor_id ?? e.id, investorName: inv?.name ?? e.entity_name })
  }

  const report = fullReport
  const rows = scopeReportCardRows(report.rows, scope.vehicleNames, id => entInfo.get(id)?.investorId ?? id)

  // Group rows by investor; build the card row shape.
  const byInvestor = new Map<string, { investorId: string; investorName: string; rows: any[] }>()
  for (const r of rows) {
    const info = entInfo.get(r.entity_id) ?? { entityName: report.entityNames.get(r.entity_id) ?? r.entity_id, investorId: r.entity_id, investorName: report.entityNames.get(r.entity_id) ?? r.entity_id }
    const g = byInvestor.get(info.investorId) ?? { investorId: info.investorId, investorName: info.investorName, rows: [] }
    g.rows.push({
      key: `${r.entity_id}-${r.portfolio_group}`,
      entityName: info.entityName,
      portfolioGroup: r.portfolio_group,
      commitment: r.commitment,
      paidInCapital: r.paid_in_capital,
      distributions: r.distributions,
      nav: r.nav,
      totalValue: r.total_value,
      receivable: r.receivable,
      pctFunded: ratio(r.paid_in_capital, r.commitment),
      dpi: r.dpi, rvpi: r.rvpi, tvpi: r.tvpi, irr: r.irr,
    })
    byInvestor.set(info.investorId, g)
  }

  const investors = Array.from(byInvestor.values()).sort((a, b) => a.investorName.localeCompare(b.investorName))

  // Per-vehicle last-updated dates — for the footnote, since vehicles report irregularly.
  const groups = Array.from(new Set(rows.map(r => r.portfolio_group)))
  const dateMap = await lastDataDates(admin, gate.fundId, groups)
  const vehicleDates = groups.sort().map(g => ({ vehicle: g, date: dateMap.get(g) ?? null }))

  const logo = (fund as any)?.logo_url
  return NextResponse.json({
    fund: {
      name: (fund as any)?.name ?? '',
      logo: (typeof logo === 'string' && logo.startsWith('data:image/')) ? logo : null,
      address: (fund as any)?.address ?? null,
    },
    currency: (settings as any)?.currency ?? 'USD',
    description: (settings as any)?.lp_report_description ?? null,
    footer: (settings as any)?.lp_report_footer ?? null,
    asOf: report.asOf,
    investors,
    vehicleDates,
  })
}
