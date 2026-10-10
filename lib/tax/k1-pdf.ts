// One partner's K-1 figures, as a PDF.
//
// SAME FUND CHROME as the capital account statement, the notices and the LP letter, so every
// LP-facing document reads as one family.
//
// THIS IS NOT FORM 1065 SCHEDULE K-1. It is the fund's statement of the figures that belong on
// one, laid out box by box so a partner or their preparer can transcribe or check it. The
// official form is issued by whoever files the return, and producing a facsimile of an IRS form
// — with its year-specific layout and its OMB number — would invite it to be filed as though it
// were one. So this is titled as what it is, and says so on its face.
//
// FROZEN, like the notices. Every figure comes from the stored package rather than being
// recomputed: a partner who filed on version 1 must be able to be handed version 1 again after
// an amendment exists.

import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { K1_BOX, K1_CATEGORIES, K1_SUBSET_OF, type K1Category, type K1Lines } from '@/lib/accounting/k1-allocation'

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Accounting convention: negatives in parentheses, a dash for exactly zero. */
function money(v: number): string {
  if (Math.abs(v) < 0.005) return '—'
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return v < 0 ? `(${n})` : n
}

const LINE_LABEL: Record<K1Category, string> = {
  interest: 'Interest income',
  ordinaryDividends: 'Ordinary dividends',
  qualifiedDividends: 'Qualified dividends',
  shortTermGain: 'Net short-term capital gain (loss)',
  longTermGain: 'Net long-term capital gain (loss)',
  section1061Recharacterized: 'Recharacterized under §1061',
  otherIncome: 'Other income (loss)',
  deductions: 'Other deductions',
  distributionsCash: 'Distributions — cash and marketable securities',
  distributionsProperty: 'Distributions — property',
  distributionsOther: 'Distributions — other',
}

export interface K1PdfData {
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  vehicle: string
  taxYear: number
  version: number
  status: string
  partnerName: string
  /** The name on the signed tax form, when it differs from the fund's own record. */
  legalName?: string | null
  tinLast4?: string | null
  formType?: string | null
  lines: K1Lines
  capitalAccount: {
    beginning: number
    contributions: number
    distributions: number
    netIncome: number
    /** Item L "Other increase (decrease)". */
    otherChanges?: number
    ending: number
  }
  /** Package-level issues that touch this partner. Printed rather than withheld. */
  notes?: string[]
}

export function buildK1Html(d: K1PdfData): string {
  const { displayFont } = d

  const isDistribution = (c: K1Category) => c.startsWith('distributions')
  const incomeLines = K1_CATEGORIES.filter(c => !isDistribution(c))
  const distributionLines = K1_CATEGORIES.filter(isDistribution)

  const row = (c: K1Category) => {
    const subsetOf = K1_SUBSET_OF[c]
    // A subset line is indented and annotated, because the one mistake a reader makes here is
    // adding it to the line above.
    const indent = subsetOf ? 'padding-left:22px;color:#555;' : ''
    const note = subsetOf ? ` <span style="color:#888;">(included in box ${K1_BOX[subsetOf]})</span>` : ''
    return `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;width:44px;color:#888;">${esc(K1_BOX[c])}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;${indent}">${esc(LINE_LABEL[c])}${note}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${money(d.lines[c] ?? 0)}</td>
    </tr>`
  }

  const capital = d.capitalAccount
  const capRow = (label: string, v: number) => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(label)}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${money(v)}</td>
    </tr>`

  const notes = (d.notes ?? []).length > 0 ? `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Notes on these figures</h3>
    <ul style="font-size:11px;color:#555;line-height:1.5;padding-left:16px;">
      ${(d.notes ?? []).map(n => `<li style="margin-bottom:3px;">${esc(n)}</li>`).join('')}
    </ul>` : ''

  const amended = d.version > 1
    ? `<p style="font-size:11px;color:#111;margin-top:6px;"><strong>Amended</strong> — version ${d.version}. This supersedes the figures previously issued for ${d.taxYear}.</p>`
    : ''

  const draft = d.status === 'draft'
    ? `<div style="margin:18px 0;padding:10px 14px;border:1px solid #c9a227;background:#fdf8e8;font-size:11px;">
         <strong>Draft.</strong> These figures have not been issued and may change.
       </div>`
    : ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; }
</style></head><body>
  <div style="padding-bottom:52px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">
        ${d.fundLogo ? `<img src="${d.fundLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}
      </div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fundName)}</h2>
        ${d.fundAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fundAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">
      Partner's tax information — ${esc(String(d.taxYear))}
    </h1>
    <p style="font-size:14px;font-weight:600;color:#111;">${esc(d.partnerName)}</p>
    <p style="font-size:11px;color:#888;">
      ${esc(d.vehicle)}${d.legalName && d.legalName !== d.partnerName ? ` &middot; on file as ${esc(d.legalName)}` : ''}
      ${d.tinLast4 ? ` &middot; TIN ending ${esc(d.tinLast4)}` : ''}
      ${d.formType ? ` &middot; ${esc(d.formType.toUpperCase())}` : ''}
    </p>
    ${amended}
    ${draft}

    <h3 style="font-size:12px;font-weight:600;margin:26px 0 6px;">Income, deductions and credits</h3>
    <table>
      <thead><tr><th style="width:44px;">Box</th><th>Item</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${incomeLines.map(row).join('')}</tbody>
    </table>

    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Distributions</h3>
    <table>
      <thead><tr><th style="width:44px;">Box</th><th>Item</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${distributionLines.map(row).join('')}</tbody>
    </table>

    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Partner's capital account analysis (tax basis)</h3>
    <table><tbody>
      ${capRow('Beginning capital account', capital.beginning)}
      ${capRow('Capital contributed during the year', capital.contributions)}
      ${capRow('Current year net income (loss)', capital.netIncome)}
      ${capital.otherChanges ? capRow('Other increase (decrease)', capital.otherChanges) : ''}
      ${capRow('Withdrawals and distributions', -Math.abs(capital.distributions))}
      <tr>
        <td style="padding:6px 8px;border-top:2px solid #ccc;font-weight:600;">Ending capital account</td>
        <td style="padding:6px 8px;border-top:2px solid #ccc;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${money(capital.ending)}</td>
      </tr>
    </tbody></table>

    ${notes}
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    This is the fund's statement of the figures that belong on your ${esc(String(d.taxYear))} Schedule K-1 for
    ${esc(d.vehicle)}. It is not an IRS form and should not be filed in place of one. The Schedule K-1 itself is
    issued with the partnership return. Capital is stated on a tax basis.
  </div>
</body></html>`
}

/** One partner's K-1 figures, rendered to a PDF. The CALLER is responsible for authorization. */
export async function generateK1Pdf(d: K1PdfData): Promise<Buffer> {
  return renderHtmlToPdf(buildK1Html(d))
}
