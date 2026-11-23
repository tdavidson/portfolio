// Capital call and distribution notices → PDF.
//
// Same fund chrome as the capital account statement, the investor report and the LP letter
// (logo left, fund name and address right, rule-and-note footer) so every LP-facing PDF reads
// as one family. Rendered through the shared HTML → headless-Chrome pipeline.
//
// FROZEN, MORE THAN THE STATEMENT IS. A statement is a point-in-time record and gets stored
// rather than re-rendered so that reopening a period can't silently change a document an LP
// already filed. A notice is stronger: it is a DEMAND for money, or a promise of it. The amount
// a partner was told to wire has to remain exactly what they were told even if the call is
// later amended, partly funded, or reversed. So every number here comes from the REGISTER
// (`capital_call_lines` / `distribution_lines`), never recomputed from the ledger — the
// receivable and the payable both decay as money moves, and deriving a notice from them would
// restate history every time someone paid.

import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { getCurrencySymbol } from '@/lib/currency'

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
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

import type { NoticeData, NoticeKind } from './notice-types'
export type { NoticeData, NoticeKind }

const TITLE: Record<NoticeKind, string> = {
  capital_call: 'Capital Call Notice',
  distribution: 'Distribution Notice',
}

/**
 * The notice, as HTML. Pure — no I/O — so the layout can be exercised in a test without
 * launching a browser.
 */
export function buildNoticeHtml(d: NoticeData): string {
  const { currency, displayFont } = d
  const m = (v: number | null) => money(v, currency)
  const isCall = d.kind === 'capital_call'

  const contextRows = (d.context ?? []).map(c => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(c.label)}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(c.value)}</td>
    </tr>`).join('')

  // The one number the reader is looking for, set apart from the context rather than buried
  // in a table with it.
  const headline = `
    <div style="margin:22px 0;padding:16px 18px;border:1px solid #e5e5e5;background:#fafafa;">
      <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">
        ${isCall ? 'Amount due from you' : 'Amount payable to you'}
      </p>
      <p style="font-family:${PDF_DISPLAY};font-size:28px;font-weight:400;letter-spacing:-0.01em;margin-top:4px;font-variant-numeric:tabular-nums;">${m(d.amount)}</p>
      ${isCall && d.dueDate ? `<p style="font-size:12px;color:#111;margin-top:6px;">Due <strong>${esc(d.dueDate)}</strong></p>` : ''}
    </div>`

  const wireSection = isCall && d.wireInstructions ? `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Payment instructions</h3>
    <div style="border:1px solid #e5e5e5;padding:12px 14px;font-size:11px;white-space:pre-line;line-height:1.5;">${esc(d.wireInstructions)}</div>` : ''

  // A call without wire instructions is a demand with nowhere to send the money. Say so on
  // the document rather than letting it go out looking complete.
  const wireMissing = isCall && !d.wireInstructions ? `
    <p style="font-size:11px;color:#555;margin-top:18px;font-style:italic;">
      Payment instructions will be provided separately.
    </p>` : ''

  // What the whole call is for. Fund-wide figures, labelled as such; the partner's own figure is
  // the headline above.
  const purposeRows = isCall && d.purposes && d.purposes.length > 0 ? d.purposes.map(p => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(p.label)}${p.basis ? `<div style="color:#888;font-size:10px;">${esc(p.basis)}</div>` : ''}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(p.amount)}</td>
    </tr>`).join('') : ''
  const purposeTotal = (d.purposes ?? []).reduce((s, p) => s + p.amount, 0)
  const purposeSection = purposeRows ? `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Purpose of this call (whole fund)</h3>
    <table><tbody>${purposeRows}
      <tr><td style="padding:5px 8px;border-top:2px solid #ccc;font-weight:600;">Total call</td><td style="padding:5px 8px;border-top:2px solid #ccc;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${m(purposeTotal)}</td></tr>
    </tbody></table>
    ${d.share != null ? `<p style="font-size:11px;color:#555;margin-top:6px;">Your share is ${(d.share * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}% of the fund's total commitments.</p>` : ''}` : ''

  // What the amount is made of, each part its own figure. On the GP's notice: the distribution on
  // its capital investment and the carried interest, never one number standing for both.
  const comps = !isCall ? (d.components ?? []).filter(c => Number.isFinite(c.amount)) : []
  const componentRows = comps.map(c => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;font-weight:600;">${esc(c.label)}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${m(c.amount)}</td>
    </tr>${(c.detail ?? []).map(x => `
    <tr>
      <td style="padding:3px 8px 3px 22px;color:#555;">${esc(x.label)}</td>
      <td style="padding:3px 8px;text-align:right;color:#555;font-variant-numeric:tabular-nums;">${m(x.value)}</td>
    </tr>`).join('')}`).join('')
  const componentSection = componentRows ? `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">What this distribution is made of</h3>
    <table><tbody>${componentRows}
      <tr><td style="padding:5px 8px;border-top:2px solid #ccc;font-weight:600;">Total payable to you</td><td style="padding:5px 8px;border-top:2px solid #ccc;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${m(Math.round(comps.reduce((s, c) => s + c.amount, 0) * 100) / 100)}</td></tr>
    </tbody></table>` : ''

  const draftBanner = d.draft ? `
    <div style="margin-bottom:18px;padding:8px 12px;border:1px solid #111;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">
      Draft for review. Not a demand for payment.
    </div>` : ''

  const contextSection = contextRows ? `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">${isCall ? 'Your commitment' : 'Your capital account'}</h3>
    <table><tbody>${contextRows}</tbody></table>` : ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; }
</style></head><body>
  <div style="padding-bottom:40px;">
    ${draftBanner}
    <!-- Fund header — identical to the capital account statement and LP letter -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">
        ${d.fundLogo ? `<img src="${d.fundLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}
      </div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fundName)}</h2>
        ${d.fundAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fundAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">${TITLE[d.kind]}${d.number ? ` No. ${d.number}` : ''}</h1>
    <p style="font-size:14px;font-weight:600;color:#111;">${esc(d.partnerName)}</p>
    <p style="font-size:11px;color:#888;">${esc(d.vehicle)} &middot; ${esc(d.noticeDate)}</p>

    ${d.description ? `<p style="font-size:12px;color:#333;margin-top:18px;">${esc(d.description)}</p>` : ''}

    ${headline}
    ${componentSection}
    ${purposeSection}
    ${contextSection}
    ${wireSection}
    ${wireMissing}
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    ${d.draft ? 'DRAFT. ' : ''}${isCall ? 'Capital call notice' : 'Distribution notice'} for ${esc(d.partnerName)} in ${esc(d.vehicle)}, dated ${esc(d.noticeDate)}.
    Figures are stated in ${esc(currency)} and are those recorded in the fund's books at the date of this notice.
    ${isCall ? 'Please reference your name and the vehicle when remitting funds.' : ''}
  </div>
</body></html>`
}

/** One partner's notice, rendered to a PDF. The CALLER is responsible for authorization. */
export async function generateNoticePdf(d: NoticeData): Promise<Buffer> {
  return renderHtmlToPdf(buildNoticeHtml(d))
}

export interface ReceiptData {
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  currency: string
  vehicle: string
  partnerName: string
  /** What arrived — the settled amount on the line, from the ledger. */
  amountReceived: number
  /** When it arrived — the date of the funding entry. */
  receivedOn: string
  /** The call this funds: its date, number and the partner's line on it. */
  call: { date: string; number: number | null; description: string | null; amount: number; outstanding: number }
  /** The partner's standing position after this funding. */
  context?: { label: string; value: number | null }[]
}

/**
 * A receipt for a capital contribution, as HTML. Pure.
 *
 * The mirror of the call notice: the notice said "send this much by this date", the receipt says
 * "this much arrived on this date, against that call". Both figures come from records that do not
 * move — the register line and the funding entry — so a reissued receipt says the same thing.
 */
export function buildReceiptHtml(d: ReceiptData): string {
  const { currency, displayFont } = d
  const m = (v: number | null) => money(v, currency)
  const callTitle = `Capital Call${d.call.number ? ` No. ${d.call.number}` : ''} dated ${d.call.date}`

  const callRows = `
    <tr><td style="padding:5px 8px;border-top:1px solid #e5e5e5;">Called on this notice</td><td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(d.call.amount)}</td></tr>
    <tr><td style="padding:5px 8px;border-top:1px solid #e5e5e5;">Received</td><td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(d.amountReceived)}</td></tr>
    <tr><td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${d.call.outstanding > 0.005 ? 'Still outstanding on this notice' : 'Outstanding on this notice'}</td><td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(d.call.outstanding)}</td></tr>`
  const contextRows = (d.context ?? []).map(c => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(c.label)}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(c.value)}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
</style></head><body>
  <div style="padding-bottom:40px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">
        ${d.fundLogo ? `<img src="${d.fundLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}
      </div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fundName)}</h2>
        ${d.fundAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fundAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">Receipt of Capital Contribution</h1>
    <p style="font-size:14px;font-weight:600;color:#111;">${esc(d.partnerName)}</p>
    <p style="font-size:11px;color:#888;">${esc(d.vehicle)} &middot; ${esc(callTitle)}</p>
    ${d.call.description ? `<p style="font-size:12px;color:#333;margin-top:18px;">${esc(d.call.description)}</p>` : ''}

    <div style="margin:22px 0;padding:16px 18px;border:1px solid #e5e5e5;background:#fafafa;">
      <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Amount received</p>
      <p style="font-family:${PDF_DISPLAY};font-size:28px;font-weight:400;letter-spacing:-0.01em;margin-top:4px;font-variant-numeric:tabular-nums;">${m(d.amountReceived)}</p>
      <p style="font-size:12px;color:#111;margin-top:6px;">Received <strong>${esc(d.receivedOn)}</strong></p>
    </div>

    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">This notice</h3>
    <table><tbody>${callRows}</tbody></table>
    ${contextRows ? `<h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Your commitment</h3><table><tbody>${contextRows}</tbody></table>` : ''}
    <p style="font-size:11px;color:#555;margin-top:24px;">Thank you. This receipt confirms the fund has recorded your contribution.</p>
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    Receipt for ${esc(d.partnerName)} in ${esc(d.vehicle)}, ${esc(callTitle)}. Figures are stated in ${esc(currency)} and are those recorded in the fund's books.
  </div>
</body></html>`
}

export async function generateReceiptPdf(d: ReceiptData): Promise<Buffer> {
  return renderHtmlToPdf(buildReceiptHtml(d))
}
