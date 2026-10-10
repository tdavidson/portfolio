'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ConstructionActuals, ConstructionAssumptions, ConstructionPositionForecast, ConstructionResult, ConstructionStage, PacingAssumptions, SimulationAssumptions } from '@/lib/accounting/construction'
import { constructionBaseline, applyLpWaterfall, forecastSchedule, type ForecastBaseline } from '@/lib/accounting/construction-forecast'
import { simulateFund } from '@/lib/accounting/construction-simulation'
import type { FundTimeseriesPoint } from '@/lib/accounting/fund-timeseries'
import { JCurveChart, CashFlowChart, OutcomeHistogram, type ActualCashFlow, type ActualPoint } from './forecast-charts'

type Fmt = (v: number | null) => string

/**
 * The forward half of the construction page: one set of understandable return assumptions,
 * followed by the deterministic forecast and its simulated range.
 *
 * Both sections read the same model the rest of the page computes and add only what they ask for:
 * pacing turns the plan into a yearly schedule (lib/accounting/construction-forecast.ts); the
 * simulation spreads that schedule's outcomes (lib/accounting/construction-simulation.ts). Every
 * Technical engine settings (seed, run count and log-normal dispersion) use documented industry
 * defaults rather than asking a GP to tune simulation internals.
 *
 * The baseline the schedule starts from is the fund's actual growth series when the vehicle has
 * one (dated, so the IRR is since inception); the capital accounts otherwise.
 */
export function ForecastSection({ model, actuals, a, setA, vehicle, fmt, fmtFull, multiple }: {
  model: ConstructionResult
  actuals: ConstructionActuals
  a: ConstructionAssumptions
  setA: (update: (prev: ConstructionAssumptions) => ConstructionAssumptions) => void
  vehicle: string
  fmt: Fmt
  fmtFull: Fmt
  multiple: (v: number | null) => string
}) {
  const [points, setPoints] = useState<FundTimeseriesPoint[] | null>(null)
  const [yearsOpen, setYearsOpen] = useState(true)
  const [dealsOpen, setDealsOpen] = useState(false)
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/accounting/fund-timeseries?group=${encodeURIComponent(vehicle)}`)
      .then(r => (r.ok ? r.json() : { points: [] }))
      .then(d => { if (!cancelled) setPoints(Array.isArray(d.points) ? d.points : []) })
      .catch(() => { if (!cancelled) setPoints([]) })
    return () => { cancelled = true }
  }, [vehicle])

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const todayYear = useMemo(() => decimalYear(today), [today])
  const accounting = actuals.capitalAvailable === true
  const carryConfigured = !!actuals.waterfall && actuals.waterfall.kind !== 'none' && actuals.waterfall.carryRate > 0

  // The baseline and the actual curve, from the dated series when there is one.
  const { baseline, actual, actualCashFlows } = useMemo(() => {
    // Never feed missing capital observations to the forecast as zero cash flows.
    type CompletePoint = FundTimeseriesPoint & { calledCapital: number; distributed: number; nav: number }
    const pts: CompletePoint[] = accounting
      ? (points ?? []).filter((p): p is CompletePoint => p.calledCapital != null && p.distributed != null && p.nav != null && p.calledCapital > 0)
      : (points ?? []).filter(p => p.investedCapital > 0).map(p => ({ ...p, calledCapital: 0, distributed: 0, nav: 0, expenses: 0 }))
    if (pts.length === 0) {
      const baseline = constructionBaseline(actuals, model, today)
      return { baseline, actual: [] as ActualPoint[], actualCashFlows: [] as ActualCashFlow[] }
    }
    const last = pts[pts.length - 1]
    const baseline = constructionBaseline(actuals, model, today)
    const actual: ActualPoint[] = pts.map(p => ({
      x: decimalYear(p.period),
      label: p.label,
      tvpi: accounting
        ? (p.calledCapital > 0 ? (p.distributed + p.nav) / p.calledCapital : null)
        : (p.investedCapital > 0 ? (p.proceeds + p.portfolioValue) / p.investedCapital : null),
      dpi: accounting
        ? (p.calledCapital > 0 ? p.distributed / p.calledCapital : null)
        : (p.investedCapital > 0 ? p.proceeds / p.investedCapital : null),
    }))
    // The source series is cumulative and quarterly. Convert its known deltas to annual bars,
    // reconciling them to the LP-only baseline when the waterfall separates LPs from the GP.
    const sourceCalledToDate = accounting ? last.calledCapital : last.investedCapital
    const sourceDistributedToDate = accounting ? last.distributed : last.proceeds
    const lpCalledToDate = accounting ? (actuals.waterfall?.lpCalledCapital ?? sourceCalledToDate) : sourceCalledToDate
    const lpDistributedToDate = accounting ? (actuals.waterfall?.lpDistributedCapital ?? sourceDistributedToDate) : sourceDistributedToDate
    const calledScale = sourceCalledToDate > 0 ? lpCalledToDate / sourceCalledToDate : 1
    const distributedScale = sourceDistributedToDate > 0 ? lpDistributedToDate / sourceDistributedToDate : 1
    const annual = new Map<number, ActualCashFlow>()
    let priorCalled = 0
    let priorDistributed = 0
    let priorInvested = 0
    let priorExpenses = 0
    let priorCapitalDistributed = 0
    const lpDistributionScale = last.distributed > 0
      ? (actuals.waterfall?.lpDistributedCapital ?? last.distributed) / last.distributed
      : 1
    for (const p of pts) {
      const year = Number(p.period.slice(0, 4))
      const cumulativeCalled = accounting ? p.calledCapital : p.investedCapital
      const cumulativeDistributed = accounting ? p.distributed : p.proceeds
      const fundCalled = Math.max(0, cumulativeCalled - priorCalled)
      const fundDistributed = Math.max(0, cumulativeDistributed - priorDistributed)
      const invested = Math.max(0, p.investedCapital - priorInvested)
      const expenses = Math.max(0, -((p.expenses ?? 0) - priorExpenses))
      const capitalDistributed = Math.max(0, p.distributed - priorCapitalDistributed)
      const lpCapitalDistributed = capitalDistributed * lpDistributionScale
      const lpCalled = fundCalled * calledScale
      const lpDistributed = fundDistributed * distributedScale
      const row = annual.get(year) ?? { year, called: 0, invested: 0, expenses: 0, distributed: 0, lpDistributed: 0, carriedInterest: 0 }
      row.called += lpCalled
      row.invested += invested
      row.expenses += expenses
      row.distributed += lpDistributed
      row.lpDistributed += lpCapitalDistributed
      row.carriedInterest += Math.max(0, capitalDistributed - lpCapitalDistributed)
      annual.set(year, row)
      priorCalled = cumulativeCalled
      priorDistributed = cumulativeDistributed
      priorInvested = p.investedCapital
      priorExpenses = p.expenses ?? 0
      priorCapitalDistributed = p.distributed
    }
    const actualCashFlows = Array.from(annual.values()).filter(row => row.called > 0.005 || row.distributed > 0.005 || row.lpDistributed > 0.005 || row.carriedInterest > 0.005)
    return { baseline, actual, actualCashFlows: pts.some(p => p.expenses == null) ? [] : actualCashFlows }
  }, [points, actuals, model, today, todayYear, accounting])

  const grossSchedule = useMemo(() => forecastSchedule(model, a, a.pacing, baseline), [model, a, baseline])
  const waterfallSchedule = useMemo(() => carryConfigured && actuals.waterfall ? applyLpWaterfall(grossSchedule, actuals.waterfall) : null, [grossSchedule, actuals.waterfall, carryConfigured])
  // Net forecasts require supported capital figures; gross forecasts use investment records.
  const schedule = accounting && waterfallSchedule ? waterfallSchedule : grossSchedule

  // The simulation is the expensive part: run it on the deferred assumptions so typing in a field
  // stays responsive, and only once something beyond the forecast is stated.
  const deferredA = useDeferredValue(a)
  const simulation = useMemo(() => {
    const s = deferredA.simulation
    const fundWide = s.lossRate > 0 || s.dispersion > 0 || s.holdSpreadYears > 0
    const perDeal = schedule.deals.some(d => (d.lossRate ?? 0) > 0 || (d.dispersion ?? 0) > 0 || (d.exitSpreadYears ?? 0) > 0)
    if (!schedule.stated || !(fundWide || perDeal)) return null
    return simulateFund(model, deferredA, deferredA.pacing, s, baseline, carryConfigured ? actuals.waterfall : undefined)
  }, [model, deferredA, schedule.stated, schedule.deals, baseline, actuals.waterfall, carryConfigured])

  const setPacing = (patch: Partial<PacingAssumptions>) => setA(prev => ({ ...prev, pacing: { ...prev.pacing, ...patch } }))
  const setSim = (patch: Partial<SimulationAssumptions>) => setA(prev => ({ ...prev, simulation: { ...prev.simulation, ...patch } }))
  const setDeal = (kind: 'existing' | 'planned', key: string, patch: Partial<ConstructionPositionForecast> & Partial<ConstructionStage>) => {
    if (kind === 'planned') {
      setA(prev => ({ ...prev, stages: prev.stages.map(stage => stage.key === key ? { ...stage, ...patch } : stage) }))
      return
    }
    setA(prev => {
      const current = model.returns.positions.find(position => position.actual.companyId === key)?.forecast
      if (!current) return prev
      return {
        ...prev,
        positionForecasts: [
          ...prev.positionForecasts.filter(forecast => forecast.companyId !== key),
          { ...current, ...patch, companyId: key },
        ],
      }
    })
  }

  const yearOf = (offset: number) => (offset <= 0 ? 'now' : String(Math.round(todayYear + offset)))
  const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
  const grossFinal = grossSchedule.years.at(-1)
  const economicsSchedule = waterfallSchedule ?? schedule
  const netFinal = economicsSchedule.years.at(-1)
  const totalCarry = waterfallSchedule ? economicsSchedule.years.reduce((sum, year) => sum + (year.carriedInterest ?? 0), 0) : null
  const totalProceeds = model.returns.positions.reduce((sum, position) => sum + position.actual.distributions + (position.estimatedReturn ?? 0), 0)
    + model.returns.stages.reduce((sum, stage) => sum + (stage.estimatedReturn ?? 0), 0)
  const netIrr = waterfallSchedule ? netFinal?.netIrr ?? null : null
  const displayedIrr = netIrr ?? grossFinal?.netIrr ?? null
  const actualMetricsByYear = useMemo(() => {
    const byYear = new Map<number, ActualPoint>()
    if (carryConfigured) return byYear
    for (const point of actual) byYear.set(Math.floor(point.x), point)
    return byYear
  }, [actual, carryConfigured])

  return (
    <div className="space-y-6">
      {/* ── Forecast and Monte Carlo outputs, followed by editable inputs ── */}
      <section>
        <div className="flex items-end justify-between gap-4">
          <div><h2 className="text-lg font-semibold">Returns</h2><p className="mt-1 text-sm text-muted-foreground">Forecasted return metrics using simulation</p></div>
          <Button size="sm" variant="outline" onClick={() => setAssumptionsOpen(open => !open)}>
            <Pencil data-icon="inline-start" />
            {assumptionsOpen ? 'Close return assumptions' : 'Edit return assumptions'}
          </Button>
        </div>
        {assumptionsOpen && (
          <div className="mt-4 rounded-card border bg-muted/30 p-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <YearsField label="Hold period" hint="Years from investment to exit" value={a.pacing.holdYears} onChange={v => setPacing({ holdYears: v, existingHoldYears: v })} />
              <NumField label="Default exit multiple" hint="Used when a company has no override" value={a.simulation.defaultExitMultiple} onChange={v => setSim({ defaultExitMultiple: v })} suffix="x" step="0.1" />
              <NumField label="Write-off rate" hint="Share of deals returning zero" value={a.simulation.lossRate * 100} onChange={v => setSim({ lossRate: Math.min(99, v) / 100 })} suffix="%" step="1" />
              <NumField label="Exit timing range" hint="Years either side of the expected exit" value={a.simulation.holdSpreadYears} onChange={v => setSim({ holdSpreadYears: v })} suffix="yrs" step="0.5" />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Starts from venture base rates: a six-year hold, 50% write-off rate, and a power-law outcome spread. Every planned investment supplies its own timing; simulation runs, seed, and statistical dispersion are managed automatically.</p>
          </div>
        )}
        {!schedule.stated ? (
          <p className="mt-4 text-sm text-muted-foreground">Enter a hold period and complete the timing for planned investments to lay the plan on the calendar.</p>
        ) : (
          <>
            {schedule.warnings.map((w, i) => (
              <div key={i} className="mt-3 flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm text-warning"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{w}</div>
            ))}
            <div className={cn('mt-4 grid grid-cols-2 gap-3', waterfallSchedule ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
              <ReturnMetric label="Total proceeds" value={fmt(totalProceeds)} detail="Gross, actual and forecast" />
              {waterfallSchedule && <ReturnMetric label="LP distributions" value={fmt(netFinal?.cumDistributed ?? null)} detail="Net of carried interest" />}
              <ReturnMetric label="Carried interest" value={waterfallSchedule ? fmt(totalCarry) : 'Not configured'} detail={waterfallSchedule ? 'Actual and forecast' : 'Add the vehicle waterfall terms'} />
              <ReturnMetric label={waterfallSchedule ? 'Net MOIC' : 'Gross MOIC'} value={multiple(netFinal?.tvpi ?? null)} detail="At fund exit" />
              <ReturnMetric label={netIrr != null ? 'Net IRR' : 'Gross IRR'} value={pctOf(displayedIrr)} detail={displayedIrr == null ? 'Insufficient dated cash flows' : 'Actual and forecast'} />
            </div>
            {/* How the carry was measured, so the figure above can be checked by hand. */}
            {waterfallSchedule && actuals.waterfall && (actuals.waterfall.lpCommitmentShare < 1 || (actuals.waterfall.carryPaidInferred ?? 0) > 0) && (
              <p className="mt-2 text-xs text-muted-foreground">
                {actuals.waterfall.lpCommitmentShare < 1 && <>Carry is charged on the LPs&rsquo; {(actuals.waterfall.lpCommitmentShare * 100).toFixed(1)}% of commitments; the GP&rsquo;s own stake bears none. </>}
                {(actuals.waterfall.carryPaidInferred ?? 0) > 0 && <>The books record no carry paid, so {fmt(actuals.waterfall.carryPaidInferred!)} is taken as already paid on past distributions (the LPs&rsquo; return beyond their capital is the {Math.round((1 - actuals.waterfall.carryRate) * 100)}% left after carry).</>}
              </p>
            )}
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <JCurveChart actual={carryConfigured ? [] : actual} schedule={schedule} simulation={simulation} netOfCarry={carryConfigured} multiple={multiple} />
              <CashFlowChart actual={actualCashFlows} schedule={schedule} simulation={simulation} accounting={accounting} fmt={fmt} fmtFull={fmtFull} />
            </div>
            {simulation ? (
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <OutcomeHistogram simulation={simulation} target={a.simulation.targetMultiple} multiple={multiple} />
                <div className="rounded-card border p-4">
                  <p className="mb-3 text-sm font-medium">{carryConfigured ? 'LP net outcomes' : 'Gross fund outcomes'} at fund exit</p>
                  <table className="w-full text-sm">
                    <thead><tr className="border-b bg-muted/50">
                      {['', 'P10', 'P25', 'P50', 'P75', 'P90'].map((h, i) => <th key={h || 'k'} className={cn('px-3 py-2 font-medium', i === 0 ? 'text-left' : 'text-right')}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {([
                        [carryConfigured ? 'Net multiple' : 'Gross multiple', simulation.final.dpi, multiple],
                      ] as const).map(([label, p, f]) => (
                        <tr key={label} className="border-b last:border-b-0">
                          <td className="px-3 py-1.5">{label}</td>
                          {(['p10', 'p25', 'p50', 'p75', 'p90'] as const).map(k => (
                            <td key={k} className="px-3 py-1.5 text-right tabular-nums">{p ? (f as (v: number | null) => string)(p[k]) : '—'}</td>
                          ))}
                        </tr>
                      ))}
                      {simulation.final.netIrr && (
                        <tr className="border-b last:border-b-0">
                          <td className="px-3 py-1.5">Net IRR</td>
                          {(['p10', 'p25', 'p50', 'p75', 'p90'] as const).map(k => <td key={k} className="px-3 py-1.5 text-right tabular-nums">{pctOf(simulation.final.netIrr?.[k])}</td>)}
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-muted-foreground">The simulation uses {simulation.runs.toLocaleString('en-US')} reproducible runs. The range reflects venture write-offs, power-law outcomes, and exit timing.</p>
                </div>
              </div>
            ) : (
              <p className="mt-6 text-sm text-muted-foreground">Add investments with forecast value to calculate the simulated range of outcomes.</p>
            )}
            <div className="mt-6 flex items-end justify-between gap-4">
              <div><h3 className="font-medium">Deal-by-deal forecast</h3><p className="mt-1 text-xs text-muted-foreground">Investment timing, hold periods, return multiples, and proceeds by investment.</p></div>
              <Button size="sm" variant="outline" onClick={() => setDealsOpen(open => !open)}><Pencil data-icon="inline-start" />{dealsOpen ? 'Close deal-by-deal forecast' : 'Edit deal-by-deal forecast'}</Button>
            </div>
              <div className="mt-2 overflow-hidden rounded-card border bg-card shadow-sm dark:shadow-none">
                <p className="border-b px-3 py-2 text-xs text-muted-foreground">Blank hold periods and return multiples use the fund-wide assumptions. Investment timing must be entered for each planned deal.</p>
                <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead><tr className="border-b bg-muted/50">
                    {['Deal', 'Invest in', 'Hold period', 'Current multiple', 'Forecast multiple', 'Actual proceeds', 'Forecasted proceeds'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-medium', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {schedule.deals.map(d => {
                      const position = d.kind === 'existing' ? model.returns.positions.find(row => row.actual.companyId === d.key)?.forecast : undefined
                      const positionResult = d.kind === 'existing' ? model.returns.positions.find(row => row.actual.companyId === d.key) : undefined
                      const stage = d.kind === 'planned' ? model.returns.stages.find(row => row.key === d.key) : undefined
                      const raw = d.kind === 'existing'
                        ? a.positionForecasts.find(row => row.companyId === d.key)
                        : a.stages.find(row => row.key === d.key)
                      const hasMultipleOverride = raw?.forecastMoicOverride === true || (raw?.forecastMoic ?? 0) > 0
                      return (
                        <tr key={d.key} className="border-b last:border-b-0">
                          <td className="px-3 py-1.5">{d.name}{d.kind === 'planned' && <span className="ml-1 text-xs text-muted-foreground">planned</span>}</td>
                          <td className="px-3 py-1.5 text-right">{stage
                            ? dealsOpen
                              ? <InlineNumber label={`Investment timing for ${d.name}`} value={stage.investInYears} placeholder="Required" suffix="yr" onChange={value => setDeal(d.kind, d.key, { investInYears: value })} />
                              : <span className="tabular-nums">{stage.investInYears == null ? 'Required' : yearOf(stage.investInYears)}</span>
                            : <span className="tabular-nums text-muted-foreground">{d.investmentDate?.slice(0, 4) ?? 'Unknown'}</span>}</td>
                          <td className="px-3 py-1.5 text-right">{dealsOpen
                            ? <InlineNumber label={`Hold period for ${d.name}`} value={raw?.exitInYears} placeholder={String(a.pacing.holdYears)} suffix="yr" onChange={value => setDeal(d.kind, d.key, { exitInYears: value })} />
                            : <span className="tabular-nums">{Number(raw?.exitInYears ?? a.pacing.holdYears).toFixed(1).replace(/\.0$/, '')} yr</span>}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{positionResult ? multiple(positionResult.currentMoic) : '—'}</td>
                          <td className="px-3 py-1.5 text-right">{dealsOpen
                            ? <InlineNumber label={`Return multiple for ${d.name}`} value={hasMultipleOverride ? Number((raw?.forecastMoic ?? 0).toFixed(2)) : null} placeholder={String(a.simulation.defaultExitMultiple)} suffix="x" onChange={value => setDeal(d.kind, d.key, { forecastMoic: value ?? 0, forecastMoicOverride: value != null, returnMethod: 'moic' })} />
                            : <span className="tabular-nums">{multiple(hasMultipleOverride ? raw?.forecastMoic ?? 0 : a.simulation.defaultExitMultiple)}</span>}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums" title={positionResult ? fmtFull(positionResult.actual.distributions) : undefined}>{positionResult ? fmt(positionResult.actual.distributions) : '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums" title={d.proceeds == null ? undefined : fmtFull(d.proceeds)}>{d.proceeds == null ? '—' : fmt(d.proceeds)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
            </div>
            <div className="mt-6 flex items-end justify-between gap-4">
              <div><h3 className="font-medium">Year-by-year forecast</h3><p className="mt-1 text-xs text-muted-foreground">Annual actuals, forecast cash flows, and return multiples.</p></div>
              <Button size="sm" variant="outline" type="button" aria-expanded={yearsOpen} onClick={() => setYearsOpen(open => !open)}>
                {yearsOpen ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                {yearsOpen ? 'Hide annual cash flows' : 'View annual cash flows'}
              </Button>
            </div>
            {yearsOpen && (
              <div className="mt-2 overflow-x-auto rounded-card border bg-card shadow-sm dark:shadow-none">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead><tr className="border-b bg-muted/50">
                    {(accounting
                      ? ['Year', 'Period', 'Called', 'Invested', 'Fees & expenses', ...(waterfallSchedule ? ['Distributed', 'Carried interest'] : []), 'DPI', 'RVPI', 'TVPI']
                      : ['Year', 'Period', 'Invested', 'Fees & expenses', 'Proceeds', ...(waterfallSchedule ? ['Distributions', 'Carried interest'] : []), 'DPI', 'RVPI', 'TVPI'])
                    .map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-medium', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {actualCashFlows.map(y => {
                      const metrics = actualMetricsByYear.get(y.year)
                      const rvpi = metrics?.tvpi != null && metrics.dpi != null ? metrics.tvpi - metrics.dpi : null
                      return (
                      <tr key={`actual-${y.year}`} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5">{y.year}</td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground">Actual</td>
                        {accounting ? <>
                          <MoneyValue value={y.called} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.invested} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.expenses} fmt={fmt} fmtFull={fmtFull} />
                          {waterfallSchedule && <><MoneyValue value={y.lpDistributed} fmt={fmt} fmtFull={fmtFull} /><MoneyValue value={y.carriedInterest} fmt={fmt} fmtFull={fmtFull} /></>}
                        </> : <>
                          <MoneyValue value={y.invested} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.expenses} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.distributed} fmt={fmt} fmtFull={fmtFull} />
                          {waterfallSchedule && <><MoneyValue value={y.lpDistributed} fmt={fmt} fmtFull={fmtFull} /><MoneyValue value={y.carriedInterest} fmt={fmt} fmtFull={fmtFull} /></>}
                        </>}
                        <MultipleValue value={metrics?.dpi ?? null} multiple={multiple} />
                        <MultipleValue value={rvpi} multiple={multiple} />
                        <MultipleValue value={metrics?.tvpi ?? null} multiple={multiple} />
                      </tr>
                      )
                    })}
                    {schedule.years.slice(1).map(y => {
                      const waterfallYear = waterfallSchedule?.years.find(year => year.year === y.year)
                      return (
                      <tr key={`forecast-${y.year}`} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5">{y.calendarYear}</td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground">Forecast</td>
                        {accounting ? <>
                          <MoneyValue value={y.called} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.invested} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.fees + y.expenses} fmt={fmt} fmtFull={fmtFull} />
                          {waterfallSchedule && <><MoneyValue value={waterfallYear?.distributed ?? 0} fmt={fmt} fmtFull={fmtFull} /><MoneyValue value={waterfallYear?.carriedInterest ?? 0} fmt={fmt} fmtFull={fmtFull} /></>}
                        </> : <>
                          <MoneyValue value={y.invested} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.fees + y.expenses} fmt={fmt} fmtFull={fmtFull} />
                          <MoneyValue value={y.distributed} fmt={fmt} fmtFull={fmtFull} />
                          {waterfallSchedule && <><MoneyValue value={waterfallYear?.distributed ?? 0} fmt={fmt} fmtFull={fmtFull} /><MoneyValue value={waterfallYear?.carriedInterest ?? 0} fmt={fmt} fmtFull={fmtFull} /></>}
                        </>}
                        <MultipleValue value={y.dpi} multiple={multiple} />
                        <MultipleValue value={y.rvpi} multiple={multiple} />
                        <MultipleValue value={y.tvpi} multiple={multiple} />
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function decimalYear(iso: string): number {
  const d = new Date(iso + 'T00:00:00Z')
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  const end = Date.UTC(y + 1, 0, 1)
  return y + (d.getTime() - start) / (end - start)
}

function MoneyValue({ value, fmt, fmtFull }: { value: number | null; fmt: Fmt; fmtFull: Fmt }) {
  return <td className="px-3 py-1.5 text-right tabular-nums" title={fmtFull(value)}>{fmt(value)}</td>
}

function MultipleValue({ value, multiple }: { value: number | null; multiple: (v: number | null) => string }) {
  return <td className="px-3 py-1.5 text-right tabular-nums">{multiple(value)}</td>
}

function ReturnMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-card border bg-card p-3 shadow-sm dark:shadow-none"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p><p className="mt-0.5 text-xs text-muted-foreground">{detail}</p></div>
}

function InlineNumber({ label, value, placeholder, suffix, onChange }: { label: string; value: number | null | undefined; placeholder?: string; suffix?: string; onChange: (value: number | null) => void }) {
  return <label className="relative inline-block"><span className="sr-only">{label}</span><Input type="number" min="0" step="0.5" value={value ?? ''} placeholder={placeholder} onChange={event => onChange(event.target.value === '' ? null : Math.max(0, Number(event.target.value)))} className={cn('h-8 w-24 text-right tabular-nums', NO_SPINNERS, suffix && 'pr-7')} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">{suffix}</span>}</label>
}

const NO_SPINNERS = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

function NumField({ label, hint, value, onChange, suffix, step = 'any' }: { label: string; hint: string; value: number; onChange: (v: number) => void; suffix?: string; step?: string }) {
  return (
    <label className="text-xs text-muted-foreground">
      <span className="block">{label}</span>
      <div className="relative mt-1">
        <Input type="number" min="0" step={step} value={value || ''} onChange={e => onChange(Math.max(0, Number(e.target.value)))} className={cn('h-9 tabular-nums', NO_SPINNERS, suffix && 'pr-8')} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">{suffix}</span>}
      </div>
      <span className="mt-0.5 block text-[11px] text-muted-foreground/80">{hint}</span>
    </label>
  )
}

function YearsField(props: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return <NumField {...props} suffix="yrs" step="0.5" />
}
