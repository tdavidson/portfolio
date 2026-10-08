'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCurrency, formatCurrencyPrice, formatSharePrice } from '@/components/currency-context'
import { useLedgerFetch, useVehicle, useVehicleBase } from '@/components/accounting-vehicle'
import { PeriodPicker } from '@/components/accounting/period-picker'
import type { PeriodPreset } from '@/lib/accounting/statement-period'
import { EmptyState } from '@/components/ui/empty-state'
import { soiRowHref } from '@/lib/portfolio/holding-href'
import { tieOutState } from '@/lib/accounting/tie-out-state'

interface SoiRow {
  name: string
  holdingType?: 'company' | 'fund' | 'crypto'
  cost: number
  fairValue: number
  pctOfNetAssets: number
  companyId?: string
  industry?: string | null
  assetType?: string
  shares?: number | null
  sharePrice?: number | null
  moic?: number | null
  /** ASC 820 fair value hierarchy. Absent reads as Level 3. */
  valuationLevel?: 1 | 2 | 3
  // Present once the company has its own 1100-<id> / 1200-<id> accounts.
  ledgerCost?: number
  ledgerFairValue?: number
  tiesOut?: boolean
  chain?: { observedUnits: number; delta: number; agrees: boolean; asOf: string } | null
  // Underlying funds only (holdingType === 'fund').
  commitment?: number
  called?: number
  unfunded?: number
  pctCalled?: number | null
  navAsOf?: string | null
  stalenessDays?: number | null
}
interface SoiGroup { name: string; cost: number; fairValue: number; pctOfNetAssets: number }
interface Soi {
  chainWarning?: string
  rows: SoiRow[]
  totalCost: number
  totalFairValue: number
  netAssets: number
  source: 'tracker' | 'ledger'
  ledgerCost: number
  ledgerFairValue: number
  costVariance: number
  fairValueVariance: number
  byIndustry: SoiGroup[]
  byGeography: SoiGroup[]
  byAssetType: SoiGroup[]
  /** Empty for a wholly private book, where every position is Level 3. */
  byLevel: SoiGroup[]
}

export function ScheduleOfInvestmentsView() {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const [soi, setSoi] = useState<Soi | null>(null)
  const [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<PeriodPreset>('itd')
  const [asOf, setAsOf] = useState('') // '' = latest
  const lf = useLedgerFetch()
  const base = useVehicleBase()
  const { vehicleId } = useVehicle()

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ preset })
    if (asOf) qs.set('asOf', asOf)
    lf(`/api/accounting/statements?${qs}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setSoi(d?.scheduleOfInvestments ?? null))
      .finally(() => setLoading(false))
  }, [lf, preset, asOf])
  useEffect(() => { load() }, [load])

  const content = (() => {
    if (!soi) return null
    const tied = soi.costVariance === 0 && soi.fairValueVariance === 0
    const num = (v: number | null | undefined, dp = 0) =>
      v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

    // Fund holdings and company holdings get their OWN sections rather than one mixed table:
    // a fund position has no share count and a company position has no unfunded commitment,
    // so a single table would render half its columns blank for every row. The ledger control
    // total below still covers both — only the display is split.
    const fundRows = soi.rows.filter(r => r.holdingType === 'fund')
    const cryptoRows = soi.rows.filter(r => r.holdingType === 'crypto')
    // Everything else, including rows from before the discriminator existed.
    const companyRows = soi.rows.filter(r => r.holdingType !== 'fund' && r.holdingType !== 'crypto')
    // The Level column appears only once something is ABOVE Level 3. A wholly private book is
    // Level 3 by construction, and a column repeating "3" on every row is noise that makes the
    // one number a reader should notice harder to find.
    const showLevel = (soi.byLevel?.length ?? 0) > 0

    // Every row opens its holding, where it is recorded and configured, on this entity.
    const nameCell = (r: SoiRow) => {
      const href = soiRowHref(r, vehicleId)
      return href ? <Link href={href} className="hover:underline underline-offset-2">{r.name}</Link> : r.name
    }

    const groupTable = (title: string, groups: SoiGroup[]) => (
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-3 py-2 font-medium">{title}</th>
              <th className="text-right px-3 py-2 font-medium">Cost</th>
              <th className="text-right px-3 py-2 font-medium">Fair value</th>
              <th className="text-right px-3 py-2 font-medium">% of net assets</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.name} className="border-b last:border-b-0">
                <td className="px-3 py-2">{g.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(g.cost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(g.fairValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(g.pctOfNetAssets)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )

    return (
      <>
      {soi.chainWarning && <p className="text-sm text-warning">{soi.chainWarning}</p>}
      {/* Every derived entry posts when recorded, so a schedule that does not tie is a real
          disagreement — see lib/accounting/tie-out-state.ts. */}
      {(() => {
        const state = tieOutState({ tied })
        if (state === 'booked') return (
          <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            <Check className="h-4 w-4 mt-0.5 shrink-0 text-success" />
            <span>Booked — cost {fmt(soi.ledgerCost)}, fair value {fmt(soi.ledgerFairValue)}.</span>
          </div>
        )
        return (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning dark:text-warning">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              <strong>The books disagree with the schedule.</strong> The schedule says cost {fmt(soi.totalCost)} / fair
              value {fmt(soi.totalFairValue)}; the books carry {fmt(soi.ledgerCost)} / {fmt(soi.ledgerFairValue)}.
              Variance: cost <span className="tabular-nums">{fmt(soi.costVariance)}</span>, fair
              value <span className="tabular-nums">{fmt(soi.fairValueVariance)}</span>.
              Either an entry was edited after it was booked, or some transactions are not on the ledger yet.{' '}
              <Link href={base ? `${base}/journal` : '/funds/journal'} className="underline underline-offset-2">Check the journal</Link>.
            </span>
          </div>
        )
      })()}

      {/* UNDERLYING FUNDS GET THEIR OWN COLUMNS. A commitment with capital still callable is a
          different liquidity fact from a fully-drawn position, and cost cannot express it — so the
          schedule states commitment, called and unfunded rather than borrowing the share-count
          columns a fund position has nothing to put in. These figures come from the same
          fund-of-funds register the quarterly marks and the pre-close check read, so the schedule
          and the close cannot disagree about what is unfunded. */}
      {fundRows.length > 0 && (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-3 py-2 font-medium">Underlying funds</th>
                <th className="text-right px-3 py-2 font-medium">Commitment</th>
                <th className="text-right px-3 py-2 font-medium">Called</th>
                <th className="text-right px-3 py-2 font-medium">Unfunded</th>
                <th className="text-right px-3 py-2 font-medium">Cost</th>
                <th className="text-right px-3 py-2 font-medium">Fair value</th>
                <th className="text-right px-3 py-2 font-medium">MOIC</th>
                <th className="text-left px-3 py-2 font-medium">NAV as of</th>
                <th className="text-right px-3 py-2 font-medium">% of net assets</th>
              </tr>
            </thead>
            <tbody>
              {fundRows.map((r, i) => (
                <tr key={r.name + i} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2">
                    {nameCell(r)}
                    {r.tiesOut === false && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-warning/15 text-warning">off ledger</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.commitment == null ? '—' : fmt(r.commitment)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.called == null ? '—' : fmt(r.called)}
                    {r.pctCalled != null && <span className="ml-1 text-xs text-muted-foreground">{pct(r.pctCalled)}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.unfunded == null ? '—' : fmt(r.unfunded)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.cost)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.fairValue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{r.moic == null ? '—' : `${r.moic.toFixed(2)}×`}</td>
                  {/* A stale manager NAV is normal (45-90 days); say how stale rather than hiding it. */}
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.navAsOf ?? 'no statement'}
                    {r.stalenessDays != null && r.stalenessDays > 120 && (
                      <span className="ml-1 text-warning">{r.stalenessDays}d</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(r.pctOfNetAssets)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(fundRows.reduce((a, r) => a + (r.commitment ?? 0), 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(fundRows.reduce((a, r) => a + (r.called ?? 0), 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(fundRows.reduce((a, r) => a + (r.unfunded ?? 0), 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(fundRows.reduce((a, r) => a + r.cost, 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(fundRows.reduce((a, r) => a + r.fairValue, 0))}</td>
                <td /><td /><td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {([
        // A token has a quantity and a price, so it shares the table's shape — but no industry,
        // stage or country, so it gets its own heading rather than three blank columns.
        ['Digital assets', cryptoRows] as const,
        [(fundRows.length > 0 || cryptoRows.length > 0) ? 'Direct investments' : 'Investment', companyRows] as const,
      ]).filter(([, rs]) => rs.length > 0).map(([heading, rs]) => {
      const isCrypto = heading === 'Digital assets'
      return (
      <div key={heading} className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-3 py-2 font-medium">{heading}</th>
              <th className="text-left px-3 py-2 font-medium">Industry</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              {showLevel && <th className="text-left px-3 py-2 font-medium">Level</th>}
              <th className="text-right px-3 py-2 font-medium">Shares</th>
              {isCrypto && <th className="text-right px-3 py-2 font-medium">On chain</th>}
              <th className="text-right px-3 py-2 font-medium">Price</th>
              <th className="text-right px-3 py-2 font-medium">Cost</th>
              <th className="text-right px-3 py-2 font-medium">Fair value</th>
              <th className="text-right px-3 py-2 font-medium">MOIC</th>
              <th className="text-right px-3 py-2 font-medium">% of net assets</th>
            </tr>
          </thead>
          <tbody>
            {rs.map((r, i) => (
              <tr key={r.name + i} className="border-b last:border-b-0 hover:bg-muted/20">
                <td className="px-3 py-2">
                  {nameCell(r)}
                  {/* A per-company tie-out is only possible once the company has its own
                      accounts. The aggregate line can't tell you which position is off. */}
                  {r.tiesOut === false && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wider px-1 py-0.5 rounded bg-warning/15 text-warning">off ledger</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.industry ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.assetType ?? '—'}</td>
                {showLevel && (
                  <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{r.valuationLevel ?? 3}</td>
                )}
                <td className="px-3 py-2 text-right tabular-nums text-xs">{num(r.shares)}</td>
                {isCrypto && (
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {!r.chain ? <span className="text-muted-foreground">—</span>
                      : r.chain.agrees ? <span className="text-muted-foreground" title={`Read ${r.chain.asOf}`}>agrees</span>
                      : <span className="text-sm text-warning" title={`Chain ${num(r.chain.observedUnits, 4)}, read ${r.chain.asOf}`}>{r.chain.delta > 0 ? '+' : '−'}{num(Math.abs(r.chain.delta), 4)}</span>}
                  </td>
                )}
                <td className="px-3 py-2 text-right tabular-nums text-xs">{r.sharePrice == null ? '—' : formatSharePrice(r.sharePrice, currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.cost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.fairValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{r.moic == null ? '—' : `${r.moic.toFixed(2)}×`}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(r.pctOfNetAssets)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/30 font-semibold">
              <td className="px-3 py-2" colSpan={(showLevel ? 6 : 5) + (isCrypto ? 1 : 0)}>Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(rs.reduce((a, r) => a + r.cost, 0))}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(rs.reduce((a, r) => a + r.fairValue, 0))}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      )
      })}

      {/* Every section together, against the ledger — the control total is unchanged by the split. */}
      {[fundRows, cryptoRows, companyRows].filter(rs => rs.length > 0).length > 1 && (
        <div className="border rounded-lg px-3 py-2 flex items-center justify-between text-sm font-semibold">
          <span>Total investments</span>
          <span className="tabular-nums">{fmt(soi.totalCost)} cost · {fmt(soi.totalFairValue)} fair value</span>
        </div>
      )}

      {soi.source === 'tracker' && (
        <div className="grid gap-4 md:grid-cols-2">
          {soi.byIndustry.length > 0 && groupTable('By industry', soi.byIndustry)}
          {soi.byAssetType.length > 0 && groupTable('By asset type', soi.byAssetType)}
          {soi.byGeography.length > 0 && groupTable('By geography', soi.byGeography)}
          {/* ASC 820. Present only once a position is priced by something other than judgement. */}
          {(soi.byLevel?.length ?? 0) > 0 && groupTable('By fair value level', soi.byLevel)}
        </div>
      )}

      </>
    )
  })()

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {/* As-of snapshot date — SOI is a point in time, so only the period END matters.
            No custom range: the presets + As of cover every as-of date. */}
        <span className="text-sm text-muted-foreground">Investments</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PeriodPicker
            preset={preset} onPreset={setPreset}
            start="" end="" onStart={() => {}} onEnd={() => {}}
            asOf={asOf} onAsOf={setAsOf}
            allowAsOf allowCustom={false}
            presets={['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd']}
            title="Investments as of this date"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : !soi || soi.rows.length === 0 ? (
        <EmptyState
          // Investments are recorded on a company page, and every company is
          // reachable from Portfolio — so that is the way in from here.
          action={
            <Button size="sm" variant="outline" asChild>
              <Link href="/dashboard">Open Portfolio</Link>
            </Button>
          }
        >
          No investments booked as of {asOf || 'today'}. Investments are recorded on a company.
        </EmptyState>
      ) : (
        content
      )}
    </div>
  )
}
