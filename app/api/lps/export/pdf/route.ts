import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import puppeteer from 'puppeteer-core'
import JSZip from 'jszip'
import { getChromeConfig, buildReportHtml, computeRow, computeTotals, runPool, type InvestmentRow } from '@/lib/lp-report-pdf'
import { displayFontOf } from '@/lib/theme'
import { buildLiveReportCards } from '@/lib/lp-report-cards'
import { renderReportCardsZip } from '@/lib/lp-report-cards-zip'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeReportCardRows } from '@/lib/access/lp-scope'
import { loadVehicleLetterheads, pickLetterhead, fundLetterhead, loadFundEmail, contactBlock } from '@/lib/vehicle-letterhead'

export const maxDuration = 300

// ---------------------------------------------------------------------------
// POST handler — batch export: a zip of one PDF per investor, from a frozen snapshot or (live)
// the live report cards.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })
  // Gated on lp_capital read (lib/access/route-domains.ts), like the on-screen cards and the
  // assistant's report card tools: the PDFs carry nothing the caller can't already see there.
  // Both branches below keep to the caller's entities.
  const fundId = membership.fund_id
  const scope = await loadEntityScope(admin, { fundId, userId: user.id, role: membership.role })

  const body = await req.json()
  const { snapshotId, investorIds, excludedGroups, snapshotName, live, asOf } = body as {
    snapshotId?: string
    investorIds: string[]
    excludedGroups: string[]
    snapshotName: string
    live?: boolean
    asOf?: string
  }

  // --- Input validation ---
  if (!Array.isArray(investorIds) || investorIds.length === 0) {
    return NextResponse.json({ error: 'investorIds required' }, { status: 400 })
  }
  if (investorIds.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 investors per request' }, { status: 400 })
  }
  if (!investorIds.every(id => UUID_RE.test(id))) {
    return NextResponse.json({ error: 'Invalid investorId' }, { status: 400 })
  }
  // Live mode builds from the current ledger-derived report; snapshot mode reads a frozen row.
  if (!live && (!snapshotId || !UUID_RE.test(snapshotId))) {
    return NextResponse.json({ error: 'Invalid snapshotId' }, { status: 400 })
  }
  const safeAsOf = (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) ? asOf : undefined

  const safeExcludedGroups = new Set(
    (Array.isArray(excludedGroups) ? excludedGroups : [])
      .map(g => String(g).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200))
      .filter(Boolean)
      .slice(0, 50)
  )

  // --- Live: the cards /lps/cards shows, one PDF each. The fund's report is built once and every
  //     card is cut from it (lib/lp-report-cards), with each investor's own "As of" and connected-
  //     fund positions, exactly as the on-screen card. ---
  if (live) {
    const { data: invs } = await admin.from('lp_investors').select('id').eq('fund_id', fundId).in('id', investorIds)
    if (((invs ?? []) as unknown[]).length !== new Set(investorIds).size) {
      return NextResponse.json({ error: 'One or more investors not found in your fund' }, { status: 403 })
    }
    const built = await buildLiveReportCards(admin, fundId, {
      asOf: safeAsOf,
      investorIds,
      selectRows: (rows, investorOf) => scopeReportCardRows(rows, scope.vehicleNames, investorOf),
      includeConnected: true,
    })
    const { zip, count } = await renderReportCardsZip(admin, fundId, built.cards, {
      excludedGroups: safeExcludedGroups,
      fileSuffix: snapshotName || 'LP Report',
    })
    console.log(`[PDF Export] ${count} live report cards from one build`)
    const safeZipName = (snapshotName || 'LP Reports').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'LP Reports'
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeZipName} - Individual PDFs.zip"`,
      },
    })
  }

  // --- Snapshot: fund-level data ---
  const [investorsResult, fundResult, settingsResult] = await Promise.all([
    admin.from('lp_investors').select('id, name, parent_id').eq('fund_id', fundId),
    admin.from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, lp_report_description, lp_report_footer, theme').eq('fund_id', fundId).maybeSingle(),
  ])

  // --- Snapshot (frozen) report data. ---
  const [snapshotResult, investmentsResult] = await Promise.all([
    (admin.from('lp_snapshots') as any)
      .select('id, name, as_of_date, description, footer_note')
      .eq('id', snapshotId).eq('fund_id', fundId).maybeSingle() as Promise<{ data: any; error: any }>,
    admin.from('lp_investments')
      .select('id, entity_id, portfolio_group, commitment, total_value, nav, called_capital, paid_in_capital, distributions, irr, lp_entities(id, entity_name, investor_id, lp_investors(id, name))')
      .eq('snapshot_id', snapshotId!),
  ])
  const snapshot = snapshotResult.data
  if (!snapshot) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
  // A member who sees only some entities gets cards only for the LPs in them (each card with all
  // of that LP's positions), as the live branch and /api/lps/live-cards do (scopeReportCardRows).
  const snapshotRows = (investmentsResult.data ?? []) as unknown as InvestmentRow[]
  const investorOfEntity = new Map(snapshotRows.map(r => [r.entity_id, r.lp_entities?.lp_investors?.id ?? '']))
  const allInvestments = scopeReportCardRows(snapshotRows, scope.vehicleNames, e => investorOfEntity.get(e) ?? '')
  const description: string | null = snapshot.description
  const footerNote: string | null = snapshot.footer_note
  const asOfDate: string | null = snapshot.as_of_date

  const verifiedInvestors = investorsResult.data ?? []
  const verifiedIds = new Set(verifiedInvestors.map(i => i.id))
  if (investorIds.some(id => !verifiedIds.has(id))) {
    return NextResponse.json({ error: 'One or more investors not found in your fund' }, { status: 403 })
  }

  // Build parent→children map for investor groups
  const allInvestors = verifiedInvestors
  const childrenOf = new Map<string, Set<string>>()
  for (const inv of allInvestors) {
    const group = new Set<string>([inv.id])
    childrenOf.set(inv.id, group)
  }
  // Add children (investors whose parent_id is in our set)
  for (const inv of allInvestors) {
    if (inv.parent_id && childrenOf.has(inv.parent_id)) {
      childrenOf.get(inv.parent_id)!.add(inv.id)
    }
  }

  const fund = fundResult.data as any
  const settings = settingsResult.data as any
  // Per investor below: a vehicle's letterhead when every vehicle on their report shares it.
  const vehicleLetterheads = await loadVehicleLetterheads(admin as any, fundId)
  const fundHead = { ...fundLetterhead(fund), email: await loadFundEmail(admin as any, fundId) }
  const currency = settings?.currency || 'USD'
  const displayFont = displayFontOf(settings?.theme)

  const asOfFormatted = asOfDate
    ? new Date(asOfDate + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  // Group investments by investor
  const investmentsByInvestorId = new Map<string, InvestmentRow[]>()
  for (const inv of allInvestments) {
    const invId = inv.lp_entities?.lp_investors?.id
    if (!invId) continue
    if (!investmentsByInvestorId.has(invId)) investmentsByInvestorId.set(invId, [])
    investmentsByInvestorId.get(invId)!.push(inv)
  }

  // Pre-build HTML for each investor
  const investorHtmlMap = new Map<string, { html: string; safeName: string }>()

  for (const investorId of investorIds) {
    const investor = verifiedInvestors.find(i => i.id === investorId)
    const parent = investor?.parent_id ? verifiedInvestors.find(i => i.id === investor.parent_id) : null
    const investorName = parent?.name ?? investor?.name ?? 'Investor'
    const relatedIds = childrenOf.get(investorId) ?? new Set([investorId])

    // Collect all investments for this investor group
    let investments: InvestmentRow[] = []
    relatedIds.forEach(rid => {
      const invs = investmentsByInvestorId.get(rid)
      if (invs) investments.push(...invs)
    })
    // Outside the caller's entities: no card at all, rather than an empty one under the LP's name.
    if (scope.vehicleNames !== null && investments.length === 0) continue

    // Apply excluded groups filter
    const excludedGroupNames: string[] = []
    if (safeExcludedGroups.size > 0) {
      for (const inv of investments) {
        if (safeExcludedGroups.has(inv.portfolio_group) && Number(inv.commitment) > 0) {
          if (!excludedGroupNames.includes(inv.portfolio_group)) {
            excludedGroupNames.push(inv.portfolio_group)
          }
        }
      }
      investments = investments.filter(inv => !safeExcludedGroups.has(inv.portfolio_group))
    }

    const rows = investments.map(computeRow)
    const totals = computeTotals(rows)
    const letterhead = pickLetterhead(fundHead, investments.map(inv => inv.portfolio_group), vehicleLetterheads)

    const html = buildReportHtml({
      investorName,
      rows,
      totals,
      excludedGroupNames,
      fundName: letterhead.name,
      fundLogo: letterhead.logo,
      fundAddress: contactBlock(letterhead),
      description,
      footerNote,
      asOfFormatted,
      currency,
      displayFont,
    })

    const safeName = investorName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Investor'
    investorHtmlMap.set(investorId, { html, safeName })
  }

  // --- Launch browser and generate PDFs concurrently ---
  const chrome = await getChromeConfig()
  const browser = await puppeteer.launch({
    args: chrome.args,
    defaultViewport: { width: 1024, height: 1400 },
    executablePath: chrome.executablePath,
    headless: true,
  })

  const safeSnapshotName = (snapshotName || 'Report').replace(/[^a-zA-Z0-9 _-]/g, '').trim()

  try {
    const zip = new JSZip()
    const CONCURRENCY = 8

    console.log(`[PDF Export] Generating ${investorIds.length} PDFs with concurrency=${CONCURRENCY} (server-side HTML)`)

    await runPool(investorIds, CONCURRENCY, async (investorId) => {
      const entry = investorHtmlMap.get(investorId)
      if (!entry) return

      const page = await browser.newPage()
      try {
        await page.setContent(entry.html, { waitUntil: 'load' })

        const pdfBuffer = await page.pdf({
          format: 'letter',
          margin: { top: '0.5in', right: '0.6in', bottom: '0.5in', left: '0.6in' },
          printBackground: true,
        })

        zip.file(`${entry.safeName} - ${safeSnapshotName}.pdf`, pdfBuffer)
      } finally {
        await page.close()
      }
    })

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const safeZipName = (snapshotName || 'LP Reports').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'LP Reports'

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeZipName} - Individual PDFs.zip"`,
      },
    })
  } finally {
    await browser.close()
  }
}
