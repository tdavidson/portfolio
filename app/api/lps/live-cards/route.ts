import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { buildLiveReportCards } from '@/lib/lp-report-cards'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeReportCardRows } from '@/lib/access/lp-scope'

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
  // positions (scopeReportCardRows). With `investor`, only that investor's card (and, for a past
  // date, only the vehicles they hold are built); without it, the whole fund, built once
  // (lib/lp-report-cards).
  const investorParam = req.nextUrl.searchParams.get('investor')
  const scope = await loadEntityScope(admin, gate)
  const [built, { data: fund }, { data: settings }] = await Promise.all([
    // Today's figures come from the stored report while nothing has changed since it was built
    // (live-report-cache); `refresh=1` rebuilds it. A past date is built as before.
    buildLiveReportCards(admin, gate.fundId, {
      asOf,
      refresh: req.nextUrl.searchParams.get('refresh') === '1',
      investorIds: investorParam ? [investorParam] : null,
      selectRows: (rows, investorOf) => scopeReportCardRows(rows, scope.vehicleNames, investorOf),
      // The LP's positions in connected funds, through pairs both funds' admins approved
      // (lib/fund-connections). Only onto a card this caller already gets.
      includeConnected: true,
    }),
    admin.from('funds' as any).select('name, logo_url, address').eq('id', gate.fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, lp_report_description, lp_report_footer').eq('fund_id', gate.fundId).maybeSingle(),
  ])

  // Each card's "As of": the latest date that investor's own figures are reported through.
  const investors = built.cards.map(c => ({
    investorId: c.investorId,
    investorName: c.investorName,
    asOf: c.asOf,
    rows: c.rows.map(({ key, entityName, row: r }) => ({
      key,
      entityName,
      portfolioGroup: r.portfolio_group,
      commitment: r.commitment,
      paidInCapital: r.paid_in_capital,
      distributions: r.distributions,
      nav: r.nav,
      totalValue: r.total_value,
      receivable: r.receivable,
      pctFunded: ratio(r.paid_in_capital, r.commitment),
      dpi: r.dpi, rvpi: r.rvpi, tvpi: r.tvpi, irr: r.irr,
    })),
  }))

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
    asOf: built.asOf,
    // When today's figures were built; null for a past date, which is always built fresh.
    refreshedAt: built.refreshedAt,
    investors,
  })
}
