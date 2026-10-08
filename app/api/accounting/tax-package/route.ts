import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The K-1 part is gated again in the handler:
// a K-1 package contains the carry, so it joins the bundle only for a caller who may see it.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { loadLedgerData, buildStatementPackageFromData } from '@/lib/accounting/statement-package'
import { buildStatementWorkbook } from '@/lib/accounting/statement-workbook'
import { buildStatementsHtml } from '@/lib/accounting/statements-pdf'
import { loadJournalForExport, loadChartForExport } from '@/lib/accounting/journal-export-load'
import { journalRows, quickbooksJournalRows, chartRows, generalLedgerRows, trialBalanceRows } from '@/lib/accounting/journal-export'
import { toCsv } from '@/lib/accounting/csv'
import { buildTaxPackageZip, taxPackageFileName, type TaxPackageInputs } from '@/lib/accounting/tax-package'
import { fundCurrency } from '@/lib/accounting/currency'
import { closedPeriodRanges } from '@/lib/accounting/periods'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { findFinalK1Package, buildK1WorkbookForPackage } from '@/lib/tax/k1-export'
import { loadRealizedGains } from '@/lib/accounting/realized-gains-load'
import { realizedGainsRows } from '@/lib/accounting/realized-gains'
import { loadVendorPayments } from '@/lib/accounting/vendor-payments-load'
import { vendorPaymentsRows } from '@/lib/accounting/vendor-payments'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET ?group=&year=YYYY — the year's tax package as one ZIP: workpapers with the prior year as
// the comparison, the statements as a PDF, the general ledger, the journal (plain and in
// QuickBooks' layout), the chart of accounts, and the finalised K-1 workbook when there is one.
//
// Stateless: rebuilt from the ledger on every request, nothing recorded.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const year = parseInt(sp.get('year') ?? '', 10)
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    return NextResponse.json({ error: 'year=YYYY is required' }, { status: 400 })
  }

  // A workbook, a browser render and a zip — heavier than any other export. Cap accordingly.
  const limited = await rateLimit({ key: `tax-package:${user.id}`, limit: 10, windowSeconds: 600 })
  if (limited) return limited

  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const generatedAt = new Date().toISOString()

  const [data, taxData, { data: fund }, currency, entries, taxEntries, chart, closed, vehicleId, gains, payments] = await Promise.all([
    loadLedgerData(admin, gate.fundId, group),
    // The same ledger read on a tax basis — the overlay spliced in — for the tax-basis trial balance.
    loadLedgerData(admin, gate.fundId, group, { basis: 'tax' }),
    admin.from('funds').select('name').eq('id', gate.fundId).maybeSingle() as unknown as Promise<{ data: { name: string } | null }>,
    // A document labelled in the wrong currency is a wrong document: refuse rather than guess USD.
    fundCurrency(admin, gate.fundId).catch((e: unknown) => ({ unread: e })),
    loadJournalForExport(admin, gate.fundId, group, { start, end, statuses: ['posted'] }),
    loadJournalForExport(admin, gate.fundId, group, { start, end, statuses: ['posted'], book: 'tax' }),
    loadChartForExport(admin, gate.fundId, group),
    closedPeriodRanges(admin, gate.fundId, group),
    vehicleIdByName(admin, gate.fundId, group),
    loadRealizedGains(admin, gate.fundId, group, { start, end }),
    loadVendorPayments(admin, gate.fundId, group, year),
  ])
  if (typeof currency !== 'string') {
    console.error('[tax-package] fund currency', currency.unread instanceof Error ? currency.unread.message : currency.unread)
    return NextResponse.json({ error: "The fund's currency could not be read, so the document was not built. Try again." }, { status: 500 })
  }
  const fundName = fund?.name ?? 'Fund'

  // The year with the prior year beside it, from ONE ledger load — the same package the
  // statements page and the workbook export compute.
  const pkg = buildStatementPackageFromData(data, new URLSearchParams({ start, end, compare: '1' }))
  const meta = { fundName, vehicle: group, generatedAt }
  const workbook = XLSX.write(buildStatementWorkbook(pkg, meta), { type: 'buffer', bookType: 'xlsx' }) as Buffer

  let statementsPdf: Buffer | null = null
  try {
    statementsPdf = await renderHtmlToPdf(buildStatementsHtml(pkg, { ...meta, currency }))
  } catch (e) {
    // The bundle is still worth having without the PDF — the workbook carries every figure.
    console.error('[tax-package] statements PDF failed', e)
  }

  // K-1: only a FINAL package for the year, and only for a caller allowed to see the carry.
  let k1: TaxPackageInputs['k1'] = null
  let k1Omitted: string | null = null
  const k1Pkg = vehicleId ? await findFinalK1Package(admin, gate.fundId, vehicleId, year) : null
  if (!k1Pkg) {
    k1Omitted = `no finalised K-1 package for ${year} on this vehicle.`
  } else if (await refuseWithoutCarryAccess(admin, gate, user.id)) {
    k1Omitted = 'the K-1 package includes the carried-interest allocation, which your access does not cover.'
  } else {
    const { wb } = await buildK1WorkbookForPackage(admin, gate.fundId, k1Pkg)
    k1 = { workbook: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, version: k1Pkg.version }
  }

  const warnings: string[] = []
  const tb = pkg.payload.trialBalance
  if (!tb.balanced) warnings.push(`Trial balance out of balance: debits ${tb.totalDebits} vs credits ${tb.totalCredits}.`)
  if (pkg.payload.balanceSheet.check !== 0) warnings.push(`Balance sheet does not tie — residual ${pkg.payload.balanceSheet.check}.`)
  if (pkg.payload.balanceSheet.partnersCapital.unallocatedEarnings !== 0) {
    warnings.push(`${pkg.payload.balanceSheet.partnersCapital.unallocatedEarnings} of net income is not yet allocated to partners (period not closed).`)
  }
  const closedThrough = closed.reduce<string | null>((max, p) => (max && max > p.period_end ? max : p.period_end), null)

  const zip = await buildTaxPackageZip({
    fundName, vehicle: group, year, generatedAt, closedThrough, warnings,
    workbook, statementsPdf,
    generalLedgerCsv: toCsv(generalLedgerRows(data.accounts, data.sourcedPostings, { start, end })),
    journalCsv: toCsv(journalRows(entries)),
    quickbooksJournalCsv: toCsv(quickbooksJournalRows(entries)),
    chartCsv: toCsv(chartRows(chart)),
    // The AJE list: what was flagged adjusting in the books. Present even when empty — a
    // preparer reads "no adjusting entries" from an empty file, not from a missing one.
    adjustingEntriesCsv: toCsv(journalRows(entries.filter(e => e.adjusting))),
    taxBookEntriesCsv: taxEntries.length > 0 ? toCsv(journalRows(taxEntries)) : null,
    realizedGainsCsv: gains.disposals.length > 0 ? toCsv(realizedGainsRows(gains)) : null,
    vendorPaymentsCsv: payments.rows.length > 0 ? toCsv(vendorPaymentsRows(payments)) : null,
    taxBasisTrialBalanceCsv: taxEntries.length > 0
      ? toCsv(trialBalanceRows(buildStatementPackageFromData(taxData, new URLSearchParams({ start, end, basis: 'tax' })).payload.trialBalance))
      : null,
    k1, k1Omitted,
  })

  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${taxPackageFileName(group, year)}"`,
    },
  })
}
