import type { SupabaseClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import puppeteer from 'puppeteer-core'
import type { LiveCard } from '@/lib/lp-report-cards'
import { formatAsOf } from '@/lib/report-card-footer'
import { buildReportHtml, computeRow, computeTotals, getChromeConfig, runPool, type InvestmentRow } from '@/lib/lp-report-pdf'
import { contactBlock, fundLetterhead, loadFundEmail, loadVehicleLetterheads, pickLetterhead } from '@/lib/vehicle-letterhead'
import { displayFontOf } from '@/lib/theme'

// ---------------------------------------------------------------------------
// The live report cards (lib/lp-report-cards) as PDFs, one per investor, in a zip
// ---------------------------------------------------------------------------

/** A card's rows as the PDF template's investment rows. */
export function cardInvestmentRows(card: LiveCard): InvestmentRow[] {
  return card.rows.map((c, i) => {
    const r = c.row
    return {
      id: `${c.key}-${i}`,
      entity_id: r.entity_id,
      portfolio_group: r.portfolio_group,
      commitment: r.commitment, total_value: r.total_value, nav: r.nav,
      called_capital: r.called_capital, paid_in_capital: r.paid_in_capital,
      distributions: r.distributions, receivable: r.receivable, irr: r.irr,
      lookThroughVia: r.lookThroughVia ?? null,
      lp_entities: { id: r.entity_id, entity_name: c.entityName, investor_id: card.investorId, lp_investors: { id: card.investorId, name: card.investorName } },
    }
  })
}

/** "Name - Suffix.pdf", made filesystem-safe and unique within the zip. */
export function uniqueFileNames(names: string[], suffix: string): string[] {
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Report'
  const seen = new Map<string, number>()
  return names.map(n => {
    const base = `${n.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Investor'} - ${safeSuffix}`
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1
    seen.set(base.toLowerCase(), count)
    return count === 1 ? `${base}.pdf` : `${base} (${count}).pdf`
  })
}

/**
 * Render cards to one PDF each, in a zip. One browser, a pool of pages; the HTML is the same
 * template as the single card's PDF (buildReportHtml), with each card's own letterhead and date.
 * `excludedGroups` leaves those vehicles off every card and says so in its footnote.
 */
export async function renderReportCardsZip(
  admin: SupabaseClient,
  fundId: string,
  cards: LiveCard[],
  opts: { excludedGroups?: Set<string>; fileSuffix?: string; concurrency?: number } = {},
): Promise<{ zip: Buffer; count: number }> {
  const [{ data: fund }, { data: settings }, vehicleLetterheads, email] = await Promise.all([
    (admin as any).from('funds').select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('currency, lp_report_description, lp_report_footer, theme').eq('fund_id', fundId).maybeSingle(),
    loadVehicleLetterheads(admin, fundId),
    loadFundEmail(admin, fundId),
  ])
  const fundHead = { ...fundLetterhead(fund as any), email }
  const s = (settings ?? {}) as any
  const excluded = opts.excludedGroups ?? new Set<string>()

  const docs: { investorName: string; html: string }[] = []
  for (const card of cards) {
    const all = cardInvestmentRows(card)
    const excludedGroupNames = Array.from(new Set(all.filter(r => excluded.has(r.portfolio_group) && Number(r.commitment) > 0).map(r => r.portfolio_group)))
    const kept = all.filter(r => !excluded.has(r.portfolio_group))
    if (kept.length === 0) continue
    const rows = kept.map(computeRow)
    const letterhead = pickLetterhead(fundHead, kept.map(r => r.portfolio_group), vehicleLetterheads)
    docs.push({
      investorName: card.investorName,
      html: buildReportHtml({
        investorName: card.investorName, rows, totals: computeTotals(rows), excludedGroupNames,
        fundName: letterhead.name, fundLogo: letterhead.logo, fundAddress: contactBlock(letterhead),
        description: s.lp_report_description ?? null, footerNote: s.lp_report_footer ?? null,
        asOfFormatted: formatAsOf(card.asOf), currency: s.currency || 'USD',
        displayFont: displayFontOf(s.theme),
      }),
    })
  }
  const fileNames = uniqueFileNames(docs.map(d => d.investorName), opts.fileSuffix ?? 'LP Report')

  const zip = new JSZip()
  if (docs.length > 0) {
    const chrome = await getChromeConfig()
    const browser = await puppeteer.launch({ args: chrome.args, defaultViewport: { width: 1024, height: 1400 }, executablePath: chrome.executablePath, headless: true })
    try {
      await runPool(docs.map((d, i) => ({ ...d, fileName: fileNames[i] })), opts.concurrency ?? 8, async doc => {
        const page = await browser.newPage()
        try {
          // Static HTML: no script should ever run (as renderHtmlToPdf).
          await page.setJavaScriptEnabled(false)
          await page.setContent(doc.html, { waitUntil: 'load' })
          const pdf = await page.pdf({ format: 'letter', margin: { top: '0.5in', right: '0.6in', bottom: '0.5in', left: '0.6in' }, printBackground: true })
          zip.file(doc.fileName, pdf)
        } finally {
          await page.close()
        }
      })
    } finally {
      await browser.close()
    }
  }
  return { zip: await zip.generateAsync({ type: 'nodebuffer' }), count: docs.length }
}
