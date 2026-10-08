'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { soiRowHref } from '@/lib/portfolio/holding-href'
import { Loader2 } from 'lucide-react'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import type { PortfolioSheet, SheetRow } from '@/lib/portfolio/sheet'

/**
 * The portfolio sheet: every holding — companies (listed stocks among them), fund holdings and
 * digital assets — at cost and fair value, one section per kind.
 *
 * `group` set: that entity's sheet (`/funds/[id]/portfolio`). Omitted: the viewer's aggregate across
 * every entity they can see (`/dashboard`). The server decides which entities; this only renders.
 */
export function PortfolioSheetView({ group, exclude, sections = ['companies', 'funds', 'crypto'], hideWhenEmpty = false }: {
  group?: string
  /** Aggregate only: entity names to leave out (the dashboard's entity picker). */
  exclude?: string[]
  /** Render nothing (not an empty message) when these sections hold nothing — for a page that
   *  has its own content above. */
  hideWhenEmpty?: boolean
  /** Which sections to show — the dashboard keeps its own company table and shows the rest. */
  sections?: ('companies' | 'funds' | 'crypto')[]
}) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const [data, setData] = useState<{ vehicles: string[]; vehicleId?: string | null; sheet: PortfolioSheet } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Entity names can hold commas, so each is its own `exclude` parameter.
  const excludeKey = group ? '' : new URLSearchParams((exclude ?? []).map(e => ['exclude', e])).toString()
  useEffect(() => {
    const qs = group ? `?group=${encodeURIComponent(group)}` : excludeKey ? `?${excludeKey}` : ''
    fetch(`/api/portfolio/sheet${qs}`)
      .then(async r => (r.ok ? r.json() : Promise.reject((await r.json().catch(() => ({}))).error ?? 'Could not load the portfolio.')))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [group, excludeKey])

  if (error) return hideWhenEmpty ? null : <p className="text-sm text-destructive">{error}</p>
  if (!data) return hideWhenEmpty ? null : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading the portfolio…</div>

  const { sheet } = data
  const shown = sections.filter(s => sheet[s].length > 0)
  if (shown.length === 0) {
    if (hideWhenEmpty) return null
    return <p className="text-sm text-muted-foreground">No holdings yet{data.vehicles.length === 0 ? ' — you have not been given access to any entity.' : '.'}</p>
  }

  const multi = !group && data.vehicles.length > 1
  // Every kind of holding — company, fund holding, digital asset — lives on its own page; on one
  // entity's sheet, opened on that entity's view of it.
  const link = (r: SheetRow) => soiRowHref(r, group ? data.vehicleId : null)
  const name = (r: SheetRow) => {
    const href = link(r)
    return href ? <Link href={href} className="hover:underline underline-offset-2">{r.name}</Link> : r.name
  }
  const moic = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
  const th = 'px-3 py-2 font-medium'
  const td = 'px-3 py-2'
  const num = `${td} text-right tabular-nums`

  return (
    <div className="space-y-6">
      {sheet.quoteWarning && shown.includes('companies') && <p className="text-sm text-warning">{sheet.quoteWarning}</p>}
      {shown.includes('companies') && (
        <section className="space-y-2">
          <h2 className="text-base font-medium">Companies</h2>
          <div className="border rounded-card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className={th}>Company</th>
                  {multi && <th className={th}>Held by</th>}
                  <th className={th}>Stage</th>
                  <th className={`${th} text-right`}>Cost</th>
                  <th className={`${th} text-right`}>Fair value</th>
                  <th className={`${th} text-right`}>MOIC</th>
                  <th className={`${th} text-right`}>Cash</th>
                  <th className={th}>Last report</th>
                </tr>
              </thead>
              <tbody>
                {sheet.companies.map(r => (
                  <tr key={r.key} className="border-b last:border-b-0">
                    <td className={td}>
                      {name(r)}
                      {r.listed && (
                        <span className="ml-2 rounded border px-1 py-px text-[10px] text-muted-foreground" title={r.listed.asOf ? `Last quote ${r.listed.asOf}` : 'No quote yet'}>
                          {r.listed.symbol}{r.listed.price != null && <> · <span className="tabular-nums">{r.listed.price}</span></>}
                        </span>
                      )}
                    </td>
                    {multi && <td className={`${td} text-muted-foreground`}>{r.vehicles.join(', ')}</td>}
                    <td className={`${td} text-muted-foreground`}>{r.stage ?? '—'}</td>
                    <td className={num}>{fmt(r.cost)}</td>
                    <td className={num}>{fmt(r.fairValue)}</td>
                    <td className={num}>{moic(r.moic)}</td>
                    <td className={num}>{r.latestCash == null ? '—' : fmt(r.latestCash)}</td>
                    <td className={`${td} tabular-nums text-muted-foreground`}>{r.lastReportAt ? r.lastReportAt.slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className={td} colSpan={multi ? 3 : 2}>Total</td>
                  <td className={num}>{fmt(sheet.sectionTotals.companies.cost)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.companies.fairValue)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {shown.includes('funds') && (
        <section className="space-y-2">
          <h2 className="text-base font-medium">Funds</h2>
          <div className="border rounded-card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className={th}>Fund</th>
                  {multi && <th className={th}>Held by</th>}
                  <th className={`${th} text-right`}>Commitment</th>
                  <th className={`${th} text-right`}>Called</th>
                  <th className={`${th} text-right`}>Unfunded</th>
                  <th className={`${th} text-right`}>Cost</th>
                  <th className={`${th} text-right`}>NAV / fair value</th>
                  <th className={th}>NAV as of</th>
                  <th className={`${th} text-right`}>MOIC</th>
                </tr>
              </thead>
              <tbody>
                {sheet.funds.map(r => (
                  <tr key={r.key} className="border-b last:border-b-0">
                    <td className={td}>{name(r)}</td>
                    {multi && <td className={`${td} text-muted-foreground`}>{r.vehicles.join(', ')}</td>}
                    <td className={num}>{fmt(r.commitment)}</td>
                    <td className={num}>{fmt(r.called)}</td>
                    <td className={num}>{fmt(r.unfunded)}</td>
                    <td className={num}>{fmt(r.cost)}</td>
                    <td className={num}>{fmt(r.fairValue)}</td>
                    <td className={`${td} tabular-nums text-muted-foreground`}>{r.navAsOf ?? '—'}</td>
                    <td className={num}>{moic(r.moic)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className={td} colSpan={multi ? 2 : 1}>Total</td>
                  <td className={num}>{fmt(sheet.sectionTotals.funds.commitment)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.funds.called)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.funds.unfunded)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.funds.cost)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.funds.fairValue)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {shown.includes('crypto') && (
        <section className="space-y-2">
          <h2 className="text-base font-medium">Digital assets</h2>
          <div className="border rounded-card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className={th}>Asset</th>
                  {multi && <th className={th}>Held by</th>}
                  <th className={`${th} text-right`}>Units</th>
                  <th className={`${th} text-right`}>Price</th>
                  <th className={`${th} text-right`}>Cost</th>
                  <th className={`${th} text-right`}>Fair value</th>
                  <th className={`${th} text-right`}>MOIC</th>
                </tr>
              </thead>
              <tbody>
                {sheet.crypto.map(r => (
                  <tr key={r.key} className="border-b last:border-b-0">
                    <td className={td}>{name(r)}</td>
                    {multi && <td className={`${td} text-muted-foreground`}>{r.vehicles.join(', ')}</td>}
                    <td className={num}>{r.units == null ? '—' : r.units.toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
                    <td className={num}>{r.price == null ? '—' : fmt(r.price)}</td>
                    <td className={num}>{fmt(r.cost)}</td>
                    <td className={num}>{fmt(r.fairValue)}</td>
                    <td className={num}>{moic(r.moic)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className={td} colSpan={multi ? 4 : 3}>Total</td>
                  <td className={num}>{fmt(sheet.sectionTotals.crypto.cost)}</td>
                  <td className={num}>{fmt(sheet.sectionTotals.crypto.fairValue)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {shown.length > 1 && (
        <p className="text-sm text-muted-foreground">
          All holdings: cost <span className="tabular-nums text-foreground">{fmt(sheet.totals.cost)}</span>, fair value{' '}
          <span className="tabular-nums text-foreground">{fmt(sheet.totals.fairValue)}</span>.
        </p>
      )}
    </div>
  )
}
