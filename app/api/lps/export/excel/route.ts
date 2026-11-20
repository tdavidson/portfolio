import { NextRequest, NextResponse } from 'next/server'
import { lpRatios } from '@/lib/lp-metrics'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { rateLimit } from '@/lib/rate-limit'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeReportCardRows } from '@/lib/access/lp-scope'
import * as XLSX from 'xlsx'

// ---------------------------------------------------------------------------
// POST — generate Excel file of all LP investors and investments
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Use user-scoped client for membership check (RLS enforces user can only see own memberships)
  const { data: membership } = await (supabase as any)
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle() as { data: { fund_id: string; role: string } | null }

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  // Gated on lp_capital read (lib/access/route-domains.ts), like the PDF export and the report
  // cards; a member who sees only some entities gets only the LPs in them (below).
  const admin = createAdminClient()
  const scope = await loadEntityScope(admin, { fundId: membership.fund_id, userId: user.id, role: membership.role })

  // Rate limit: 20 per 5 minutes per user
  const limited = await rateLimit({ key: `lp-export:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const body = await req.json().catch(() => ({}))
  const rawDate = body.asOfDate
  const asOfDate = (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate))
    ? rawDate
    : new Date().toISOString().split('T')[0]
  const snapshotId = body.snapshotId

  // Fetch data
  let investmentsQuery = admin.from('lp_investments' as any)
    .select('*, lp_entities!inner(id, entity_name, investor_id, lp_investors!inner(id, name))')
    .eq('fund_id', membership.fund_id)

  if (snapshotId) {
    if (typeof snapshotId !== 'string') return NextResponse.json({ error: 'Invalid snapshotId' }, { status: 400 })
    const { data: snapCheck } = await admin
      .from('lp_snapshots' as any)
      .select('id')
      .eq('id', snapshotId)
      .eq('fund_id', membership.fund_id)
      .maybeSingle()
    if (!snapCheck) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
    investmentsQuery = investmentsQuery.eq('snapshot_id', snapshotId)
  }

  const { data: investorsData } = await admin.from('lp_investors' as any).select('id, name').eq('fund_id', membership.fund_id).order('name') as any
  const investors: { id: string; name: string }[] = investorsData ?? []

  let investments: any[]
  if (body.live && !snapshotId) {
    // LIVE export — build the same investment shape from the live report rather than a stored
    // snapshot, so "Export Excel" on the live LPs page reflects the current numbers.
    const [report, { data: ents }] = await Promise.all([
      generateLiveReport(admin, membership.fund_id, snapshotId ? undefined : (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined)),
      admin.from('lp_entities' as any).select('id, entity_name, investor_id').eq('fund_id', membership.fund_id),
    ])
    const entInfo = new Map<string, { entity_name: string; investor_id: string }>(
      ((ents as any[]) ?? []).map(e => [e.id, { entity_name: e.entity_name, investor_id: e.investor_id }])
    )
    investments = report.rows.map(r => {
      const info = entInfo.get(r.entity_id)
      return {
        entity_id: r.entity_id,
        portfolio_group: r.portfolio_group,
        commitment: r.commitment,
        paid_in_capital: r.paid_in_capital,
        called_capital: r.called_capital,
        distributions: r.distributions,
        nav: r.nav,
        total_value: r.total_value,
        irr: r.irr,
        lp_entities: { entity_name: info?.entity_name ?? r.entity_id, lp_investors: { id: info?.investor_id ?? r.entity_id } },
      }
    })
  } else {
    const { data } = await investmentsQuery.order('portfolio_group') as any
    investments = data ?? []
  }

  // The caller's entities decide which LPs are listed; each listed LP keeps all of its rows, as on
  // the report cards (scopeReportCardRows).
  const investorOfEntity = new Map<string, string>(investments.map(inv => [inv.entity_id, inv.lp_entities?.lp_investors?.id ?? '']))
  investments = scopeReportCardRows(investments, scope.vehicleNames, e => investorOfEntity.get(e) ?? '')

  // Group investments by investor
  const byInvestor = new Map<string, any[]>()
  for (const inv of investments) {
    const investorId = inv.lp_entities?.lp_investors?.id
    if (!investorId) continue
    const list = byInvestor.get(investorId) ?? []
    list.push(inv)
    byInvestor.set(investorId, list)
  }

  // Build worksheet rows
  const rows: Record<string, string | number>[] = []

  for (const investor of investors) {
    const invs = byInvestor.get(investor.id) ?? []
    const emptyRow = { Investor: '', Entity: '', 'Portfolio Group': '', Commitment: '', 'Paid-In Capital': '', Distributions: '', 'Net Asset Balance': '', 'Total Value': '', '% Funded': '', DPI: '', RVPI: '', TVPI: '', IRR: '' }

    if (invs.length === 0) {
      // An LP outside the caller's entities is left out, not listed empty.
      if (scope.vehicleNames !== null) continue
      rows.push({ ...emptyRow, Investor: investor.name })
      continue
    }

    let totalCommitment = 0
    let totalPIC: number | null = 0
    let totalDist: number | null = 0
    let totalNav: number | null = 0

    for (const inv of invs) {
      const commitment = Number(inv.commitment) || 0
      const pic = inv.paid_in_capital ?? inv.called_capital ?? null
      const dist = inv.distributions ?? null
      const nav = inv.nav ?? null
      const totalValue = inv.total_value ?? (dist == null || nav == null ? null : Number(dist) + Number(nav))
      totalCommitment += commitment
      totalPIC = totalPIC == null || pic == null ? null : totalPIC + Number(pic)
      totalDist = totalDist == null || dist == null ? null : totalDist + Number(dist)
      totalNav = totalNav == null || nav == null ? null : totalNav + Number(nav)

      const { pctFunded, dpi, rvpi, tvpi } = lpRatios({ commitment, paidIn: pic ?? '', distributions: dist ?? '', nav })
      const irr = inv.irr != null ? Number(inv.irr) : null

      rows.push({
        Investor: investor.name,
        Entity: inv.lp_entities?.entity_name ?? '',
        'Portfolio Group': inv.portfolio_group ?? '',
        Commitment: commitment,
        'Paid-In Capital': pic ?? '',
        Distributions: dist ?? '',
        'Net Asset Balance': nav ?? '',
        'Total Value': totalValue ?? '',
        '% Funded': pctFunded != null ? Math.round(pctFunded * 10000) / 100 : '',
        DPI: dpi != null ? Math.round(dpi * 100) / 100 : '',
        RVPI: rvpi != null ? Math.round(rvpi * 100) / 100 : '',
        TVPI: tvpi != null ? Math.round(tvpi * 100) / 100 : '',
        IRR: irr != null ? Math.round(irr * 10000) / 100 : '',
      })
    }

    // Totals row for investor
    if (invs.length > 1) {
      const tTotalValue = totalDist == null || totalNav == null ? null : totalDist + totalNav
      const { pctFunded: tPctFunded, dpi: tDpi, rvpi: tRvpi, tvpi: tTvpi } = lpRatios({ commitment: totalCommitment, paidIn: totalPIC, distributions: totalDist, nav: totalNav })

      rows.push({
        Investor: `${investor.name}, Total`,
        Entity: '',
        'Portfolio Group': '',
        Commitment: totalCommitment,
        'Paid-In Capital': totalPIC ?? '',
        Distributions: totalDist ?? '',
        'Net Asset Balance': totalNav ?? '',
        'Total Value': tTotalValue ?? '',
        '% Funded': tPctFunded != null ? Math.round(tPctFunded * 10000) / 100 : '',
        DPI: tDpi != null ? Math.round(tDpi * 100) / 100 : '',
        RVPI: tRvpi != null ? Math.round(tRvpi * 100) / 100 : '',
        TVPI: tTvpi != null ? Math.round(tTvpi * 100) / 100 : '',
        IRR: '',
      })
    }

    // Blank separator
    rows.push(emptyRow)
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)

  // Set column widths
  ws['!cols'] = [
    { wch: 30 }, // Investor
    { wch: 30 }, // Entity
    { wch: 25 }, // Portfolio Group
    { wch: 15 }, // Commitment
    { wch: 18 }, // Paid-In Capital
    { wch: 15 }, // Distributions
    { wch: 18 }, // Net Asset Balance
    { wch: 15 }, // Total Value
    { wch: 10 }, // % Funded
    { wch: 8 },  // DPI
    { wch: 8 },  // RVPI
    { wch: 8 },  // TVPI
    { wch: 8 },  // IRR
  ]

  XLSX.utils.book_append_sheet(wb, ws, `LP Report ${asOfDate}`.slice(0, 31))
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="lp-report-${String(asOfDate).replace(/[^a-zA-Z0-9\-]/g, '')}.xlsx"`,
    },
  })
}
