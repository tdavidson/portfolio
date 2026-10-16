// A partnership-expense invoice → PDF: the invoice page, then every receipt behind it as backup.
//
// Same letterhead family as the call notice (logo left, name and address right), rendered through
// the shared HTML → headless-Chrome pipeline. The receipts are appended with pdf-lib rather than
// rendered: a receipt is a document someone else issued, and the fund's auditor wants the vendor's
// page, not our re-typing of it.

import { PDFDocument } from 'pdf-lib'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { getCurrencySymbol } from '@/lib/currency'

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

export interface PartnershipInvoicePdfData {
  displayFont?: string | null
  /** The biller's letterhead. */
  fromName: string
  fromLogo: string | null
  fromAddress: string | null
  /** Who is billed. */
  toName: string
  toAddress: string | null
  invoiceNumber: string
  invoiceDate: string
  periodLabel: string
  periodStart: string
  periodEnd: string
  currency: string
  amount: number
  memo: string | null
  draft: boolean
  lines: { date: string; vendor: string | null; description: string | null; reference: string | null; amount: number; receipts: number }[]
}

/** The invoice page, as HTML. Pure, so the layout is testable without a browser. */
export function buildPartnershipInvoiceHtml(d: PartnershipInvoicePdfData): string {
  const m = (v: number) => money(v, d.currency)
  const rows = d.lines.map((l, i) => `
    <tr>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;color:#888;font-variant-numeric:tabular-nums;">${i + 1}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;font-variant-numeric:tabular-nums;white-space:nowrap;">${esc(l.date)}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(l.vendor ?? '')}${l.description ? `<div style="color:#555;">${esc(l.description)}</div>` : ''}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;color:#555;">${esc(l.reference ?? '')}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:center;color:#555;">${l.receipts > 0 ? 'Yes' : '—'}</td>
      <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(l.amount)}</td>
    </tr>`).join('')

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
    <p style="font-size:11px;color:#888;">Partnership expenses, ${esc(d.periodLabel)} (${esc(d.periodStart)} to ${esc(d.periodEnd)}) &middot; dated ${esc(d.invoiceDate)}</p>

    <div style="display:flex;gap:32px;margin-top:22px;">
      <div style="flex:1;">
        <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Bill to</p>
        <p style="font-size:14px;font-weight:600;margin-top:2px;">${esc(d.toName)}</p>
        ${d.toAddress ? `<p style="font-size:11px;color:#555;white-space:pre-line;">${esc(d.toAddress)}</p>` : ''}
      </div>
      <div style="padding:14px 18px;border:1px solid #e5e5e5;background:#fafafa;min-width:200px;">
        <p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Amount due</p>
        <p style="font-family:${PDF_DISPLAY};font-size:26px;font-weight:400;margin-top:4px;font-variant-numeric:tabular-nums;">${m(d.amount)}</p>
      </div>
    </div>

    ${d.memo ? `<p style="font-size:12px;color:#333;margin-top:18px;">${esc(d.memo)}</p>` : ''}

    <p style="font-size:12px;color:#333;margin-top:18px;">
      Reimbursement of expenses of ${esc(d.toName)} paid on its behalf by ${esc(d.fromName)} during the period.
      Receipts follow this page in the order listed.
    </p>

    <h3 style="font-size:12px;font-weight:600;margin:20px 0 6px;">Expenses</h3>
    <table>
      <thead><tr><th style="width:24px;">#</th><th>Date</th><th>Vendor and description</th><th>Reference</th><th style="text-align:center;">Receipt</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${rows}
        <tr><td colspan="5" style="padding:6px 8px;border-top:2px solid #ccc;font-weight:600;">Total</td>
            <td style="padding:6px 8px;border-top:2px solid #ccc;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${m(d.amount)}</td></tr>
      </tbody>
    </table>
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    ${d.draft ? 'DRAFT. ' : ''}Invoice ${esc(d.invoiceNumber)} from ${esc(d.fromName)} to ${esc(d.toName)}. Figures are stated in ${esc(d.currency)}
    and are those recorded in ${esc(d.fromName)}'s books.
  </div>
</body></html>`
}

export interface BackupDocument { fileName: string; contentType: string | null; content: Buffer }

/**
 * Append each receipt to the invoice: a PDF's pages as they are, an image on a page of its own
 * scaled to fit. Anything else (an HTML e-receipt) is skipped and listed in `skipped`, so the
 * caller can say the backup is incomplete rather than send it looking complete.
 */
export async function appendBackup(invoicePdf: Buffer, docs: BackupDocument[]): Promise<{ pdf: Buffer; skipped: string[] }> {
  const out = await PDFDocument.load(invoicePdf)
  const skipped: string[] = []
  for (const d of docs) {
    const t = (d.contentType ?? '').toLowerCase()
    try {
      if (t === 'application/pdf') {
        const src = await PDFDocument.load(d.content, { ignoreEncryption: true })
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach(p => out.addPage(p))
      } else if (t === 'image/png' || t === 'image/jpeg' || t === 'image/jpg') {
        const img = t === 'image/png' ? await out.embedPng(d.content) : await out.embedJpg(d.content)
        const page = out.addPage([612, 792]) // US Letter, points
        const margin = 36
        const scale = Math.min((612 - margin * 2) / img.width, (792 - margin * 2) / img.height, 1)
        const w = img.width * scale, h = img.height * scale
        page.drawImage(img, { x: (612 - w) / 2, y: 792 - margin - h, width: w, height: h })
      } else {
        skipped.push(d.fileName)
      }
    } catch {
      skipped.push(d.fileName)
    }
  }
  return { pdf: Buffer.from(await out.save()), skipped }
}

export async function generatePartnershipInvoicePdf(d: PartnershipInvoicePdfData, backup: BackupDocument[]): Promise<{ pdf: Buffer; skipped: string[] }> {
  const page = await renderHtmlToPdf(buildPartnershipInvoiceHtml(d))
  return appendBackup(page, backup)
}

/**
 * The invoice, loaded and rendered with its receipts, ready to download or send. The CALLER has
 * already checked the caller may see both entities.
 */
export async function partnershipInvoiceDocument(
  admin: import('@supabase/supabase-js').SupabaseClient,
  fundId: string,
  invoiceId: string,
): Promise<{ body: Buffer; fileName: string; skipped: string[] } | null> {
  const { getPartnershipInvoice } = await import('./partnership-invoices')
  const { receiptsForEntry, receiptFileBytes } = await import('./receipts')
  const { documentLetterhead, contactBlock, vehicleLetterheadDetail } = await import('@/lib/vehicle-letterhead')
  const { displayFontOf } = await import('@/lib/theme')

  const inv = await getPartnershipInvoice(admin, fundId, invoiceId)
  if (!inv) return null

  const [fundRes, settingsRes, billed] = await Promise.all([
    (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('theme').eq('fund_id', fundId).maybeSingle(),
    vehicleLetterheadDetail(admin, fundId, inv.to.name).catch(() => null),
  ])
  const from = await documentLetterhead(admin, fundId, fundRes.data, [inv.from.name])

  const backup: BackupDocument[] = []
  // One entry can carry two lines (a cost split between funds' Due-from accounts); its receipts are
  // appended once.
  for (const entryId of Array.from(new Set(inv.lines.map(l => l.entryId)))) {
    for (const r of await receiptsForEntry(admin, fundId, entryId)) {
      const content = await receiptFileBytes(admin, r)
      if (!content) continue
      // An e-receipt kept as the email's HTML or text: rendered here, where a browser ships, offline
      // and script-free because the HTML came from outside the fund.
      const t = (r.content_type ?? '').toLowerCase()
      if (t === 'text/html' || t === 'text/plain') {
        try {
          const html = t === 'text/html' ? content.toString('utf8') : `<pre style="font-family:sans-serif;white-space:pre-wrap;font-size:11px;">${esc(content.toString('utf8'))}</pre>`
          backup.push({ fileName: r.file_name, contentType: 'application/pdf', content: await renderHtmlToPdf(html, { offline: true }) })
        } catch {
          backup.push({ fileName: r.file_name, contentType: r.content_type, content })
        }
        continue
      }
      backup.push({ fileName: r.file_name, contentType: r.content_type, content })
    }
  }

  const { pdf, skipped } = await generatePartnershipInvoicePdf({
    displayFont: displayFontOf(settingsRes.data?.theme),
    // The biller's own name when its letterhead has none: an invoice from "the fund" to the fund
    // would be addressed to itself.
    fromName: from.name && from.name !== fundRes.data?.name ? from.name : inv.from.name,
    fromLogo: from.logo,
    fromAddress: contactBlock(from),
    toName: billed?.vehicle.name || inv.to.name,
    toAddress: billed?.vehicle.address ?? null,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    periodLabel: inv.label,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    currency: inv.currency,
    amount: inv.amount,
    memo: inv.memo,
    draft: inv.status === 'draft',
    lines: inv.lines.map(l => ({ date: l.entryDate, vendor: l.vendorName, description: l.memo, reference: l.reference, amount: l.amount, receipts: l.receiptCount })),
  }, backup)
  return { body: pdf, fileName: `${inv.invoiceNumber}.pdf`, skipped }
}
