// The financial statements as a PDF — the set a preparer files, rendered from the SAME computed
// package as the screen and the workbook (lib/accounting/statement-package.ts), so the three can
// never disagree. Pure HTML builder; the route renders it through renderHtmlToPdf.
//
// One statement per page, ASC 946 order: assets and liabilities, operations, cash flows,
// changes in partners' capital, schedule of investments. Comparison periods become columns.

import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { getCurrencySymbol } from '@/lib/currency'
import type { StatementPackage, StatementPayload } from './statement-package'
import { ACTIVITY_FIELDS, CAPITAL_ACCOUNT_LABELS, type CapitalAccount } from './capital-account'

export interface StatementsPdfMeta {
  fundName: string
  vehicle: string
  currency: string
  displayFont?: string | null
  /** ISO timestamp, printed in the footer. */
  generatedAt: string
  /** Optional line under the title — "Tax basis", say. */
  basisNote?: string | null
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Accounting convention: negatives in parentheses, a dash for exactly zero. */
function money(v: number | undefined, currency: string): string {
  if (v === undefined) return ''
  if (Math.abs(v) < 0.005) return '—'
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`

const TD = 'padding:5px 8px;border-top:1px solid #e5e5e5;'
const NUM = `${TD}text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;`

interface Section { label: string; rows: { code: string; name: string; amount: number }[]; total: number }

export function buildStatementsHtml(pkg: StatementPackage, meta: StatementsPdfMeta): string {
  const { currency } = meta
  const m = (v: number | undefined) => money(v, currency)
  const payloads: StatementPayload[] = [pkg.payload, ...(pkg.comparisons ?? [])]
  const primary = pkg.payload

  const periodHead = (kind: 'asOf' | 'over') => `
    <tr>
      <th></th>
      ${payloads.map(p => `<th style="text-align:right;width:130px;">${esc(p.period.label)}<div style="font-weight:400;color:#888;font-size:9px;">${
        kind === 'asOf' ? (p.period.end ? `as of ${esc(p.period.end)}` : 'as of today') : (p.period.preset === 'itd' ? 'since inception' : esc(p.period.label))
      }</div></th>`).join('')}
    </tr>`

  // Union a section's rows by code across the columns — a line present in one period only
  // still prints, blank elsewhere — then one total line.
  const section = (pick: (p: StatementPayload) => Section, opts: { hideEmpty?: boolean } = {}): string => {
    const label = pick(primary).label
    const keys: { key: string; code: string; name: string }[] = []
    const seen = new Set<string>()
    for (const p of payloads) for (const r of pick(p).rows) {
      const key = r.code || r.name
      if (!seen.has(key)) { seen.add(key); keys.push({ key, code: r.code, name: r.name }) }
    }
    if (opts.hideEmpty && keys.length === 0 && payloads.every(p => pick(p).total === 0)) return ''
    const amount = (p: StatementPayload, key: string) => pick(p).rows.find(r => (r.code || r.name) === key)?.amount
    return `
      ${keys.length > 0 ? `<tr><td colspan="${payloads.length + 1}" style="${TD}font-weight:600;background:#fafafa;">${esc(label)}</td></tr>` : ''}
      ${keys.map(k => `<tr>
        <td style="${TD}padding-left:18px;">${k.code ? `<span style="color:#888;font-variant-numeric:tabular-nums;">${esc(k.code)}</span> ` : ''}${esc(k.name)}</td>
        ${payloads.map(p => `<td style="${NUM}">${m(amount(p, k.key))}</td>`).join('')}
      </tr>`).join('')}
      <tr style="font-weight:600;">
        <td style="${TD}">Total ${esc(label)}</td>
        ${payloads.map(p => `<td style="${NUM}">${m(pick(p).total)}</td>`).join('')}
      </tr>`
  }

  const totalRow = (label: string, get: (p: StatementPayload) => number | undefined, strong = true) => `
    <tr style="${strong ? 'font-weight:600;background:#fafafa;' : ''}">
      <td style="${TD}">${esc(label)}</td>
      ${payloads.map(p => `<td style="${NUM}">${m(get(p))}</td>`).join('')}
    </tr>`

  const statement = (title: string, sub: string, body: string, first = false) => `
    <section style="${first ? '' : 'page-break-before:always;'}">
      <h2 style="font-family:${PDF_DISPLAY};font-size:16px;font-weight:400;margin:0 0 2px;">${esc(title)}</h2>
      <p style="font-size:10px;color:#888;margin:0 0 12px;">${esc(sub)}</p>
      ${body}
    </section>`

  const asOfLabel = primary.period.end ? `as of ${primary.period.end}` : 'as of today'
  const overLabel = primary.period.preset === 'itd' ? 'since inception' : `for ${primary.period.label}`

  // The equity's name, as the payload carries it — partners', members' or owner's.
  const equityLabel = primary.balanceSheet.equity.label || 'Partners’ capital'
  const equityWord = equityLabel.toLowerCase()

  // 1. Balance sheet
  const balanceSheet = statement(
    `Statement of assets, liabilities and ${equityWord}`, asOfLabel,
    `<table><thead>${periodHead('asOf')}</thead><tbody>
      ${section(p => p.balanceSheet.assets)}
      ${section(p => p.balanceSheet.liabilities, { hideEmpty: true })}
      ${payloads.some(p => p.balanceSheet.equity.rows.length > 0)
        // Books that keep retained earnings list equity account by account, with net income apart.
        ? section(p => p.balanceSheet.equity)
        : totalRow(equityLabel, p => p.balanceSheet.equity.total)}
    </tbody></table>
    ${primary.balanceSheet.partnersCapital.unallocatedEarnings !== 0
      ? `<p style="font-size:10px;color:#a2600e;margin-top:8px;">${m(primary.balanceSheet.partnersCapital.unallocatedEarnings)} of net income is not yet allocated to partners; the period has not been closed.</p>` : ''}
    ${primary.balanceSheet.check !== 0 ? `<p style="font-size:10px;color:#b3342b;margin-top:8px;">Does not balance — residual ${m(primary.balanceSheet.check)}.</p>` : ''}`,
    true,
  )

  // 2. Operations
  const operations = statement(
    'Statement of operations', overLabel,
    `<table><thead>${periodHead('over')}</thead><tbody>
      ${section(p => p.incomeStatement.income)}
      ${section(p => p.incomeStatement.expenses)}
      ${totalRow('Net income', p => p.incomeStatement.netIncome)}
    </tbody></table>`,
  )

  // 3. Cash flows
  const cfSection = (which: 'operating' | 'financing') => (p: StatementPayload): Section => {
    const cf = p.cashFlows
    if (!cf) return { label: which === 'operating' ? 'Operating activities' : 'Financing activities', rows: [], total: 0 }
    const s = cf[which]
    return { label: s.label, rows: s.lines.map(l => ({ code: l.code, name: l.name, amount: l.amount })), total: s.total }
  }
  const nonCash = primary.cashFlows?.nonCash ?? []
  const cashFlows = !primary.cashFlows ? '' : statement(
    'Statement of cash flows', overLabel,
    `<table><thead>${periodHead('over')}</thead><tbody>
      ${section(cfSection('operating'))}
      ${section(cfSection('financing'))}
      ${totalRow('Net change in cash', p => p.cashFlows?.netChange)}
      ${totalRow('Opening cash', p => p.cashFlows?.openingCash, false)}
      ${totalRow('Ending cash', p => p.cashFlows?.endingCash, false)}
    </tbody></table>
    ${nonCash.length === 0 ? '' : `
      <h3 style="font-size:11px;font-weight:600;margin:18px 0 4px;">Supplemental — non-cash investing and financing activities</h3>
      <table><tbody>${nonCash.map(n => `<tr>
        <td style="${TD}"><span style="color:#888;font-variant-numeric:tabular-nums;">${esc(n.date ?? '')}</span> ${esc(n.description)}</td>
        <td style="${NUM}">${m(n.amount)}</td>
      </tr>`).join('')}</tbody></table>`}`,
  )

  // 4. Changes in partners' capital — the roll-forward for one period, an ending matrix for several.
  const cap = primary.changesInPartnersCapital
  const holderWord = equityLabel === "Members' capital" ? 'Member' : 'Partner'
  const capFields: (keyof CapitalAccount)[] = ['beginning', ...ACTIVITY_FIELDS.filter(f =>
    cap.partners.some(p => Math.abs(p[f] as number) > 0.004) || Math.abs(cap.totals[f] as number) > 0.004), 'ending']
  // An owner's-equity vehicle has no partners to roll forward; the statement is left out.
  const capital = cap.partners.length === 0 && equityLabel !== "Partners' capital" ? '' : statement(
    `Statement of changes in ${equityWord}`, `${overLabel} — beginning capital is the balance carried into the period`,
    payloads.length === 1
      ? `<table><thead><tr><th>${holderWord}</th>${capFields.map(f => `<th style="text-align:right;">${esc(CAPITAL_ACCOUNT_LABELS[f] ?? String(f))}</th>`).join('')}</tr></thead>
        <tbody>
          ${cap.partners.map(p => `<tr><td style="${TD}">${esc(p.name)}</td>${capFields.map(f => `<td style="${NUM}${f === 'ending' ? 'font-weight:600;' : ''}">${m(p[f] as number)}</td>`).join('')}</tr>`).join('')}
          <tr style="font-weight:600;background:#fafafa;"><td style="${TD}">Total</td>${capFields.map(f => `<td style="${NUM}">${m(cap.totals[f] as number)}</td>`).join('')}</tr>
        </tbody></table>`
      : (() => {
          const rows: { id: string; name: string }[] = []
          const seen = new Set<string>()
          for (const p of payloads) for (const partner of p.changesInPartnersCapital.partners) {
            if (!seen.has(partner.id)) { seen.add(partner.id); rows.push({ id: partner.id, name: partner.name }) }
          }
          return `<table><thead><tr><th>${holderWord}</th>${payloads.map(p => `<th style="text-align:right;">${esc(p.period.label)}<div style="font-weight:400;color:#888;font-size:9px;">ending capital</div></th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map(r => `<tr><td style="${TD}">${esc(r.name)}</td>${payloads.map(p => `<td style="${NUM}">${m(p.changesInPartnersCapital.partners.find(x => x.id === r.id)?.ending)}</td>`).join('')}</tr>`).join('')}
              <tr style="font-weight:600;background:#fafafa;"><td style="${TD}">Total</td>${payloads.map(p => `<td style="${NUM}">${m(p.changesInPartnersCapital.totals.ending)}</td>`).join('')}</tr>
            </tbody></table>`
        })(),
  )

  // 5. Schedule of investments — the primary period's.
  const soi = primary.scheduleOfInvestments
  const schedule = soi.rows.length === 0 ? '' : statement(
    'Schedule of investments', asOfLabel,
    `<table><thead><tr><th>Investment</th><th>Industry</th><th style="text-align:right;">Cost</th><th style="text-align:right;">Fair value</th><th style="text-align:right;">% of net assets</th></tr></thead>
    <tbody>
      ${soi.rows.map(r => `<tr>
        <td style="${TD}">${esc(r.name)}</td><td style="${TD}color:#888;">${esc(r.industry ?? '')}</td>
        <td style="${NUM}">${m(r.cost)}</td><td style="${NUM}">${m(r.fairValue)}</td><td style="${NUM}">${pct(r.pctOfNetAssets)}</td>
      </tr>`).join('')}
      <tr style="font-weight:600;background:#fafafa;"><td style="${TD}">Total investments</td><td style="${TD}"></td>
        <td style="${NUM}">${m(soi.totalCost)}</td><td style="${NUM}">${m(soi.totalFairValue)}</td><td style="${NUM}">${pct(soi.netAssets ? soi.totalFairValue / soi.netAssets : 0)}</td></tr>
      <tr><td style="${TD}">Net assets</td><td style="${TD}"></td><td style="${TD}"></td><td style="${NUM}">${m(soi.netAssets)}</td><td style="${TD}"></td></tr>
    </tbody></table>`,
  )

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(meta.displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:11px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:10.5px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; vertical-align:bottom; }
  section { padding-bottom: 28px; }
</style></head><body>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:22px;border-bottom:1px solid #e5e5e5;padding-bottom:10px;">
    <div>
      <h1 style="font-family:${PDF_DISPLAY};font-size:20px;font-weight:400;letter-spacing:-0.01em;">${esc(meta.fundName)}</h1>
      <p style="font-size:11px;color:#555;">${esc(meta.vehicle)} · Financial statements · ${esc(primary.period.label)}${meta.basisNote ? ` · ${esc(meta.basisNote)}` : ''}</p>
    </div>
    <p style="font-size:9px;color:#888;text-align:right;">Stated in ${esc(currency)}<br/>Prepared from the books of account</p>
  </div>
  ${balanceSheet}
  ${operations}
  ${cashFlows}
  ${capital}
  ${schedule}
  <div style="position:fixed;bottom:0;left:0;right:0;padding:6px 0;border-top:1px solid #e5e5e5;background:white;font-size:8.5px;color:#888;">
    ${esc(meta.fundName)} · ${esc(meta.vehicle)} · generated ${esc(meta.generatedAt.slice(0, 10))}. Balance sheet and schedule of investments are cumulative to the period end; operations, cash flows and changes in capital cover the period.
  </div>
</body></html>`
}
