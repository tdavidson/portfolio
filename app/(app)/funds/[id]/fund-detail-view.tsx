'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
  LineChart, Line, ReferenceLine,
} from 'recharts'
import { Loader2, ArrowRight } from 'lucide-react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useVehicle, FundSwitcher } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { Card, CardContent } from '@/components/ui/card'
import { Metric as MetricBox } from '@/components/ui/metric'
import {
  ChartCard, EmptyPlot, AXIS, tooltipStyle, HUE, SLICE, sliceFill,
  INVEST_NEW, INVEST_FOLLOW, GAINS_HUE, PROCEEDS_HUE,
} from '@/components/fund-chart-kit'

// The fund detail (lead) page. Everything here is READ-ONLY and derived — the same numbers as the
// /funds overview (fund-economics), the schedule of investments (statements), and the growth
// series (fund-timeseries). Operational admin lives on /funds/status.

interface Metrics {
  committed: number; paidIn: number; uncalled: number; distributions: number
  nav: number; totalValue: number
  dpi: number | null; rvpi: number | null; tvpi: number | null; irr: number | null
}
interface VehicleEconomics {
  vehicle: string; vintageYear: number | null; source: 'ledger' | 'events'; lpCount: number
  fund: Metrics; lp: Metrics; gp?: Metrics; carryAccrued?: number
}
interface SoiGroup { name: string; cost: number; fairValue: number; pctOfNetAssets: number }
interface SoiRow {
  name: string; cost: number; fairValue: number; pctOfNetAssets: number; moic?: number | null; industry?: string | null
  // Per-company value breakdown (tracker rows). invested = gross deployed; distributions = realized
  // proceeds; totalValue = distributions + fairValue (residual).
  invested?: number; distributions?: number; totalValue?: number
  /** Present on tracker rows. Lets an exited, proceeds-only bar be labelled. */
  status?: 'active' | 'exited' | 'written-off'
  /** invested, split by lib/accounting/soi.ts. new + followOn === invested. */
  investedNew?: number; investedFollowOn?: number
}
interface Soi {
  rows: SoiRow[];
  /** Fully-realized companies — not on the schedule, but part of the ITD picture. */
  realizedRows?: SoiRow[]; totalCost: number; totalFairValue: number; netAssets: number
  source: 'tracker' | 'ledger'; byIndustry: SoiGroup[]; byGeography: SoiGroup[]; byAssetType: SoiGroup[]
}
interface TsPoint {
  period: string; label: string
  calledCapital: number; distributed: number
  contributions: number; distributions: number; operatingIncome: number
  realizedGains: number; unrealizedGains: number; expenses: number; other: number; nav: number
  investedCapital: number; newInvested: number; followOnInvested: number; proceeds: number; portfolioValue: number
  grossIrr: number | null; netIrrFund: number | null; netIrrLp: number | null
}
interface Timeseries { points: TsPoint[]; hasGross: boolean }

type Lens = 'lp' | 'fund'

function LensToggle({ lens, setLens }: { lens: Lens; setLens: (l: Lens) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {(['lp', 'fund'] as Lens[]).map(l => (
        <button
          key={l}
          type="button"
          onClick={() => setLens(l)}
          className={`px-2 py-1 rounded ${lens === l ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
        >
          {l === 'lp' ? 'Net to LP' : 'Whole fund'}
        </button>
      ))}
    </div>
  )
}

const moic = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`)
const irrPct = (v: number | null | undefined) => {
  if (v == null) return '—'
  const p = v * 100
  return `${(Object.is(p, -0) ? 0 : p).toFixed(1)}%`
}

export function FundDetailView({ vehicle, vehicleId }: { vehicle: string; vehicleId: string | null }) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrency(v, currency)
  const fmtFull = (v: number) => formatCurrencyFull(v, currency)
  const { setVehicle } = useVehicle()

  const [econ, setEcon] = useState<VehicleEconomics | null>(null)
  const [soi, setSoi] = useState<Soi | null>(null)
  const [ts, setTs] = useState<Timeseries | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [lens, setLens] = useState<Lens>('lp')

  // Pin the section's vehicle context to this URL, so the Analyst and any subpage the user opens
  // from here (Admin, capital accounts, …) inherit the fund they're looking at.
  useEffect(() => { setVehicle(vehicle, vehicleId) }, [vehicle, vehicleId, setVehicle])

  const g = `group=${encodeURIComponent(vehicle)}`
  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetch('/api/accounting/fund-economics').then(r => (r.ok ? r.json() : { vehicles: [] })),
      fetch(`/api/accounting/statements?${g}&preset=itd`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/accounting/fund-timeseries?${g}`).then(r => (r.ok ? r.json() : null)),
    ]).then(([e, s, t]) => {
      const found = (e.vehicles ?? []).find((v: VehicleEconomics) => v.vehicle === vehicle) ?? null
      setEcon(found)
      setNotFound(!found)
      setSoi(s?.scheduleOfInvestments ?? null)
      setTs(t && !t.error ? t : null)
    }).finally(() => setLoading(false))
  }, [g, vehicle])
  useEffect(() => { load() }, [load])

  const hasGpSplit = !!econ && ((econ.gp?.paidIn ?? 0) !== 0 || (econ.gp?.nav ?? 0) !== 0 || (econ.carryAccrued ?? 0) !== 0)
  const effectiveLens: Lens = hasGpSplit ? lens : 'fund'
  const m = econ ? (effectiveLens === 'lp' ? econ.lp : econ.fund) : null
  // Capital charts depend on available figures, including reported balances.
  const hasCapitalData = !!econ && ([econ.fund.paidIn, econ.fund.nav, econ.fund.distributions].some(v => v != null && v !== 0))

  // WHICH BASIS THE RATIOS ARE ON.
  //
  // rollUp's TVPI/DPI/IRR come from CAPITAL ACCOUNTS in both the 'ledger' and 'events' cases —
  // both are LP-level, so both are already net of fees. The only deal-level (gross) numbers live
  // in the timeseries. A vehicle with no capital accounts at all has null ratios, and for it the
  // honest answer is the gross triple, not three dashes.
  const lastTs = ts?.points[ts.points.length - 1] ?? null
  const grossTvpi = lastTs && lastTs.investedCapital > 0
    ? (lastTs.proceeds + lastTs.portfolioValue) / lastTs.investedCapital : null
  const grossDpi = lastTs && lastTs.investedCapital > 0 ? lastTs.proceeds / lastTs.investedCapital : null
  const grossIrr = lastTs?.grossIrr ?? null
  const hasNet = !!m && m.tvpi != null
  const basis: 'net' | 'fund' | 'gross' =
    !hasNet && ts?.hasGross ? 'gross' : effectiveLens === 'lp' ? 'net' : 'fund'
  const prefix = basis === 'net' ? 'Net ' : basis === 'gross' ? 'Gross ' : 'Fund '
  const basisNote =
    basis === 'net'
      ? 'Net to LP — after management fees, expenses and accrued carried interest.'
      : basis === 'gross'
        ? 'Gross, deal level — portfolio cash flows and carrying value, before fund fees and expenses.'
        : 'Whole fund — after fees and expenses, before carried interest is carved to the GP.'
  const showTvpi = basis === 'gross' ? grossTvpi : m?.tvpi ?? null
  const showDpi = basis === 'gross' ? grossDpi : m?.dpi ?? null
  const netIrr = basis === 'gross' ? null : m?.irr ?? null
  // The ONE case where the row mixes bases: a vehicle that HAS capital accounts but whose net
  // IRR is null for want of time spread (a single-cutover tracking vehicle pins the terminal
  // value to the contribution date, so no rate exists). Each box is labelled, and a real number
  // the GP can act on beats a dash.
  const irrIsGross = netIrr == null && grossIrr != null
  const showIrr = netIrr ?? grossIrr
  const irrLabel = irrIsGross ? 'Gross IRR' : `${prefix}IRR`

  // The page body — loading, not-found, or the metrics + charts. Rendered inside
  // <AccountingBody> below, so the Analyst panel slides in beside it while the header above
  // stays full width.
  const body = loading ? (
    <div className="rounded-card border p-6 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading fund detail…
    </div>
  ) : (notFound || !econ || !m) ? (
    <div className="rounded-card border p-6 space-y-3 max-w-lg">
      <p className="text-sm">No vehicle named <strong>{vehicle}</strong> was found, or it carries no capital yet.</p>
      <Link href="/funds" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent transition-colors">
        Back to all funds <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  ) : (
    <div className="space-y-6">
      {/* Key metrics — same Card treatment as the /funds overview and the LP snapshot.
          These are the ONLY surface the Net-to-LP / Whole-fund lens drives. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricBox label="Committed" value={fmt(m.committed)} />
        <MetricBox label="Called" value={fmt(m.paidIn)} />
        <MetricBox label="Uncalled" value={fmt(m.uncalled)} />
        <MetricBox label="Distributed" value={fmt(m.distributions)} />
        <MetricBox label="NAV" value={fmt(m.nav)} />
        <MetricBox label={`${prefix}TVPI`} value={moic(showTvpi)} />
        <MetricBox label={`${prefix}DPI`} value={moic(showDpi)} />
        <MetricBox label={irrLabel} value={irrPct(showIrr)} />
      </div>

      {/* "Net of fees, gross of carry" is not recoverable from a three-letter label. */}
      <p className="-mt-3 text-xs text-muted-foreground">
        {basisNote}
        {irrIsGross && ' IRR is shown gross — the capital accounts do not span enough time to derive a net rate.'}
      </p>

      {/* Dated investment and capital series, when available. */}
      {(ts?.points.length ?? 0) > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CashFlowsChart points={ts!.points} hasGross={!!ts?.hasGross} hasCapitalData={hasCapitalData} fmt={fmt} fmtFull={fmtFull} />
          <AssetsChart points={ts!.points} hasCapitalData={hasCapitalData} fmt={fmt} fmtFull={fmtFull} />
        </div>
      )}

      {/* Investment breakdown — from the schedule of investments (tracker rows). Hidden entirely
          when the vehicle tracks no per-company detail, rather than showing an empty placeholder. */}
      {soi && soi.source === 'tracker' && (soi.rows.length > 0 || (soi.realizedRows?.length ?? 0) > 0) && (
        <div className="space-y-4">
          {/* Realized companies are NOT on the schedule (ASC 946 reports holdings), but this
              chart ranks on invested capital and proceeds inception-to-date — where an exited
              company is exactly the row you most want to see. */}
          <TopHoldings rows={[...soi.rows, ...(soi.realizedRows ?? [])]} fmt={fmt} fmtFull={fmtFull} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownChart title="By industry" groups={soi.byIndustry} fmt={fmt} fmtFull={fmtFull} />
            <BreakdownChart
              title={soi.byAssetType.length > 1 ? 'By asset type' : 'By geography'}
              groups={soi.byAssetType.length > 1 ? soi.byAssetType : soi.byGeography}
              fmt={fmt}
              fmtFull={fmtFull}
            />
          </div>
        </div>
      )}

      {/* Fourth row — the new-vs-follow-on split and IRR over time, side by side. The IRR chart
          shows whole-fund net IRR regardless of the header lens (charts stay whole-fund). */}
      {(ts?.points.length ?? 0) > 0 && (ts!.hasGross || hasCapitalData) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {ts!.hasGross && <NewVsFollowOnPie point={ts!.points[ts!.points.length - 1]} fmt={fmt} fmtFull={fmtFull} />}
          <IrrOverTimeChart points={ts!.points} hasCapitalData={hasCapitalData} />
        </div>
      )}

      <p className="text-xs text-muted-foreground max-w-3xl">
        Metrics and charts are reported through the last closed accounting period.
      </p>
    </div>
  )

  return (
    <>
      {/* Header — full width, ABOVE the body/panel row, so the Analyst panel slides in
          underneath it. The lens toggle and the switcher are the page's actions: beside the
          description from `sm` up, on their own row under it on a phone. */}
      <AccountingPageHeader
        title={vehicle}
        titleAttr={vehicle}
        truncateTitle
        actions={<>
          {hasGpSplit && <LensToggle lens={lens} setLens={setLens} />}
          {vehicleId && (
            <Link href={`/entities/${vehicleId}/documents`} className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground whitespace-nowrap">
              Documents
            </Link>
          )}
          <FundSwitcher />
        </>}
      >
        {econ && <>
          {econ.vintageYear ? <>Vintage {econ.vintageYear} · </> : null}
          {econ.lpCount} {econ.lpCount === 1 ? 'partner' : 'partners'}
        </>}
      </AccountingPageHeader>
      <AccountingBody>{body}</AccountingBody>
    </>
  )
}

// ── Fund cash flows per period: signed bars, proceeds up / capital deployed down ──

function CashFlowsChart({
  points, hasGross, hasCapitalData, fmt, fmtFull,
}: { points: TsPoint[]; hasGross: boolean; hasCapitalData: boolean; fmt: (v: number) => string; fmtFull: (v: number) => string }) {
  // Net metrics (called capital, distributed) only mean something on a fund with accounting; a
  // capital-tracking vehicle has no called capital, so it shows the gross (deal-level) view only.
  const canNet = hasCapitalData
  const canGross = hasGross
  const [mode, setMode] = useState<'net' | 'gross'>(hasCapitalData ? 'net' : 'gross')
  const view: 'net' | 'gross' =
    mode === 'net' && canNet ? 'net' : mode === 'gross' && canGross ? 'gross' : canGross ? 'gross' : 'net'

  const toggle = canNet && canGross ? (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {(['gross', 'net'] as const).map(mo => (
        <button
          key={mo}
          onClick={() => setMode(mo)}
          className={`px-2 py-1 rounded ${view === mo ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
        >
          {mo === 'net' ? 'Called & distributed' : 'Invested & proceeds'}
        </button>
      ))}
    </div>
  ) : undefined

  // Convert the cumulative series to per-period flows. Capital deployed is an outflow (drawn DOWN,
  // negative); capital returned is an inflow (drawn UP, positive). stackOffset="sign" splits them.
  const data = useMemo(() => points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : null
    const d = (k: keyof TsPoint) => (Number(p[k]) || 0) - (prev ? Number(prev[k]) || 0 : 0)
    return {
      label: p.label,
      newInvested: -d('newInvested'),
      followOnInvested: -d('followOnInvested'),
      proceeds: d('proceeds'),
      calledCapital: -d('calledCapital'),
      distributed: d('distributed'),
    }
  }), [points])

  const series = view === 'net'
    ? [
        { key: 'calledCapital', name: 'Called capital', color: INVEST_NEW },
        { key: 'distributed', name: 'Distributed', color: PROCEEDS_HUE },
      ]
    : [
        { key: 'newInvested', name: 'New capital', color: INVEST_NEW },
        { key: 'followOnInvested', name: 'Follow-on capital', color: INVEST_FOLLOW },
        { key: 'proceeds', name: 'Proceeds', color: PROCEEDS_HUE },
      ]

  return (
    <ChartCard title="Fund cash flows per period" action={toggle}>
      {points.length === 0 ? (
        <EmptyPlot label="No dated activity yet." />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} stackOffset="sign">
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="equidistantPreserveStart" className="text-muted-foreground" />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={fmt} className="text-muted-foreground" />
            <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtFull(Math.abs(v as number)), n]} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            {series.map(s => (
              <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} stroke={HUE.surface} strokeWidth={1} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

// ── Fund assets end of period: cumulative composition ─────────────────────────

// The accounting (partners'-capital) composition, signed so the segments sum to NAV.
const NAV_SERIES = [
  { key: 'netPaidIn', name: 'Net paid-in capital', color: HUE.chart3 },
  { key: 'realizedGains', name: 'Realized gains', color: HUE.chart2 },
  { key: 'unrealizedGains', name: 'Unrealized gains', color: HUE.chart1 },
  { key: 'operatingIncome', name: 'Operating income', color: HUE.chart5 },
  { key: 'expenses', name: 'Expenses & fees', color: HUE.chart4 },
  { key: 'other', name: 'Other', color: HUE.muted },
] as const

// Capital-tracking assets: portfolio carrying value split into cost (new + follow-on) and gain.
const GROSS_ASSET_SERIES = [
  { key: 'newInvested', name: 'New invested', color: INVEST_NEW },
  { key: 'followOnInvested', name: 'Follow-on invested', color: INVEST_FOLLOW },
  { key: 'unrealizedGains', name: 'Unrealized gains', color: GAINS_HUE },
] as const

function AssetsChart({
  points, hasCapitalData, fmt, fmtFull,
}: { points: TsPoint[]; hasCapitalData: boolean; fmt: (v: number) => string; fmtFull: (v: number) => string }) {
  const { data, series } = useMemo(() => {
    if (hasCapitalData) {
      // Net paid-in = contributions net of capital returned; the rest is already signed so the
      // stack sums to NAV (partners' capital), which is the fund's assets under accounting.
      const d = points.map(p => ({ ...p, netPaidIn: Math.round((p.contributions + p.distributions) * 100) / 100 }))
      const s = NAV_SERIES.filter(se => d.some(x => Math.abs(Number((x as any)[se.key])) > 0.5))
      return { data: d as any[], series: s as readonly { key: string; name: string; color: string }[] }
    }
    // Assets = portfolio carrying value = invested cost + unrealized gain. Underwater (gain < 0)
    // scales the cost segments down so the stack still totals the carrying value rather than
    // painting a negative slice.
    const d = points.map(p => {
      const invested = p.newInvested + p.followOnInvested
      const gain = p.portfolioValue - invested
      if (gain >= 0) return { label: p.label, newInvested: p.newInvested, followOnInvested: p.followOnInvested, unrealizedGains: gain }
      const f = invested > 0 ? p.portfolioValue / invested : 0
      return { label: p.label, newInvested: p.newInvested * f, followOnInvested: p.followOnInvested * f, unrealizedGains: 0 }
    })
    return { data: d as any[], series: GROSS_ASSET_SERIES as readonly { key: string; name: string; color: string }[] }
  }, [points, hasCapitalData])

  return (
    <ChartCard title="Fund assets end of period">
      {points.length === 0 ? (
        <EmptyPlot label="No dated activity yet." />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} stackOffset="sign">
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="equidistantPreserveStart" className="text-muted-foreground" />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={fmt} className="text-muted-foreground" />
            <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.4)' }} contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtFull(v as number), n]} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
            {series.map(s => (
              <Bar key={s.key} dataKey={s.key} name={s.name} stackId="assets" fill={s.color} stroke={HUE.surface} strokeWidth={1} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

// ── New vs follow-on capital: a donut of the invested cost at the latest period ──

function NewVsFollowOnPie({
  point, fmt, fmtFull,
}: { point: TsPoint; fmt: (v: number) => string; fmtFull: (v: number) => string }) {
  const data = [
    { name: 'New capital', value: Math.max(0, point.newInvested), color: INVEST_NEW },
    { name: 'Follow-on capital', value: Math.max(0, point.followOnInvested), color: INVEST_FOLLOW },
  ].filter(d => d.value > 0)
  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <ChartCard title="New vs follow-on capital">
      {total === 0 ? (
        <EmptyPlot label="No invested capital yet." />
      ) : (
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="55%" height={220}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={80} paddingAngle={2} stroke={HUE.surface} strokeWidth={2}>
                {data.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtFull(v as number), n]} />
            </PieChart>
          </ResponsiveContainer>
          <ul className="flex-1 space-y-1.5 text-xs min-w-0">
            {data.map(d => (
              <li key={d.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
                <span className="truncate flex-1">{d.name}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{fmt(d.value)}</span>
                <span className="tabular-nums text-muted-foreground/70 shrink-0 w-10 text-right">
                  {total ? `${Math.round((d.value / total) * 100)}%` : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

// ── IRR over time: gross always; net (whole-fund vs LP by the page lens) on accounting ──

function IrrOverTimeChart({
  points, hasCapitalData,
}: { points: TsPoint[]; hasCapitalData: boolean }) {
  const [mode, setMode] = useState<'net' | 'gross'>('net')
  const view: 'net' | 'gross' = hasCapitalData ? mode : 'gross'

  const toggle = hasCapitalData ? (
    <div className="inline-flex rounded-md border p-0.5 text-xs">
      {(['net', 'gross'] as const).map(mo => (
        <button
          key={mo}
          onClick={() => setMode(mo)}
          className={`px-2 py-1 rounded ${mode === mo ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
        >
          {mo === 'net' ? 'Net IRR' : 'Gross IRR'}
        </button>
      ))}
    </div>
  ) : undefined

  // Net is always the whole-fund net IRR (the header lens drives only the metric boxes);
  // gross is the deal-level IRR.
  const seriesName = view === 'gross' ? 'Gross IRR' : 'Net IRR — whole fund'
  const data = points.map(p => {
    const v = view === 'net' ? p.netIrrFund : p.grossIrr
    return { label: p.label, irr: v == null ? null : Math.round(v * 1000) / 10 }
  })
  const hasAny = data.some(d => d.irr != null)

  return (
    <ChartCard title="IRR over time" action={toggle}>
      {!hasAny ? (
        <EmptyPlot label="Not enough dated activity to compute IRR." />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="equidistantPreserveStart" className="text-muted-foreground" />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${Math.round(v)}%`} className="text-muted-foreground" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, seriesName]} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Line type="monotone" dataKey="irr" name={seriesName} stroke={INVEST_NEW} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

// ── Investment breakdown: donut by a dimension ────────────────────────────────

function BreakdownChart({
  title, groups, fmt, fmtFull,
}: { title: string; groups: SoiGroup[]; fmt: (v: number) => string; fmtFull: (v: number) => string }) {
  // Keep the top 4 slices by fair value and fold the tail into "Other" — four is
  // the validated all-pairs ceiling for this palette, so a fifth hue would be one
  // no colour-blind reader could separate from its neighbours.
  const data = useMemo(() => {
    const sorted = [...groups].filter(g => g.fairValue > 0).sort((a, b) => b.fairValue - a.fairValue)
    if (sorted.length <= SLICE.length + 1) return sorted
    const head = sorted.slice(0, SLICE.length)
    const tail = sorted.slice(SLICE.length).reduce((s, g) => s + g.fairValue, 0)
    return [...head, { name: 'Other', cost: 0, fairValue: tail, pctOfNetAssets: 0 }]
  }, [groups])
  const total = data.reduce((s, g) => s + g.fairValue, 0)

  return (
    <ChartCard title={title}>
      {data.length === 0 ? (
        <EmptyPlot label="Nothing to break down." />
      ) : (
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="55%" height={220}>
            <PieChart>
              <Pie data={data} dataKey="fairValue" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={80} paddingAngle={2} stroke={HUE.surface} strokeWidth={2}>
                {data.map((_, i) => <Cell key={i} fill={sliceFill(i)} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtFull(v as number), n]} />
            </PieChart>
          </ResponsiveContainer>
          {/* Direct-labelled legend — identity + magnitude beside each swatch, in ink. */}
          <ul className="flex-1 space-y-1.5 text-xs min-w-0">
            {data.map((gp, i) => (
              <li key={gp.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: sliceFill(i) }} />
                <span className="truncate flex-1" title={gp.name}>{gp.name}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{fmt(gp.fairValue)}</span>
                <span className="tabular-nums text-muted-foreground/70 shrink-0 w-10 text-right">
                  {total ? `${Math.round((gp.fairValue / total) * 100)}%` : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

// ── Portfolio — horizontal bars, with toggles for the metric and bar scale ────────

// At the holding (deal) level, realized cash is PROCEEDS. "Distributions" is a net/LP concept that
// only appears under the net-metrics toggle — and an LP-tracking vehicle has no net metrics at all —
// so this gross, per-company chart always says proceeds.
type HoldingMetric = 'total' | 'invested' | 'residual' | 'proceeds'
type HoldingBarMode = 'value' | 'share'

const HOLDING_METRICS: { key: HoldingMetric; label: string }[] = [
  { key: 'total', label: 'Total value' },
  { key: 'invested', label: 'Invested' },
  { key: 'residual', label: 'Residual value' },
  { key: 'proceeds', label: 'Proceeds' },
]

// Reuse the fixed hues the other charts use, so "total value" reads as its parts stacked:
// proceeds keep the teal they use elsewhere, residual its "Unrealized" colour.
const HOLDING_HUE = { invested: HUE.chart3, proceeds: HUE.chart2, residual: HUE.chart1 } as const

function holdingParts(r: SoiRow) {
  // `r.distributions` is the tracker's realized-proceeds field (deal-level), surfaced here as proceeds.
  const proceeds = r.distributions ?? 0
  const residual = r.fairValue
  const invested = r.invested ?? r.cost
  return {
    invested,
    // Fall back to treating the whole position as new capital when the split is absent, so an
    // older cached payload renders one honest bar rather than an empty one.
    investedNew: r.investedNew ?? invested,
    investedFollowOn: r.investedFollowOn ?? 0,
    exited: r.status === 'exited' || r.status === 'written-off',
    proceeds,
    residual,
    // Unrealized gain on the still-held position: residual value above invested cost. Can be
    // negative (underwater), which the stacked bars clamp to a zero gain segment.
    unrealized: residual - invested,
    total: r.totalValue ?? proceeds + residual,
  }
}

type Holding = { name: string } & ReturnType<typeof holdingParts>

// The coloured segments that make up one bar. "Residual value" stacks invested capital + unrealized
// gains (blue); "Total value" stacks the same two, then adds realized proceeds so the bar still
// sums to total value. "Invested" and "Proceeds" are a single dimension in their own colour.
function holdingSegments(h: Holding, metric: HoldingMetric): { label: string; value: number; color: string }[] {
  if (metric === 'total' || metric === 'residual') {
    // residual = invested + unrealized gain; if underwater, show it all as invested (no gain segment).
    const investedSeg = h.unrealized >= 0 ? h.invested : h.residual
    const segs = [
      { label: 'Invested capital', value: investedSeg, color: HOLDING_HUE.invested },
      { label: 'Unrealized gains', value: Math.max(0, h.unrealized), color: HOLDING_HUE.residual },
    ]
    if (metric === 'total') segs.push({ label: 'Proceeds', value: h.proceeds, color: HOLDING_HUE.proceeds })
    return segs
  }
  if (metric === 'invested') {
    // New = solid, follow-on = the 50% tint of the same slot, so the pairing holds in either
    // theme. Same hues the cash-flows chart uses for the same distinction.
    return [
      { label: 'New capital', value: h.investedNew, color: INVEST_NEW },
      { label: 'Follow-on', value: h.investedFollowOn, color: INVEST_FOLLOW },
    ]
  }
  return [{ label: 'Proceeds', value: h.proceeds, color: HOLDING_HUE.proceeds }]
}

function TopHoldings({
  rows, fmt, fmtFull,
}: { rows: SoiRow[]; fmt: (v: number) => string; fmtFull: (v: number) => string }) {
  const [metric, setMetric] = useState<HoldingMetric>('total')
  const [barMode, setBarMode] = useState<HoldingBarMode>('value')

  // "Largest holdings by X": rank every company on the selected metric, largest first. No cap —
  // the whole portfolio is shown.
  const ranked = useMemo(() => {
    const parts = rows.map(r => ({ name: r.name, ...holdingParts(r) }))
    // Rows with nothing to show on THIS metric are dropped: an exited company has no residual
    // value, and a tail of zero-width bars is noise, not information.
    return parts.filter(h => h[metric] > 0).sort((a, b) => b[metric] - a[metric])
  }, [rows, metric])
  const max = ranked.reduce((mx, h) => Math.max(mx, h[metric]), 0)
  const fundTotal = ranked.reduce((s, h) => s + h[metric], 0)
  if (ranked.length === 0) return null

  const toggle = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Holding metric">
        {HOLDING_METRICS.map(mo => (
          <button
            type="button"
            key={mo.key}
            aria-pressed={metric === mo.key}
            onClick={() => setMetric(mo.key)}
            className={`px-2 py-1 rounded ${metric === mo.key ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            {mo.label}
          </button>
        ))}
      </div>
      <div className="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="Bar scale">
        {(['value', 'share'] as const).map(mode => (
          <button
            type="button"
            key={mode}
            aria-pressed={barMode === mode}
            onClick={() => setBarMode(mode)}
            className={`px-2 py-1 rounded capitalize ${barMode === mode ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            {mode}
          </button>
        ))}
      </div>
    </div>
  )

  // Legend for the stacked tabs. "Total value" and "Residual value" both stack invested capital +
  // unrealized gains (blue); "Total value" adds realized proceeds on the end.
  const legendItems: { label: string; color: string }[] =
    metric === 'total'
      ? [
          { label: 'Invested capital', color: HOLDING_HUE.invested },
          { label: 'Unrealized gains', color: HOLDING_HUE.residual },
          { label: 'Proceeds', color: HOLDING_HUE.proceeds },
        ]
      : metric === 'residual'
        ? [
            { label: 'Invested capital', color: HOLDING_HUE.invested },
            { label: 'Unrealized gains', color: HOLDING_HUE.residual },
          ]
        : metric === 'invested'
          ? [
              { label: 'New capital', color: INVEST_NEW },
              { label: 'Follow-on', color: INVEST_FOLLOW },
            ]
          : []

  return (
    <ChartCard title="Portfolio" action={toggle}>
      {legendItems.length > 0 && (
        <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
          {legendItems.map(item => (
            <span key={item.label} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: item.color }} /> {item.label}
            </span>
          ))}
        </div>
      )}
      <div className="mb-1 flex items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <div className="w-40 shrink-0" />
        <div className="flex-1 min-w-0" />
        <div className="w-24 shrink-0 text-right">Total</div>
        <div className="w-12 shrink-0 text-right">Share</div>
      </div>
      <div className="space-y-2">
        {ranked.map(h => (
          <div key={h.name} className="flex items-center gap-3 text-sm">
            <div className="w-40 shrink-0 flex items-center gap-1.5 min-w-0" title={h.name}>
              <span className="truncate">{h.name}</span>
              {h.exited && (
                <span className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 text-muted-foreground">Exited</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="h-4 rounded-sm bg-muted/50 overflow-hidden flex">
                {holdingSegments(h, metric).map(seg => (
                  <div
                    key={seg.label}
                    className="h-full"
                    style={{
                      width: (barMode === 'value' ? max : fundTotal) && seg.value > 0
                        ? `${(seg.value / (barMode === 'value' ? max : fundTotal)) * 100}%`
                        : '0%',
                      background: seg.color,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="w-24 shrink-0 text-right tabular-nums" title={fmtFull(h[metric])}>{fmt(h[metric])}</div>
            <div className="w-12 shrink-0 text-right tabular-nums text-muted-foreground/70">
              {fundTotal ? `${Math.round((h[metric] / fundTotal) * 100)}%` : '—'}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  )
}
