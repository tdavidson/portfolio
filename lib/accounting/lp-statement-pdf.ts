// LP capital account statement → PDF.
//
// Same fund chrome as the investor report and the LP letter (logo left, fund name
// and address right, rule-and-note footer) so the three LP-facing PDFs read as one
// family. Rendered through the shared HTML → headless-Chrome pipeline.
//
// WHY THIS ONE GETS STORED. Snapshot PDFs are re-rendered from data on every
// download. That's fine for a snapshot, but a capital account statement is a
// point-in-time record an LP may have filed with their accountant. If it re-rendered
// from the ledger, reopening a period or amending an entry would silently change a
// statement that was already sent. So the publish route writes the Buffer to the
// `lp-documents` bucket and shares the stored file — the numbers are frozen at the
// moment you publish.

import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { displayFontOf } from '@/lib/theme'
import { getCurrencySymbol } from '@/lib/currency'
import { lpStatement } from './capital-calls'
import { lastDataDate } from './lp-positions'
import type { CapitalAccount } from './capital-account'
import { rollForwardRows, commitmentSummaryRows, statementColumns } from './capital-statement-layout'
import type { CapitalPeriod } from './capital-account'
import type { StatementPeriod } from './statement-period'
import type { SupabaseClient } from '@supabase/supabase-js'
import { documentLetterhead, contactBlock } from '@/lib/vehicle-letterhead'
import { BASIS_NOTES, DEFAULT_STATEMENT_BASIS, type StatementBasis } from './statement-basis'

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Accounting convention: negatives in parentheses, a dash for exactly zero. */
function money(v: number | null, currency: string): string {
  if (v == null) return '—'
  if (Math.abs(v) < 0.005) return '—'
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // Was `currency === 'USD' ? '$' : ''` — so a EUR fund's LP statement showed bare numbers with
  // no unit at all, on the one document an LP is most likely to file with their accountant.
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`

export { NET_PNL_LABEL, PNL_FIELDS } from './capital-statement-layout'

export interface StatementPdfData {
  /** Fund's display face (FundTheme.displayFont). Absent = Newsreader. */
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  currency: string
  vehicle: string
  partnerName: string
  period: StatementPeriod
  row: { commitment: number; called: number | null; funded: number | null; outstanding: number | null; receivable: number | null; ending: number | null }
  periodRollForward: CapitalAccount
  /** January 1 of the period end's year through the period end (ytdWindow). */
  ytdRollForward: CapitalAccount
  rollForward: CapitalAccount
  ownership: number
  /** When this vehicle's underlying data was last updated (footnote). Vehicles report on
   *  irregular cadences, so the reporting PERIOD and the last-updated date are not the same. */
  dataAsOf?: string | null
  /** The basis the figures are presented on (statement-basis.ts). Absent = fair value. */
  basis?: StatementBasis
}

export function buildStatementHtml(d: StatementPdfData): string {
  const { currency, displayFont } = d
  const m = (v: number | null) => money(v, currency)

  // The statement ends with the commitment summary. The transaction list and the fund-of-funds
  // exhibits (underlying commitments, performance, valuation basis) used to follow it; they belong
  // to the fund's financials, not to a partner's capital account.
  const columns = statementColumns(d.period, { period: d.periodRollForward, ytd: d.ytdRollForward, itd: d.rollForward })
  const accounts = columns.map(c => c.value)

  const cell = (v: string) =>
    `<td style="padding:6px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${v}</td>`
  const rollForwardHtml = rollForwardRows(accounts).map(({ label, values, style }) => `
    <tr${style === 'total' ? ' style="font-weight:600;background:#fafafa;"' : style === 'subtotal' ? ' style="font-weight:600;"' : ''}>
      <td style="padding:6px 8px${style === 'component' ? ' 6px 22px' : ''};border-top:1px solid #e5e5e5;${style === 'component' ? 'color:#555;' : ''}">${esc(label)}</td>
      ${values.map(v => cell(m(v))).join('')}
    </tr>`).join('')

  const lastCol = accounts.length - 1
  const summary: [string, string[]][] = commitmentSummaryRows(accounts, d.row, d.ownership, d.basis ?? DEFAULT_STATEMENT_BASIS).map(r => [
    r.label,
    r.values.map((v, i) => v === null && i < lastCol ? '' : r.format === 'percent' ? pct(v ?? 0) : m(v)),
  ])

  const basisNote = BASIS_NOTES[d.basis ?? DEFAULT_STATEMENT_BASIS]

  const periodLabel = d.period.start && d.period.end
    ? `${d.period.label} (${d.period.start} to ${d.period.end})`
    : d.period.label

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; }
</style></head><body>
  <div style="padding-bottom:40px;">
    <!-- Fund header — identical to the investor report and LP letter -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">
        ${d.fundLogo ? `<img src="${d.fundLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}
      </div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fundName)}</h2>
        ${d.fundAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fundAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">Capital Account Statement</h1>
    <p style="font-size:14px;font-weight:600;color:#111;">${esc(d.partnerName)}</p>
    <p style="font-size:11px;color:#888;margin-bottom:${basisNote ? '4' : '22'}px;">${esc(d.vehicle)} &middot; ${esc(periodLabel)}</p>
    ${basisNote ? `<p style="font-size:11px;color:#555;margin-bottom:22px;">${esc(basisNote)}</p>` : ''}

    <!-- Roll-forward -->
    <table>
      <thead>
        <tr>
          <th></th>
          ${columns.map(({ label: h }) => `<th style="text-align:right;width:130px;">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rollForwardHtml}</tbody>
    </table>

    <!-- Commitment summary -->
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Commitment summary</h3>
    <table>
      <tbody>
        ${summary.map(([k, vs]) => `
          <tr>
            <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(k)}</td>
            ${vs.map(v => `<td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;width:130px;">${v}</td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table>

  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    Capital account statement for ${esc(d.partnerName)} in ${esc(d.vehicle)}. Prepared from the fund's books of account.
    Figures are stated in ${esc(currency)} and reflect the period shown.${basisNote ? ` ${esc(basisNote)}` : ''}${d.dataAsOf ? ` Underlying data for ${esc(d.vehicle)} was last updated ${esc(d.dataAsOf)}.` : ''} This statement is unaudited and may be subject to further adjustment; it should not be used for tax purposes. It is provided to limited partners for informational purposes.
  </div>
</body></html>`
}

/**
 * One LP's capital account statement, rendered to a PDF. Mirrors generateLetterPdf.
 * The CALLER is responsible for authorization.
 */
export async function generateLpStatementPdf(
  admin: SupabaseClient,
  opts: { fundId: string; group: string; lpEntityId: string; period: StatementPeriod; basis?: StatementBasis },
): Promise<{ pdf: Buffer; fileName: string; partnerName: string } | null> {
  const { fundId, group, lpEntityId, period } = opts
  const basis = opts.basis ?? DEFAULT_STATEMENT_BASIS

  const capitalPeriod: CapitalPeriod = { start: period.start, end: period.end }
  const [statement, fundRes, settingsRes] = await Promise.all([
    lpStatement(admin, fundId, group, lpEntityId, capitalPeriod, basis),
    admin.from('funds' as any).select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, theme').eq('fund_id', fundId).maybeSingle(),
  ])

  if ('error' in statement) return null

  const fund = (fundRes as any).data
  // The vehicle's own letterhead where it has one (a separately branded vehicle's LPs know it by
  // that brand), else the fund's. Logos are data URIs only: a remote URL fails in headless Chrome.
  const letterhead = await documentLetterhead(admin, fundId, fund, [group])
  const currency = (settingsRes as any).data?.currency || 'USD'

  const dataAsOf = await lastDataDate(admin, fundId, group)

  const html = buildStatementHtml({
    displayFont: displayFontOf(settingsRes.data?.theme),
    fundName: letterhead.name,
    fundLogo: letterhead.logo,
    fundAddress: contactBlock(letterhead),
    currency,
    vehicle: group,
    partnerName: statement.row.name,
    period,
    row: statement.row,
    periodRollForward: statement.periodRollForward,
    ytdRollForward: statement.ytdRollForward,
    rollForward: statement.rollForward,
    ownership: statement.ownership,
    dataAsOf,
    basis,
  })

  const pdf = await renderHtmlToPdf(html)
  const safe = (s: string) => String(s || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  const basisSuffix = basis === 'cost' ? ' - Cost Basis' : basis === 'cash_only' ? ' - Contributions and Income' : ''
  // The partner's entity, then the vehicle, so a folder of statements sorts by partner and still
  // says which vehicle each one is for.
  const fileName = `${safe(statement.row.name) || 'Partner'} - ${safe(group) || 'Vehicle'} - Capital Account Statement - ${safe(period.label) || 'Period'}${basisSuffix}.pdf`

  return { pdf, fileName, partnerName: statement.row.name }
}
