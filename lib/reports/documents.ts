// The fund's preformatted documents, built once and served two ways: by the web routes that
// download them (app/api/accounting/{fund-performance/pdf,statements/pdf,k1-packages/pdf,tax-package})
// and by the signed links an assistant hands over (app/api/agent/reports/[token]). Each function
// builds the document and nothing else; whether the caller may have it is the caller's check, made
// before calling, because the two callers authenticate differently.

import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fundPerformance, type PerformanceGrouping } from '@/lib/accounting/fund-performance'
import { buildFundPerformanceHtml } from '@/lib/accounting/fund-performance-pdf'
import { buildStatementPackage, buildStatementPackageFromData, loadLedgerData } from '@/lib/accounting/statement-package'
import { buildStatementsHtml } from '@/lib/accounting/statements-pdf'
import { buildStatementWorkbook } from '@/lib/accounting/statement-workbook'
import { fundCurrency } from '@/lib/accounting/currency'
import { loadJournalForExport, loadChartForExport } from '@/lib/accounting/journal-export-load'
import { journalRows, quickbooksJournalRows, chartRows, generalLedgerRows, trialBalanceRows } from '@/lib/accounting/journal-export'
import { bookTaxBridgeRows } from '@/lib/accounting/book-tax-bridge'
import { toCsv } from '@/lib/accounting/csv'
import { buildTaxPackageZip, taxPackageFileName, type TaxPackageInputs } from '@/lib/accounting/tax-package'
import { closedPeriodRanges } from '@/lib/accounting/periods'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadRealizedGains } from '@/lib/accounting/realized-gains-load'
import { realizedGainsRows } from '@/lib/accounting/realized-gains'
import { loadVendorPayments } from '@/lib/accounting/vendor-payments-load'
import { vendorPaymentsRows } from '@/lib/accounting/vendor-payments'
import { emptyLines, type K1Category } from '@/lib/accounting/k1-allocation'
import { findFinalK1Package, buildK1WorkbookForPackage } from '@/lib/tax/k1-export'
import { generateK1Pdf } from '@/lib/tax/k1-pdf'
import { currentForm, type TaxFormRecord } from '@/lib/tax/forms'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import type { XLSX_TYPE } from '@/lib/forecast/workbook-document'

export interface FundDocument {
  body: Buffer
  fileName: string
  /** An LP letter's export (lp_letter_export) may also be Word, Markdown or JSON. */
  contentType: 'application/pdf' | 'application/zip' | typeof XLSX_TYPE | string
}

/**
 * A document that could not be built for a reason worth saying (the fund's currency unreadable).
 * Not a refusal: every access check has passed before a builder runs.
 */
export class DocumentBuildError extends Error {}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9\-]/g, '-')

/** A document labelled in the wrong currency is a wrong document: refuse rather than guess USD. */
async function currencyOrThrow(admin: SupabaseClient, fundId: string, label: string): Promise<string> {
  try {
    return await fundCurrency(admin, fundId)
  } catch (e) {
    console.error(`[${label}] fund currency`, e instanceof Error ? e.message : e)
    throw new DocumentBuildError("The fund's currency could not be read, so the document was not built. Try again.")
  }
}

async function fundName(admin: SupabaseClient, fundId: string): Promise<string> {
  const { data } = await (admin as any).from('funds').select('name').eq('id', fundId).maybeSingle()
  return (data as { name: string } | null)?.name ?? 'Fund'
}

export async function fundPerformanceDocument(
  admin: SupabaseClient, fundId: string, group: string, asOf: string, grouping: PerformanceGrouping,
): Promise<FundDocument> {
  const [report, currency] = await Promise.all([
    fundPerformance(admin, fundId, group, asOf, grouping),
    currencyOrThrow(admin, fundId, 'fund-performance-pdf'),
  ])
  const body = await renderHtmlToPdf(buildFundPerformanceHtml(report, { currency, generatedAt: new Date().toISOString() }))
  return { body, fileName: `${safeName(`fund-performance-${group}-${report.asOf}`)}.pdf`, contentType: 'application/pdf' }
}

/** `sp` is the statements query: preset or start/end, asOf, compare, basis. */
export async function financialStatementsDocument(
  admin: SupabaseClient, fundId: string, group: string, sp: URLSearchParams,
): Promise<FundDocument> {
  const [pkg, name, currency] = await Promise.all([
    buildStatementPackage(admin, fundId, group, sp),
    fundName(admin, fundId),
    currencyOrThrow(admin, fundId, 'statements-pdf'),
  ])
  const body = await renderHtmlToPdf(buildStatementsHtml(pkg, {
    fundName: name,
    vehicle: group,
    currency,
    generatedAt: new Date().toISOString(),
    basisNote: pkg.basis === 'tax' ? 'Tax basis' : null,
  }))
  const asOf = pkg.payload.period.end ?? new Date().toISOString().split('T')[0]
  return { body, fileName: `${safeName(`statements-${group}-${asOf}`)}.pdf`, contentType: 'application/pdf' }
}

/** One partner's K-1 from one package; null when the package or the partner is not this fund's. */
export async function k1Document(
  admin: SupabaseClient, fundId: string, packageId: string, lpEntityId: string,
): Promise<FundDocument | null> {
  const db = admin as any
  const { data: pkg } = await db
    .from('k1_packages')
    .select('id, vehicle_id, tax_year, version, status, warnings')
    .eq('fund_id', fundId)
    .eq('id', packageId)
    .maybeSingle()
  if (!pkg) return null

  const [{ data: partner }, { data: lines }, name, { data: vehicle }, { data: entity }, { data: forms }] = await Promise.all([
    db.from('k1_partners').select('*').eq('fund_id', fundId).eq('package_id', packageId).eq('lp_entity_id', lpEntityId).maybeSingle(),
    db.from('k1_lines').select('category, amount').eq('fund_id', fundId).eq('package_id', packageId).eq('lp_entity_id', lpEntityId),
    fundName(admin, fundId),
    db.from('fund_vehicles').select('name').eq('id', pkg.vehicle_id).maybeSingle(),
    db.from('lp_entities').select('entity_name').eq('fund_id', fundId).eq('id', lpEntityId).maybeSingle(),
    db.from('lp_tax_forms').select('form_type, signed_date, expires_on, legal_name, tin_last4').eq('fund_id', fundId).eq('lp_entity_id', lpEntityId),
  ])
  if (!partner) return null

  const lineMap = emptyLines()
  for (const l of ((lines as any[]) ?? [])) lineMap[l.category as K1Category] = Number(l.amount)

  const records: (TaxFormRecord & { row: any })[] = ((forms as any[]) ?? []).map(r => ({
    formType: r.form_type,
    signedDate: r.signed_date,
    expiresOn: r.expires_on,
    row: r,
  }))
  const cf = currentForm(records)

  // Only the warnings that touch THIS partner, plus the fund-wide ones. A partner should not be
  // handed another partner's tie-out variance.
  const warnings = (((pkg as any).warnings ?? []) as { detail: string; lpEntityId?: string }[])
    .filter(w => !w.lpEntityId || w.lpEntityId === lpEntityId)
    .map(w => w.detail)

  const p = partner as any
  const body = await generateK1Pdf({
    fundName: name,
    fundLogo: null,
    fundAddress: null,
    vehicle: (vehicle as any)?.name ?? 'Vehicle',
    taxYear: pkg.tax_year,
    version: pkg.version,
    status: pkg.status,
    partnerName: (entity as any)?.entity_name ?? lpEntityId,
    legalName: cf?.row?.legal_name ?? null,
    tinLast4: cf?.row?.tin_last4 ?? null,
    formType: p.form_type ?? null,
    lines: lineMap,
    capitalAccount: {
      beginning: Number(p.beginning_capital),
      contributions: Number(p.contributions),
      distributions: Number(p.distributions),
      netIncome: Number(p.net_income),
      otherChanges: Number(p.other_changes ?? 0),
      ending: Number(p.ending_capital),
    },
    notes: warnings,
  })
  return { body, fileName: `${safeName(`k1-${pkg.tax_year}-v${pkg.version}`)}.pdf`, contentType: 'application/pdf' }
}

/**
 * The year's tax package as one ZIP: workpapers with the prior year as the comparison, the
 * statements as a PDF, the general ledger, the journal (plain and in QuickBooks' layout), the chart
 * of accounts, and the finalised K-1 workbook when there is one and `includeK1` says the caller may
 * read it (a K-1 package holds every partner's figures and the carry; lib/tax/access.ts canReadK1s).
 *
 * Stateless: rebuilt from the ledger on every request, nothing recorded.
 */
export async function taxPackageDocument(
  admin: SupabaseClient, fundId: string, group: string, year: number, opts: { includeK1: boolean },
): Promise<FundDocument> {
  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const generatedAt = new Date().toISOString()

  const [data, taxData, name, currency, entries, taxEntries, priorTaxEntries, chart, closed, vehicleId, gains, payments] = await Promise.all([
    loadLedgerData(admin, fundId, group),
    // The same ledger read on a tax basis — the overlay spliced in — for the tax-basis trial balance.
    loadLedgerData(admin, fundId, group, { basis: 'tax' }),
    fundName(admin, fundId),
    currencyOrThrow(admin, fundId, 'tax-package'),
    loadJournalForExport(admin, fundId, group, { start, end, statuses: ['posted'] }),
    loadJournalForExport(admin, fundId, group, { start, end, statuses: ['posted'], book: 'tax' }),
    // Every earlier tax-book entry: what the opening book-to-tax difference is made of.
    loadJournalForExport(admin, fundId, group, { end: `${year - 1}-12-31`, statuses: ['posted'], book: 'tax' }),
    loadChartForExport(admin, fundId, group),
    closedPeriodRanges(admin, fundId, group),
    vehicleIdByName(admin, fundId, group),
    loadRealizedGains(admin, fundId, group, { start, end }),
    loadVendorPayments(admin, fundId, group, year),
  ])

  // The year with the prior year beside it, from ONE ledger load — the same package the
  // statements page and the workbook export compute.
  const pkg = buildStatementPackageFromData(data, new URLSearchParams({ start, end, compare: '1' }))
  const meta = { fundName: name, vehicle: group, generatedAt }
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
  const k1Pkg = vehicleId ? await findFinalK1Package(admin, fundId, vehicleId, year) : null
  if (!k1Pkg) {
    k1Omitted = `no finalised K-1 package for ${year} on this vehicle.`
  } else if (!opts.includeK1) {
    k1Omitted = "the K-1 package holds each partner's figures and the carried-interest allocation, which your access does not cover."
  } else {
    const { wb } = await buildK1WorkbookForPackage(admin, fundId, k1Pkg)
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

  // Book capital beside tax capital, with the tax-book entries that make the difference: the
  // reconciliation a preparer and the books' owner both start from (lib/accounting/book-tax-bridge.ts).
  const hasTaxBook = taxEntries.length > 0 || priorTaxEntries.length > 0
  const taxPkg = hasTaxBook ? buildStatementPackageFromData(taxData, new URLSearchParams({ start, end, basis: 'tax' })) : null
  const bookTaxBridgeCsv = taxPkg
    ? toCsv(bookTaxBridgeRows({
        year,
        book: pkg.payload.changesInPartnersCapital,
        tax: taxPkg.payload.changesInPartnersCapital,
        priorTaxEntries,
        yearTaxEntries: taxEntries,
        typeOfCode: new Map(taxData.accounts.map(a => [a.code, a.type])),
      }))
    : null

  const body = await buildTaxPackageZip({
    fundName: name, vehicle: group, year, generatedAt, closedThrough, warnings,
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
    taxBasisTrialBalanceCsv: taxPkg ? toCsv(trialBalanceRows(taxPkg.payload.trialBalance)) : null,
    bookTaxBridgeCsv,
    k1, k1Omitted,
  })
  return { body, fileName: taxPackageFileName(group, year), contentType: 'application/zip' }
}
