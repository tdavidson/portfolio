'use client'

// The LP investor report card — the printable per-investor summary that aggregates their
// positions across every vehicle. Presentational only: the same card renders whether the
// data came from a frozen snapshot or from the live report, so the two never drift.
//
// Printing is browser-native (window.print + @media print), so the card sets in the reader's
// system font — which is why these read better than the headless-Chrome PDFs.

import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'

export interface ReportCardRow {
  key: string
  entityName: string
  portfolioGroup: string
  commitment: number
  paidInCapital: number | null
  distributions: number | null
  nav: number | null
  totalValue: number | null
  /** Called capital not yet funded (the receivable). Optional — only ledger vehicles have one. */
  receivable?: number | null
  pctFunded: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}

export interface ReportCardTotals {
  commitment: number
  paidInCapital: number | null
  distributions: number | null
  nav: number | null
  totalValue: number | null
  pctFunded: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
}

export interface ReportCardProps {
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  description?: string | null
  investorName: string
  rows: ReportCardRow[]
  totals: ReportCardTotals
  /** A full override for the footnote. When set, replaces the default definitions line. */
  footerNote?: string | null
  /** The report's headline date (e.g. "as of 2026-03-31"). */
  asOfFormatted?: string | null
  /** Per-vehicle last-updated dates — printed in the footnote, because vehicles report on
   *  irregular cadences and a single report-wide "as of" would hide that. */
  vehicleDataDates?: { vehicle: string; date: string | null }[]
  /** Vehicles excluded from this card, noted in the footer. */
  excludedNote?: string[]
}

const moic = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
const pctOf = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

export function LpReportCard(props: ReportCardProps) {
  const currency = useCurrency()
  const fmt = (v: number | null) => formatCurrency(v, currency)
  const fmtFull = (v: number | null) => formatCurrencyFull(v, currency)
  const { fundName, fundLogo, fundAddress, description, investorName, rows, totals } = props

  return (
    <div className="print-page max-w-4xl mx-auto bg-background border rounded-card p-8 print:border-0 print:rounded-none print:shadow-none">
      <div className="report-content">
        {/* Fund header — logo left, name/address right. Matches the statement + letter. */}
        <div className="flex items-start justify-between mb-8">
          <div className="shrink-0">
            {fundLogo && <img src={fundLogo} alt={fundName} className="h-10 w-auto object-contain" />}
          </div>
          <div className="text-right" style={{ marginLeft: '40%' }}>
            <h2 className="text-lg font-semibold tracking-tight">{fundName}</h2>
            {fundAddress && (
              <p className="text-[11px] text-muted-foreground whitespace-pre-line leading-snug mt-0.5">{fundAddress}</p>
            )}
          </div>
        </div>

        {description ? (
          <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed mb-10">{description}</p>
        ) : <div className="mb-6" />}

        <h1 className="font-display text-heading font-normal mb-3">{investorName}</h1>

        {totals.paidInCapital != null && totals.paidInCapital > 0 && (
          <p className="text-xs leading-relaxed mb-5">
            You have invested <strong>{fmtFull(totals.paidInCapital)}</strong>
            {totals.distributions != null && totals.distributions > 0 ? (
              <>. So far you have received <strong>{fmtFull(totals.distributions)}</strong> back, and your current
              investments are valued at <strong>{fmtFull(totals.nav)}</strong>.</>
            ) : (
              <>, and your current investments are valued at <strong>{fmtFull(totals.nav)}</strong>.</>
            )}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No investments found for this investor.</p>
        ) : (
          <>
            <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Capital summary</h3>
            <table className="w-full text-xs mb-5" style={{ tableLayout: 'fixed' }}>
              <Cols />
              <thead>
                <tr className="border-b-2 border-foreground/20">
                  <th className="text-left pl-1.5 pr-2.5 py-1.5 font-semibold">Entity</th>
                  <th className="text-left pl-2.5 pr-1.5 py-1.5 font-semibold">Investment</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">Commitment</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">Paid-in Capital</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">Distributions</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">Net asset balance</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">Total value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} className="border-b border-foreground/10">
                    <td className="pl-1.5 pr-2.5 py-1.5 max-w-0"><div className="line-clamp-2 break-words">{r.entityName}</div></td>
                    <td className="pl-2.5 pr-1.5 py-1.5">{r.portfolioGroup}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.commitment)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.paidInCapital)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.distributions)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.nav)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.totalValue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-foreground/20 font-semibold">
                  <td className="px-1.5 py-1.5" colSpan={2}>Total</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(totals.commitment)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(totals.paidInCapital)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(totals.distributions)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(totals.nav)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(totals.totalValue)}</td>
                </tr>
              </tfoot>
            </table>

            <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Performance metrics</h3>
            <table className="w-full text-xs mb-5" style={{ tableLayout: 'fixed' }}>
              <Cols />
              <thead>
                <tr className="border-b-2 border-foreground/20">
                  <th className="text-left pl-1.5 pr-2.5 py-1.5 font-semibold">Entity</th>
                  <th className="text-left pl-2.5 pr-1.5 py-1.5 font-semibold">Investment</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">% Funded</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">DPI</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">RVPI</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">TVPI</th>
                  <th className="text-right px-1.5 py-1.5 font-semibold">IRR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} className="border-b border-foreground/10">
                    <td className="pl-1.5 pr-2.5 py-1.5 max-w-0"><div className="line-clamp-2 break-words">{r.entityName}</div></td>
                    <td className="pl-2.5 pr-1.5 py-1.5">{r.portfolioGroup}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{pctOf(r.pctFunded)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(r.dpi)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(r.rvpi)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(r.tvpi)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{pctOf(r.irr)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-foreground/20 font-semibold">
                  <td className="px-1.5 py-1.5" colSpan={2}>Total</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{pctOf(totals.pctFunded)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(totals.dpi)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(totals.rvpi)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{moic(totals.tvpi)}</td>
                  <td className="px-1.5 py-1.5"></td>
                </tr>
              </tfoot>
            </table>

            {/* Called but unfunded — only when some vehicle has capital called that the LP has not
                yet wired (the receivable). Shown as its own table so it never muddles the
                paid-in figures above. */}
            {(() => {
              const unfunded = rows.filter(r => (r.receivable ?? 0) > 0.005)
              if (unfunded.length === 0) return null
              const total = unfunded.reduce((s, r) => s + (r.receivable ?? 0), 0)
              return (
                <>
                  <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Called, Not Yet Funded</h3>
                  <table className="w-full text-xs mb-5" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: '17.5%' }} />
                      <col style={{ width: '49.5%' }} />
                      <col style={{ width: '33%' }} />
                    </colgroup>
                    <thead>
                      <tr className="border-b-2 border-foreground/20">
                        <th className="text-left pl-1.5 pr-2.5 py-1.5 font-semibold">Entity</th>
                        <th className="text-left pl-2.5 pr-1.5 py-1.5 font-semibold">Investment</th>
                        <th className="text-right px-1.5 py-1.5 font-semibold">Unfunded (Called)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unfunded.map(r => (
                        <tr key={r.key} className="border-b border-foreground/10">
                          <td className="pl-1.5 pr-2.5 py-1.5 max-w-0"><div className="line-clamp-2 break-words">{r.entityName}</div></td>
                          <td className="pl-2.5 pr-1.5 py-1.5">{r.portfolioGroup}</td>
                          <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(r.receivable ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-foreground/20 font-semibold">
                        <td className="px-1.5 py-1.5" colSpan={2}>Total</td>
                        <td className="px-1.5 py-1.5 text-right tabular-nums">{fmt(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )
            })()}
          </>
        )}
      </div>

      <div className="report-footer text-[9px] text-muted-foreground mt-8 pt-3 border-t print:mt-0 print:pt-2">
        {props.footerNote ? props.footerNote : (
          <>
            {props.asOfFormatted && <>As of {props.asOfFormatted}. </>}
            % Funded = Paid-In Capital / Commitment &bull; DPI = Distributions / Paid-In Capital &bull; RVPI = Net Asset
            Balance / Paid-In Capital &bull; TVPI = DPI + RVPI &bull; IRR = Internal Rate of Return. All figures are net of
            expenses, including estimated carried interest.
          </>
        )}
        {/* Per-vehicle data dates — vehicles report irregularly, so state each one. */}
        {props.vehicleDataDates && props.vehicleDataDates.length > 0 && (
          <div className="mt-1">
            Data last posted: {props.vehicleDataDates.map(v => `${v.vehicle} — ${v.date ?? 'no data'}`).join('; ')}.
          </div>
        )}
        {props.excludedNote && props.excludedNote.length > 0 && (
          <div className="mt-1">
            Note: {props.excludedNote.join(', ')} {props.excludedNote.length === 1 ? 'is' : 'are'} excluded from this report.
          </div>
        )}
      </div>
    </div>
  )
}

/** The shared 7-column grid used by both tables so they align. */
function Cols() {
  return (
    <colgroup>
      <col style={{ width: '19.75%' }} />
      <col style={{ width: '27.75%' }} />
      <col style={{ width: '10.5%' }} />
      <col style={{ width: '10.5%' }} />
      <col style={{ width: '10.5%' }} />
      <col style={{ width: '10.5%' }} />
      <col style={{ width: '10.5%' }} />
    </colgroup>
  )
}

/** The print CSS the card pages share (hides app chrome, fixes the footer to the page). */
export const REPORT_CARD_PRINT_CSS = `
  @page { margin: 0.5in 0.6in; }
  @media print {
    nav, .no-print, [data-sidebar], header, footer, .site-footer, .app-footer { display: none !important; }
    body { background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    * { box-shadow: none !important; }
    .print-page { padding: 0; max-width: none; border: none !important; border-radius: 0 !important; }
    .report-footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 0; border-top: 1px solid #e5e5e5; background: white; }
    .report-content { padding-bottom: 40px; }
    .card-break { break-after: page; page-break-after: always; }
  }
`
