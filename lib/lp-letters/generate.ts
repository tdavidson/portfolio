import type { PortfolioPreview } from './aggregate'
import { getCurrencySymbol } from '@/lib/currency'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function fmt(value: number, currency: string): string {
  const sym = getCurrencySymbol(currency)
  if (Math.abs(value) >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${sym}${(value / 1_000).toFixed(0)}K`
  return `${sym}${value.toLocaleString()}`
}

/**
 * Build the portfolio summary table (pure computation — no AI needed).
 */
export function buildPortfolioTableHtml(
  preview: PortfolioPreview
): string {
  const { fundCurrency, companies, totals } = preview
  const rows = companies.map(c => {
    const inv = c.investment
    return `<tr>
      <td>${esc(inv.companyName)}</td>
      <td style="text-transform:capitalize">${esc(inv.status)}</td>
      <td>${esc(inv.stage ?? '—')}</td>
      <td style="text-align:right">${fmt(inv.totalInvested, fundCurrency)}</td>
      <td style="text-align:right">${fmt(inv.fmv, fundCurrency)}</td>
      <td style="text-align:right">${inv.moic ? `${inv.moic.toFixed(2)}x` : '—'}</td>
    </tr>`
  })

  return `<table>
  <thead>
    <tr>
      <th>Company</th><th>Status</th><th>Stage</th>
      <th style="text-align:right">Invested</th>
      <th style="text-align:right">Gross FMV</th>
      <th style="text-align:right">Gross MOIC</th>
    </tr>
  </thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="3"><strong>Total</strong></td>
      <td style="text-align:right"><strong>${fmt(totals.totalInvested, fundCurrency)}</strong></td>
      <td style="text-align:right"><strong>${fmt(totals.totalFmv, fundCurrency)}</strong></td>
      <td style="text-align:right"><strong>${totals.portfolioMoic ? `${totals.portfolioMoic.toFixed(2)}x` : '—'}</strong></td>
    </tr>
  </tfoot>
</table>`
}
