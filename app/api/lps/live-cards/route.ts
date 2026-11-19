import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { reportedThrough } from '@/lib/report-card-footer'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeReportCardRows } from '@/lib/access/lp-scope'
import { linkedLiveRows } from '@/lib/fund-connections'

// Everything the LIVE report cards need, in one call: fund header and per-investor rows
// (aggregated across vehicles), each investor with the date their own figures run through.
//
// The cards are the live counterpart to the frozen snapshot cards. Same layout
// (components/lp-report-card), same browser-print path — only the data is live rather than
// a stored snapshot, so they always reflect the latest posted positions.
//
//   GET ?asOf=YYYY-MM-DD (optional) &investor=<id> (optional: one card, built from only the
//   vehicles that investor holds) → { fund, currency, asOf, investors[{ ..., asOf }] }

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

  // The caller's entities decide WHICH LPs get a card; each card carries every one of that LP's
  // positions (scopeReportCardRows). With `investor`, only the vehicles that investor holds are
  // built (generateLiveReport entityIds); without it, the whole fund.
  const investorParam = req.nextUrl.searchParams.get('investor')
  const scope = await loadEntityScope(admin, gate)
  const { data: ents, error: entsError } = await admin.from('lp_entities' as any).select('id, entity_name, investor_id, lp_investors(id, name)').eq('fund_id', gate.fundId)
  const investorEntityIds = investorParam && !entsError
    ? ((ents as any[]) ?? []).filter(e => (e.investor_id ?? e.id) === investorParam).map(e => e.id as string)
    : null
  const [fullReport, { data: fund }, { data: settings }] = await Promise.all([
    generateLiveReport(admin, gate.fundId, asOf, investorEntityIds ? { entityIds: investorEntityIds } : {}),
    admin.from('funds' as any).select('name, logo_url, address').eq('id', gate.fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, lp_report_description, lp_report_footer').eq('fund_id', gate.fundId).maybeSingle(),
  ])

  const entInfo = new Map<string, { entityName: string; investorId: string; investorName: string }>()
  for (const e of ((ents as any[]) ?? [])) {
    const inv = Array.isArray(e.lp_investors) ? e.lp_investors[0] : e.lp_investors
    entInfo.set(e.id, { entityName: e.entity_name, investorId: e.investor_id ?? e.id, investorName: inv?.name ?? e.entity_name })
  }

  const report = fullReport
  const rows = scopeReportCardRows(report.rows, scope.vehicleNames, id => entInfo.get(id)?.investorId ?? id)
    .filter(r => !investorParam || (entInfo.get(r.entity_id)?.investorId ?? r.entity_id) === investorParam)

  // Group rows by investor; build the card row shape.
  const byInvestor = new Map<string, { investorId: string; investorName: string; rows: any[]; evidence: { evidence?: { asOf: string | null } | null }[] }>()
  for (const r of rows) {
    const info = entInfo.get(r.entity_id) ?? { entityName: report.entityNames.get(r.entity_id) ?? r.entity_id, investorId: r.entity_id, investorName: report.entityNames.get(r.entity_id) ?? r.entity_id }
    const g = byInvestor.get(info.investorId) ?? { investorId: info.investorId, investorName: info.investorName, rows: [], evidence: [] }
    g.evidence.push(r)
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

  // The LP's positions in connected funds, through pairs both funds' admins approved
  // (lib/fund-connections). Only onto a card this caller already gets.
  const linked = await linkedLiveRows(admin, { fundId: gate.fundId, investorIds: Array.from(byInvestor.keys()), asOf })
  for (const l of linked.rows) {
    const g = byInvestor.get(l.investorId)
    if (!g) continue
    const r = l.row
    g.evidence.push(r)
    g.rows.push({
      key: `${l.fundId}-${r.entity_id}-${r.portfolio_group}`,
      entityName: l.entityName,
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
  }

  // Each card's "As of": the latest date that investor's own figures are reported through.
  const investors = Array.from(byInvestor.values())
    .map(({ evidence, ...g }) => ({ ...g, asOf: reportedThrough(evidence) ?? report.asOf }))
    .sort((a, b) => a.investorName.localeCompare(b.investorName))

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
  })
}
