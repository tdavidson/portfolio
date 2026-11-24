// A management fee invoice → PDF: the manager bills the fund for one period's fee.
//
// One invoice per fee payment, numbered and kept on the period (lib/accounting/fee-periods.ts). The
// layout is the partnership-expense invoice's family (logo left, the biller's name and address
// right), rendered through the shared HTML → headless-Chrome pipeline.

import type { SupabaseClient } from '@supabase/supabase-js'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { getCurrencySymbol } from '@/lib/currency'
import { FEE_LINE_KIND_LABELS, addDays, listFeePeriods, type FeeLineKind } from './fee-periods'

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function money(v: number, currency: string): string {
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

const pct = (r: number) => `${(r * 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
const BASIS_LABEL: Record<string, string> = { commitments: 'capital commitments', invested: 'invested capital', nav: 'net asset value', other: 'the stated basis' }

export interface FeeInvoicePdfData {
  displayFont?: string | null
  fromName: string
  fromLogo: string | null
  fromAddress: string | null
  toName: string
  toAddress: string | null
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  periodStart: string
  /** Inclusive: the period's last day. */
  periodEnd: string
  currency: string
  rate: number
  basis: string
  basisAmount: number
  gross: number
  offset: number
  /** The partners' fee lines added up. */
  fee: number
  /** Catch-ups, equalization fees and adjustments, each with the partner it is for. */
  extras: { kind: FeeLineKind; partner: string; note: string | null; amount: number }[]
  total: number
  note: string | null
  draft: boolean
}

/** The invoice page, as HTML. Pure, so the layout is testable without a browser. */
export function buildFeeInvoiceHtml(d: FeeInvoicePdfData): string {
  const m = (v: number) => money(v, d.currency)
  const cell = 'padding:5px 8px;border-top:1px solid #e5e5e5;'
  const num = `${cell}text-align:right;font-variant-numeric:tabular-nums;`
  const rows: string[] = []
  rows.push(`<tr><td style="${cell}">Management fee at ${esc(pct(d.rate))} a year on ${esc(BASIS_LABEL[d.basis] ?? d.basis)} of ${esc(m(d.basisAmount))}, ${esc(d.periodStart)} to ${esc(d.periodEnd)}</td><td style="${num}">${m(d.offset > 0 ? d.gross : d.fee)}</td></tr>`)
  if (d.offset > 0) rows.push(`<tr><td style="${cell}">Less fee offsets</td><td style="${num}">${m(-d.offset)}</td></tr>`)
  for (const x of d.extras) {
    rows.push(`<tr><td style="${cell}">${esc(FEE_LINE_KIND_LABELS[x.kind])}: ${esc(x.partner)}${x.note ? `<div style="color:#555;">${esc(x.note)}</div>` : ''}</td><td style="${num}">${m(x.amount)}</td></tr>`)
  }
  rows.push(`<tr><td style="padding:6px 8px;border-top:2px solid #ccc;font-weight:600;">Amount due</td><td style="padding:6px 8px;border-top:2px solid #ccc;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${m(d.total)}</td></tr>`)

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(d.displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; }
</style></head><body>
  <div style="padding-bottom:40px;">
    ${d.draft ? `<div style="margin-bottom:18px;padding:8px 12px;border:1px solid #111;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Draft for review. Not yet issued.</div>` : ''}
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">${d.fromLogo ? `<img src="${d.fromLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}</div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fromName)}</h2>
        ${d.fromAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fromAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">Invoice ${esc(d.invoiceNumber)}</h1>
    <p style="font-size:11px;color:#888;">Management fee, ${esc(d.periodStart)} to ${esc(d.periodEnd)} &middot; dated ${esc(d.invoiceDate)} &middot; due ${esc(d.dueDate)}</p>

    <div style="display:flex;gap:32px;margin-top:22px;">
      <div style="flex:1;">
        <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Bill to</p>
        <p style="font-size:14px;font-weight:600;margin-top:2px;">${esc(d.toName)}</p>
        ${d.toAddress ? `<p style="font-size:11px;color:#555;white-space:pre-line;">${esc(d.toAddress)}</p>` : ''}
      </div>
      <div style="padding:14px 18px;border:1px solid #e5e5e5;background:#fafafa;min-width:200px;">
        <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Amount due</p>
        <p style="font-family:${PDF_DISPLAY};font-size:26px;font-weight:400;margin-top:4px;font-variant-numeric:tabular-nums;">${m(d.total)}</p>
      </div>
    </div>

    ${d.note ? `<p style="font-size:12px;color:#333;margin-top:18px;">${esc(d.note)}</p>` : ''}

    <h3 style="font-size:12px;font-weight:600;margin:20px 0 6px;">Charges</h3>
    <table>
      <thead><tr><th>Description</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    ${d.draft ? 'DRAFT. ' : ''}Invoice ${esc(d.invoiceNumber)} from ${esc(d.fromName)} to ${esc(d.toName)}, under the management fee terms of ${esc(d.toName)}'s partnership agreement. Figures are stated in ${esc(d.currency)}.
  </div>
</body></html>`
}

/**
 * The invoice for one fee period, rendered. The CALLER has already checked the caller may see the
 * vehicle. Null when the period has no live invoice.
 */
export async function feeInvoiceDocument(
  admin: SupabaseClient, fundId: string, group: string, periodId: string,
): Promise<{ body: Buffer; fileName: string; contentType: string } | null> {
  const view = await listFeePeriods(admin, fundId, group)
  if ('error' in view) return null
  const p = view.periods.find(x => x.id === periodId)
  if (!p || !p.invoice || p.invoice.status === 'void') return null
  const { documentLetterhead, contactBlock, vehicleLetterheadDetail } = await import('@/lib/vehicle-letterhead')
  const { displayFontOf } = await import('@/lib/theme')
  const [fundRes, settingsRes, billed] = await Promise.all([
    (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('theme, currency').eq('fund_id', fundId).maybeSingle(),
    vehicleLetterheadDetail(admin, fundId, group).catch(() => null),
  ])
  const from = await documentLetterhead(admin, fundId, fundRes.data, view.manager ? [view.manager.name] : [])
  const fee = p.lines.filter(l => l.kind === 'fee').reduce((s, l) => s + l.amount, 0)
  const html = buildFeeInvoiceHtml({
    displayFont: displayFontOf(settingsRes.data?.theme),
    fromName: view.manager?.name ?? (from.name || 'The General Partner'),
    fromLogo: from.logo,
    fromAddress: contactBlock(from),
    toName: billed?.vehicle.name || group,
    toAddress: billed?.vehicle.address ?? null,
    invoiceNumber: p.invoice.number,
    invoiceDate: p.invoice.date,
    dueDate: p.dueDate,
    periodStart: p.start,
    periodEnd: addDays(p.end, -1),
    currency: settingsRes.data?.currency || 'USD',
    rate: p.rate, basis: p.basis, basisAmount: p.basisAmount, gross: p.gross, offset: p.offset,
    fee: Math.round(fee * 100) / 100,
    extras: p.lines.filter(l => l.kind !== 'fee').map(l => ({ kind: l.kind, partner: view.names[l.lpEntityId] ?? 'Partner', note: l.note, amount: l.amount })),
    total: p.invoice.status === 'issued' ? p.invoice.amount : p.total,
    note: p.note,
    draft: p.invoice.status === 'draft',
  })
  const body = await renderHtmlToPdf(html)
  return { body, fileName: `${p.invoice.number}.pdf`, contentType: 'application/pdf' }
}
