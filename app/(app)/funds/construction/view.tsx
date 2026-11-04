'use client'

import type { PlanReturnsResponse } from '@/lib/forecast/service'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import type { HeadlinePeriod, PlanCashFlows } from './forecast-charts'
import type { ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, X } from 'lucide-react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { Metric } from '@/components/ui/metric'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SortTh, compareVals, nextSort, type SortState } from '@/components/sortable-th'
import { CapitalUsageChart } from './charts'
import { ForecastSection, InlineNumber, TreatmentField, TREATMENT_HINT } from './forecast-section'
import { cn } from '@/lib/utils'
import type { CapitalActivity, Split } from '@/lib/forecast/capital-activity'
import {
  constructionModel, parseAssumptions, DEFAULT_ASSUMPTIONS, blankStage,
  type ConstructionActuals, type ConstructionAssumptions, type ConstructionPositionForecast,
  type ConstructionStage, type ConstructionResult, type PositionReturn, type StageReturn,
} from '@/lib/accounting/construction'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type ForecastEditor = { kind: 'position'; companyId: string } | { kind: 'stage'; key: string }
type PortfolioSortKey = 'name' | 'initialCheck' | 'currentValue' | 'currentMoic' |
  'realizedProceeds' | 'holdYears' | 'forecastReturn' | 'forecastMoic'

function positionSortValue(row: PositionReturn, key: PortfolioSortKey): string | number | null {
  const { actual } = row
  switch (key) {
    case 'name': return actual.name
    case 'initialCheck': return actual.investedTotal + row.forecast.plannedFollowOn
    case 'currentValue': return row.currentValue
    case 'currentMoic': return row.currentMoic
    case 'holdYears': return row.forecast.exitInYears ?? null
    case 'realizedProceeds': return actual.distributions
    case 'forecastReturn': return row.estimatedReturn
    case 'forecastMoic': return row.estimatedMoic
  }
}

function stageSortValue(row: StageReturn, key: PortfolioSortKey): string | number | null {
  switch (key) {
    case 'name': return row.label
    case 'initialCheck': return row.allocation
    case 'currentValue': return null
    case 'currentMoic': return null
    case 'holdYears': return row.exitInYears ?? null
    case 'realizedProceeds': return null
    case 'forecastReturn': return row.estimatedReturn
    case 'forecastMoic': return row.estimatedMoic
  }
}

function sortedRows<T>(rows: T[], sort: SortState | null, value: (row: T, key: PortfolioSortKey) => string | number | null): T[] {
  if (!sort) return rows
  return rows.map((row, index) => ({ row, index })).sort((a, b) =>
    compareVals(value(a.row, sort.key as PortfolioSortKey), value(b.row, sort.key as PortfolioSortKey), sort.dir) || a.index - b.index,
  ).map(({ row }) => row)
}

/** Expense forecasts run through the latest modeled portfolio exit, never beyond ten years. */
function returnForecastYears(actuals: ConstructionActuals, assumptions: ConstructionAssumptions): number {
  const now = Date.now()
  const yearMs = 365.2425 * 24 * 60 * 60 * 1000
  const forecasts = new Map(assumptions.positionForecasts.map(forecast => [forecast.companyId, forecast]))
  let latestExit = 0
  for (const position of actuals.positions ?? []) {
    if (position.status === 'exited') continue
    const forecast = forecasts.get(position.companyId)
    const hold = forecast?.exitInYears ?? assumptions.pacing.holdYears
    const investmentTime = position.firstInvestmentDate
      ? (Date.parse(`${position.firstInvestmentDate}T00:00:00Z`) - now) / yearMs
      : 0
    latestExit = Math.max(latestExit, investmentTime + Math.max(0, hold))
  }
  for (const stage of assumptions.stages) {
    if (stage.investInYears == null || !Number.isFinite(stage.investInYears)) continue
    latestExit = Math.max(latestExit, Math.max(0, stage.investInYears) + Math.max(0, stage.exitInYears ?? assumptions.pacing.holdYears))
  }
  const fallback = assumptions.pacing.holdYears > 0 ? assumptions.pacing.holdYears : 1
  return Math.min(10, Math.max(1, Math.ceil(latestExit || fallback)))
}

/**
 * The Forecast page's Portfolio tab (plans/plan-unified-plan.md §5): the selected plan's portfolio
 * construction — deals, timing, reserves, exits. `planId` names the plan (else the entity's primary);
 * `onSaved` tells the page its fund forecast is now out of date.
 */
export type ConstructionSection = 'investments' | 'capital'

export function ConstructionView({ vehicle, planId: planParam, readOnly, onSaved, section, addInvestment, planReturns, rangeFlows, chartsSlot, usageSlot, outcomesSlot, headline, assumptionsOpen, onAssumptionsClose, quietLoading }: {
  /** The page shows one loading state of its own: while it does, this shows none. */
  quietLoading?: boolean
  assumptionsOpen?: boolean
  onAssumptionsClose?: () => void
  /** The Forecast page's periods and date range, for the headline charts. */
  headline?: { periods: HeadlinePeriod[]; years: { first: number; last: number } } | null
  /** Where the headline charts render (above the Forecast page's tabs). */
  chartsSlot?: HTMLElement | null
  /** Bumped by the Forecast page's Add Investment button: add a planned deal and open it. */
  addInvestment?: number
  /** The plan's returns (with the simulation), fetched once by the Forecast page. */
  planReturns?: PlanReturnsResponse | null
  /** The page's date range, as cash by line (actual / forecast): Capital planning shows that range. */
  rangeFlows?: RangeFlows | null
  /** Where Committed capital usage and the outcome histogram render (the Charts tab). */
  usageSlot?: HTMLElement | null
  outcomesSlot?: HTMLElement | null
  /** Which part to show — one per Forecast tab; the view stays mounted so edits carry across. */
  section: ConstructionSection
  vehicle: string
  planId?: string | null
  /** A published version: shown, not edited. */
  readOnly?: boolean
  onSaved?: () => void
}) {
  const currency = useCurrency()
  const fmt = (v: number | null) => (v == null ? '—' : formatCurrency(v, currency))
  const fmtFull = (v: number | null) => (v == null ? '—' : formatCurrencyFull(v, currency))
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)
  const multiple = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)

  const [actuals, setActuals] = useState<ConstructionActuals | null>(null)
  const [a, setA] = useState<ConstructionAssumptions>(DEFAULT_ASSUMPTIONS)
  const [persisted, setPersisted] = useState('')
  // The plan this construction belongs to, and its returns (lib/forecast/plan-returns.ts) — the
  // yearly calls, distributions and carry as the fund forecast works them out, reloaded after a save.
  const [planId, setPlanId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [forecastEditor, setForecastEditor] = useState<ForecastEditor | null>(null)
  const g = `group=${encodeURIComponent(vehicle)}${planParam ? `&plan=${encodeURIComponent(planParam)}` : ''}`

  useEffect(() => {
    let cancelled = false
    setLoading(true); setLoadError(null)
    fetch(`/api/accounting/construction?${g}`)
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok) throw new Error(d?.error || 'Could not load the construction model.')
        return d
      })
      .then(d => {
        if (cancelled) return
        const assumptions = parseAssumptions(d.assumptions, null)
        setActuals(d.actuals); setPlanId(d.plan?.id ?? null); setA(assumptions); setPersisted(JSON.stringify(assumptions)); setSaveState('idle'); setSaveError(null)
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load the construction model.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [g])

  // The plan's returns, fetched once by the Forecast page: the yearly calls and the simulated range.
  const planFlows = useMemo<PlanCashFlows | null>(() => planReturns?.base ? {
    years: planReturns.base.years,
    band: planReturns.simulation?.distributedByYear ?? null,
    bandByMonth: planReturns.simulation?.distributedByMonth ?? null,
  } : null, [planReturns])

  useEffect(() => {
    if (loading || !actuals || readOnly) return
    const serialized = JSON.stringify(a)
    if (serialized === persisted) return
    const t = setTimeout(() => {
      setSaveState('saving'); setSaveError(null)
      fetch(`/api/accounting/construction?${g}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: serialized,
      }).then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok) throw new Error(d?.error || 'Could not save the construction model.')
        setPersisted(JSON.stringify(parseAssumptions(d.assumptions, null))); setSaveState('saved'); setSaveError(null); onSaved?.()
      }).catch(error => {
        setSaveState('error')
        setSaveError(error instanceof Error ? error.message : 'Could not save changes.')
      })
    }, 600)
    return () => clearTimeout(t)
  }, [a, actuals, g, loading, persisted])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timeout = window.setTimeout(() => setSaveState('idle'), 2500)
    return () => window.clearTimeout(timeout)
  }, [saveState])

  const modeledA = useMemo(() => actuals ? { ...a, feeTermYears: returnForecastYears(actuals, a) } : a, [actuals, a])
  const model = useMemo(() => (actuals ? constructionModel(actuals, modeledA) : null), [actuals, modeledA])
  const sortedPositions = useMemo(() => sortedRows(model?.returns.positions ?? [], sort, positionSortValue), [model, sort])
  const sortedStages = useMemo(() => sortedRows(model?.returns.stages ?? [], sort, stageSortValue), [model, sort])
  const setStage = useCallback((key: string, patch: Partial<ConstructionStage>) => {
    setA(prev => ({ ...prev, stages: prev.stages.map(s => s.key === key ? { ...s, ...patch } : s) }))
  }, [])
  const addStage = useCallback(() => {
    const stage = blankStage('New investment')
    setA(prev => ({ ...prev, stages: [...prev.stages, stage] }))
    setForecastEditor({ kind: 'stage', key: stage.key })
  }, [])
  const lastAdd = useRef(addInvestment ?? 0)
  useEffect(() => {
    if (!addInvestment || addInvestment === lastAdd.current || !model) return
    lastAdd.current = addInvestment
    addStage()
  }, [addInvestment, addStage, model])
  const removeStage = useCallback((key: string) => setA(prev => ({ ...prev, stages: prev.stages.filter(s => s.key !== key) })), [])
  const setPositionForecast = useCallback((companyId: string, patch: Partial<ConstructionPositionForecast>) => {
    setA(prev => {
      const actual = actuals?.positions?.find(p => p.companyId === companyId)
      const current = prev.positionForecasts.find(f => f.companyId === companyId) ?? {
        companyId, plannedFollowOn: 0, ownershipAtExit: actual?.currentOwnership ?? 0,
        additionalDilution: 0, expectedExitValue: 0, forecastMoic: 0, returnMethod: 'moic' as const,
      }
      return { ...prev, positionForecasts: [...prev.positionForecasts.filter(f => f.companyId !== companyId), { ...current, ...patch }] }
    })
  }, [actuals])
  const editingPosition = forecastEditor?.kind === 'position'
    ? model?.returns.positions.find(row => row.actual.companyId === forecastEditor.companyId) ?? null
    : null
  const editingStage = forecastEditor?.kind === 'stage'
    ? model?.returns.stages.find(row => row.key === forecastEditor.key) ?? null
    : null

  // Each deal's share of the forecasted proceeds (the footer's total), and whether a multiple was set
  // for it rather than taken from the fund default.
  const forecastTotal = model?.returns.estimatedPortfolioValue ?? 0
  const shareOf = (v: number | null) => (v == null || forecastTotal <= 0 ? '—' : `${Math.round((v / forecastTotal) * 1000) / 10}%`)
  const hasMoicOverride = (f: { forecastMoicOverride?: boolean; forecastMoic?: number }) => f.forecastMoicOverride === true || (f.forecastMoic ?? 0) > 0

  const body = loading ? (quietLoading ? null :
    <div className="rounded-card border bg-card p-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading construction model…</div>
  ) : loadError ? <EmptyState>{loadError}</EmptyState>
    : !model || !actuals || actuals.committedCapital <= 0 ? <EmptyState>No construction model for {vehicle}. It needs recorded commitments to plan against.</EmptyState>
    : (
      <div className="space-y-6">
        {section === 'investments' && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <Metric label="Invested capital" value={fmt(model.capital.deployedTotal)} />
          <Metric label="Uncalled capital" value={fmt(model.capital.uncalledCapital)} />
          <Metric label="Portfolio" value={`${model.capital.companyCount}`} />
          <Metric label="Gross MOIC today" value={multiple(model.returns.actualGrossMoic)} />
          <Metric label="Gross NAV" value={fmt(model.returns.currentPortfolioValue)} />
        </div>

        {model.warnings.filter(w => !w.startsWith('Fees and expenses are not on the ledger')).map((w, i) => <div key={i} className="flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm text-warning"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{w}</div>)}

        <section>
          <div className="overflow-hidden rounded-card border bg-card shadow-sm dark:shadow-none dark:border">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead><tr className="border-b bg-muted/50">
                <SortTh label="Investment" sortKey="name" sort={sort} onSort={key => setSort(s => nextSort(s, key, 'asc'))} />
                {([
                  ['Total invested capital', 'initialCheck'], ['Current value', 'currentValue'], ['Current MOIC', 'currentMoic'],
                  ['Hold period', 'holdYears'], ['Forecast multiple', 'forecastMoic'], ['Realized proceeds', 'realizedProceeds'],
                  ['Forecasted proceeds', 'forecastReturn'], ['% of forecasted proceeds', 'forecastReturn'],
                ] as [string, PortfolioSortKey][]).map(([label, key], i) => <SortTh key={`${key}-${i}`} label={label} sortKey={key} sort={sort} onSort={key => setSort(s => nextSort(s, key))} align="right" />)}
              </tr></thead>
              <tbody>
                {model.returns.positions.length === 0
                  ? <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No portfolio investments are recorded for this vehicle.</td></tr>
                  : sortedPositions.map(row => {
                    const { actual } = row
                    return <tr key={actual.companyId} className="group border-b hover:bg-muted/20">
                      <td className="px-3 py-2"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><Link href={`/companies/${actual.companyId}`} className="min-w-0 truncate hover:underline" title={actual.name}>{actual.name}</Link>{actual.status === 'exited' ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Exited</span> : <button type="button" title="Edit forecast" aria-label={`Edit forecast for ${actual.name}`} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100" onClick={() => setForecastEditor({ kind: 'position', companyId: actual.companyId })}><Pencil className="h-3.5 w-3.5" /></button>}</div></td>
                      <MoneyCell full={fmtFull(actual.investedTotal + row.forecast.plannedFollowOn)}>{fmt(actual.investedTotal + row.forecast.plannedFollowOn)}</MoneyCell>
                      <MoneyCell full={fmtFull(row.currentValue)}>{fmt(row.currentValue)}</MoneyCell>
                      <td className="px-3 py-2 text-right tabular-nums">{multiple(row.currentMoic)}</td>
                      {actual.status === 'exited' ? <><td className="px-3 py-2 text-right text-muted-foreground">—</td><td className="px-3 py-2 text-right text-muted-foreground">—</td></> : <>
                        <td className="px-3 py-1 text-right"><InlineNumber label={`Hold period for ${actual.name}`} value={row.forecast.exitInYears ?? null} placeholder={String(a.pacing.holdYears)} suffix="yr" onChange={v => setPositionForecast(actual.companyId, { exitInYears: v })} /></td>
                        <td className="px-3 py-1 text-right"><InlineNumber label={`Forecast multiple for ${actual.name}`} value={hasMoicOverride(row.forecast) ? Number((row.forecast.forecastMoic ?? 0).toFixed(2)) : null} placeholder={String(a.simulation.defaultExitMultiple)} suffix="x" onChange={v => setPositionForecast(actual.companyId, { forecastMoic: v ?? 0, forecastMoicOverride: v != null, returnMethod: 'moic' })} /></td>
                      </>}
                      <MoneyCell full={fmtFull(actual.distributions)}>{fmt(actual.distributions)}</MoneyCell>
                      <MoneyCell full={fmtFull(row.estimatedReturn)}>{fmt(row.estimatedReturn)}</MoneyCell>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{shareOf(row.estimatedReturn)}</td>
                    </tr>
                  })}

                {sortedStages.map(stage => <tr key={stage.key} className="group border-b hover:bg-muted/20">
                    <td className="px-3 py-2"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 truncate" title={stage.label || 'New investment'}>{stage.label || 'New investment'}</span><button type="button" title="Edit forecast" aria-label={`Edit forecast for ${stage.label || 'new investment'}`} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100" onClick={() => setForecastEditor({ kind: 'stage', key: stage.key })}><Pencil className="h-3.5 w-3.5" /></button></div></td>
                    <MoneyCell full={fmtFull(stage.allocation)}>{fmt(stage.allocation)}</MoneyCell>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-1 text-right"><InlineNumber label={`Hold period for ${stage.label || 'new investment'}`} value={a.stages.find(s => s.key === stage.key)?.exitInYears ?? null} placeholder={String(a.pacing.holdYears)} suffix="yr" onChange={v => setStage(stage.key, { exitInYears: v })} /></td>
                    <td className="px-3 py-1 text-right"><InlineNumber label={`Forecast multiple for ${stage.label || 'new investment'}`} value={(() => { const raw = a.stages.find(s => s.key === stage.key); return raw && hasMoicOverride(raw) ? Number((raw.forecastMoic ?? 0).toFixed(2)) : null })()} placeholder={String(a.simulation.defaultExitMultiple)} suffix="x" onChange={v => setStage(stage.key, { forecastMoic: v ?? 0, forecastMoicOverride: v != null, returnMethod: 'moic' })} /></td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <MoneyCell full={fmtFull(stage.estimatedReturn)}>{fmt(stage.estimatedReturn)}</MoneyCell>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{shareOf(stage.estimatedReturn)}</td>
                  </tr>)}
              </tbody>
              <tfoot><tr className="bg-muted/40 font-semibold">
                <td className="bg-muted px-3 py-2.5">Projected portfolio</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.capital.deployedTotal + model.capital.plannedCost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.currentPortfolioValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{multiple(model.returns.actualGrossMoic)}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums">{multiple(model.returns.estimatedGrossMoic)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.positions.reduce((sum, row) => sum + row.actual.distributions, 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.estimatedPortfolioValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{forecastTotal > 0 ? '100%' : '—'}</td>
              </tr></tfoot>
            </table>
          </div>
          </div>
        </section>

        </>}

        {section === 'capital' && <section>
          <div>
          <div className="min-w-0">
          <CapitalPlanningTable capital={model.capital} range={rangeFlows ?? null} planYears={planFlows?.years ?? null} fmt={fmt} fmtFull={fmtFull} />
          {model.warnings.filter(w => w.startsWith('Fees and expenses are not on the ledger')).map(w => (
            <div key={w} className="mt-3 flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</div>
          ))}
          </div>
          </div>
        </section>}

        {/* Committed capital usage lives on the Forecast page's Charts tab. */}
        {usageSlot && createPortal(<CapitalUsageChart model={model} calledKnown={actuals.capitalAvailable === true || (actuals.calledCapital ?? 0) > 0} fmt={fmt} fmtFull={fmtFull} />, usageSlot)}
        {<ForecastSection outcomesSlot={outcomesSlot} assumptionsOpen={assumptionsOpen} onAssumptionsClose={onAssumptionsClose} headline={headline} chartsSlot={chartsSlot} model={model} actuals={actuals} a={modeledA} setA={setA} vehicle={vehicle} fmt={fmt} fmtFull={fmtFull} multiple={multiple} planFlows={planFlows} />}
        <div className="flex min-h-5 justify-end"><SaveIndicator state={saveState} error={saveError} /></div>
        {(editingPosition || editingStage) && <ForecastEditorDialog
          position={editingPosition}
          stage={editingStage}
          a={a}
          fmt={fmt}
          multiple={multiple}
          onClose={() => setForecastEditor(null)}
          onPositionChange={patch => editingPosition && setPositionForecast(editingPosition.actual.companyId, patch)}
          onStageChange={patch => editingStage && setStage(editingStage.key, patch)}
          onRemoveStage={editingStage ? () => { removeStage(editingStage.key); setForecastEditor(null) } : undefined}
        />}
      </div>
    )

  return <div className="w-full">{body}</div>
}

function ForecastEditorDialog({
  position, stage, a, fmt, multiple, onClose, onPositionChange, onStageChange, onRemoveStage,
}: {
  position: PositionReturn | null; stage: StageReturn | null
  a: ConstructionAssumptions
  fmt: (v: number | null) => string; multiple: (v: number | null) => string
  onClose: () => void; onPositionChange: (patch: Partial<ConstructionPositionForecast>) => void
  onStageChange: (patch: Partial<ConstructionStage>) => void; onRemoveStage?: () => void
}) {
  const name = position?.actual.name ?? stage?.label ?? 'Investment forecast'
  const forecast = position?.forecast
  const postMoney = position?.actual.currentPostMoney ?? stage?.initialPostMoney ?? null
  const currentOwnership = position?.actual.currentOwnership ?? stage?.initialOwnership ?? null
  const currentMoic = position?.currentMoic ?? stage?.currentMoic ?? null
  const forecastedProceeds = position?.estimatedReturn ?? stage?.estimatedReturn ?? null
  const forecastedMoic = position?.estimatedMoic ?? stage?.estimatedMoic ?? null
  // Per-deal timing overrides. Empty = the fund-wide setting, shown as the placeholder.
  const timing = position?.forecast ?? stage
  const pacingPlaceholder = (v: number) => (v > 0 ? String(v) : 'fund')
  const setDeal = (patch: Partial<ConstructionPositionForecast> & Partial<ConstructionStage>) => position
    ? onPositionChange(patch as Partial<ConstructionPositionForecast>)
    : onStageChange(patch as Partial<ConstructionStage>)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>Edit this investment and return forecast. Changes save automatically.</DialogDescription>
      </DialogHeader>

      {stage && <label className="text-xs text-muted-foreground">Forecast name<Input value={stage.label} onChange={e => onStageChange({ label: e.target.value })} placeholder="Company or plan name" className="mt-1 h-9" /></label>}

      <div className="space-y-3 rounded-md border p-4">
        <div><h3 className="text-base font-medium">Current position</h3><p className="mt-0.5 text-xs text-muted-foreground">The latest position data used as the starting point for this forecast.</p></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ForecastStat label="Post-money valuation" value={fmt(postMoney)} />
          <ForecastStat label="Current ownership" value={currentOwnership == null ? '—' : `${(currentOwnership * 100).toFixed(2)}%`} />
          <ForecastStat label="Current value" value={fmt(position?.currentValue ?? stage?.currentValue ?? null)} />
          <ForecastStat label="Current MOIC" value={multiple(currentMoic)} />
        </div>
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <div><h3 className="text-base font-medium">Investment forecast</h3><p className="mt-0.5 text-xs text-muted-foreground">Capital that is still expected to be invested.</p></div>
        {position && <div className="rounded-md bg-muted/40 px-3 py-2"><p className="text-xs text-muted-foreground">Already invested</p><p className="mt-0.5 font-medium tabular-nums">{fmt(position.actual.investedTotal)}</p></div>}
        {position && <NumberField label="Additional follow-on investment" value={forecast?.plannedFollowOn ?? 0} onChange={v => onPositionChange({ plannedFollowOn: v })} />}
        {stage && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField label="Initial investment" value={stage.initialCheck} onChange={v => onStageChange({ initialCheck: v })} />
          <NumberField label="Follow-on investment" value={stage.plannedFollowOn} onChange={v => onStageChange({ followOnCheck: v })} />
          <NumberField label="Entry post-money valuation" value={stage.initialPostMoney} onChange={v => onStageChange({ initialPostMoney: v })} />
        </div>}
      </div>

      {/* When: the check (a planned deal) and the exit. Blank hold uses the fund-wide one. */}
      <div className="space-y-3 rounded-md border p-4">
        <div><h3 className="text-base font-medium">Timing</h3></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {stage && (
            <OptionalNumberField
              label="Invest in"
              hint="Years from today the first check is written"
              value={stage.investInYears ?? null}
              placeholder="Required"
              suffix="yr"
              step="0.25"
              onChange={v => onStageChange({ investInYears: v })}
            />
          )}
          <OptionalNumberField
            label="Hold period"
            hint={`Years from the first investment to the exit · fund default ${a.pacing.holdYears} yr`}
            value={(stage ? a.stages.find(s => s.key === stage.key)?.exitInYears : forecast?.exitInYears) ?? null}
            placeholder={String(a.pacing.holdYears)}
            suffix="yr"
            step="0.5"
            onChange={v => position ? onPositionChange({ exitInYears: v }) : onStageChange({ exitInYears: v })}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <div><h3 className="text-base font-medium">Return forecast</h3><p className="mt-0.5 text-xs text-muted-foreground">Override the fund-wide default only when this company has a more specific underwriting case.</p></div>
        <OptionalNumberField
          label="Gross MOIC override"
          hint={`Fund default ${a.simulation.defaultExitMultiple.toFixed(1)}x`}
          value={(forecast?.forecastMoicOverride === true || stage?.forecastMoicOverride === true || (forecast?.forecastMoic ?? stage?.forecastMoic ?? 0) > 0) ? forecast?.forecastMoic ?? stage?.forecastMoic ?? 0 : null}
          placeholder={String(a.simulation.defaultExitMultiple)}
          suffix="x"
          step="0.1"
          onChange={v => position
            ? onPositionChange({ forecastMoic: v ?? 0, forecastMoicOverride: v != null, returnMethod: 'moic' })
            : onStageChange({ forecastMoic: v ?? 0, forecastMoicOverride: v != null, returnMethod: 'moic' })}
        />
        <div className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-3">
          <ForecastStat label="Forecasted proceeds at exit" value={fmt(forecastedProceeds)} emphasis />
          <ForecastStat label="Current MOIC" value={multiple(currentMoic)} />
          <ForecastStat label="Forecasted MOIC" value={multiple(forecastedMoic)} emphasis />
        </div>
      </div>

      {(a.pacing.recycleCapRate ?? 0) > 0 && (
        <div className="space-y-3 rounded-md border p-4">
          <div><h3 className="text-base font-medium">Recycling</h3><p className="mt-0.5 text-xs text-muted-foreground">How much of this exit pays for later investments instead of being distributed. Blank recycles automatically, within the fund&apos;s cap; 0 keeps it all out.</p></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <OptionalNumberField label="Recycle up to" hint="Of this exit's proceeds" value={timing?.recycleAmount} placeholder="Automatic" step="1000" onChange={v => setDeal({ recycleAmount: v })} />
            <TreatmentField label="Treatment" hint={TREATMENT_HINT} value={timing?.recycleTreatment ?? null} inherit={`Fund default (${(a.pacing.recycleTreatment ?? 'retained') === 'deemed' ? 'distributed and recontributed' : 'never distributed'})`} onChange={v => setDeal({ recycleTreatment: v })} />
          </div>
        </div>
      )}

      <div className="space-y-3 rounded-md border p-4">
        <div><h3 className="text-base font-medium">Investment timing and hold period</h3><p className="mt-0.5 text-xs text-muted-foreground">Investment and reserved follow-on timing are entered per deal. Hold period can use the fund-wide assumption.</p></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {stage && <OptionalNumberField label="Invest in" hint="Years from today" value={stage.investInYears} placeholder="Required" suffix="yrs" step="0.5" onChange={v => onStageChange({ investInYears: v })} />}
          <OptionalNumberField label="Hold period" hint="Years from investment to exit" value={timing?.exitInYears} placeholder={pacingPlaceholder(a.pacing.holdYears)} suffix="yrs" step="0.5" onChange={v => setDeal({ exitInYears: v })} />
          {(forecast?.plannedFollowOn ?? stage?.plannedFollowOn ?? 0) > 0 && <OptionalNumberField label={position ? 'Follow-on in' : 'Follow-on after check'} hint={position ? 'Years from today' : 'Years after the initial check'} value={timing?.followOnInYears} placeholder="Required" suffix="yrs" step="0.5" onChange={v => setDeal({ followOnInYears: v })} />}
        </div>
      </div>

      <DialogFooter className="sm:justify-between">
        {onRemoveStage ? <Button type="button" variant="outline" onClick={onRemoveStage} className="text-destructive hover:text-destructive"><X className="h-4 w-4" />Remove forecast</Button> : <span />}
        <Button type="button" onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
function ForecastStat({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className="min-w-0 rounded-md bg-muted/40 px-3 py-2"><p className="text-xs leading-tight text-muted-foreground">{label}</p><p className={cn('mt-1 truncate tabular-nums', emphasis ? 'font-semibold' : 'font-medium')} title={value}>{value}</p></div>
}
function MoneyCell({ children, full }: { children: ReactNode; full: string }) { return <td className="px-3 py-2 text-right tabular-nums" title={full}>{children}</td> }
const NO_NUMBER_SPINNERS = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
function NumberField({ label, value, onChange, step = 'any', suffix, hideLabel = false }: { label: string; value: number; onChange: (v: number) => void; step?: string; suffix?: string; hideLabel?: boolean }) {
  return <label className="text-xs text-muted-foreground"><span className={hideLabel ? 'sr-only' : undefined}>{label}</span><div className={cn('relative', !hideLabel && 'mt-1')}><Input type="number" min="0" step={step} value={value || ''} onChange={e => onChange(Math.max(0, Number(e.target.value)))} className={cn('h-9 tabular-nums', NO_NUMBER_SPINNERS, suffix && 'pr-7')} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">{suffix}</span>}</div></label>
}
/** A number the deal may state or leave to the fund: empty is null, never zero, so the fund-wide value applies. */
function OptionalNumberField({ label, hint, value, placeholder, onChange, step = 'any', suffix }: {
  label: string; hint?: string; value: number | null | undefined; placeholder?: string; onChange: (v: number | null) => void; step?: string; suffix?: string
}) {
  return <label className="text-xs text-muted-foreground"><span>{label}</span>{hint && <span className="ml-1 text-muted-foreground/70">· {hint}</span>}<div className="relative mt-1"><Input type="number" min="0" step={step} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))} className={cn('h-9 tabular-nums', NO_NUMBER_SPINNERS, suffix && 'pr-7')} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">{suffix}</span>}</div></label>
}
function PercentField({ label, value, onChange, hideLabel = false }: { label: string; value: number; onChange: (v: number) => void; hideLabel?: boolean }) {
  return <label className="text-xs text-muted-foreground"><span className={hideLabel ? 'sr-only' : undefined}>{label}</span><div className={cn('relative', !hideLabel && 'mt-1')}><Input type="number" min="0" step="0.1" value={value ? Number((value * 100).toFixed(4)) : ''} onChange={e => onChange(Math.max(0, Number(e.target.value)) / 100)} className={cn('h-9 pr-7 tabular-nums', NO_NUMBER_SPINNERS)} /><span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs">%</span></div></label>
}
function SaveIndicator({ state, error }: { state: SaveState; error?: string | null }) {
  if (state === 'saving') return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving…</span>
  if (state === 'saved') return <span className="flex items-center gap-1.5 text-xs text-success"><Check className="h-3.5 w-3.5" />Saved</span>
  if (state === 'error') return <span className="max-w-sm text-right text-sm text-destructive">{error || 'Could not save changes.'}</span>
  return null
}

/**
 * Capital planning on one row per line: what has happened (Actual — called, invested, paid), what
 * the plan still has to come (Forecast), and the two together, against the commitment. Over the life
 * of the plan the Actual column is cash: a fee paid up front counts as paid. Over a date range it is
 * what the books record in those months (lib/forecast/capital-activity.ts).
 */
export type { Split }
export type RangeFlows = CapitalActivity & { label: string }

function CapitalPlanningTable({ capital: c, range, planYears, fmt, fmtFull }: {
  capital: ConstructionResult['capital']
  /** The page's date range; without it, the life of the plan. */
  range: RangeFlows | null
  /** The plan's calls by calendar year (lib/forecast/plan-returns.ts), for the calls still to come. */
  planYears: { calendarYear: number; called: number }[] | null
  fmt: (v: number | null) => string
  fmtFull: (v: number | null) => string
}) {
  const committed = c.committedCapital
  const pct = (v: number | null) => (v == null || committed <= 0 ? '' : `${((v / committed) * 100).toFixed(1)}%`)
  const callsToCome = planYears ? planYears.reduce((s, y) => s + y.called, 0) : null
  const lastCall = planYears?.filter(y => y.called > 0.5).at(-1)?.calendarYear ?? null
  const total = (x: Split) => x.actual + x.forecast
  // What is left to put to work: every dollar committed (what is not yet called is assumed called)
  // plus proceeds recycled, less every fee, expense and investment, actual and forecast. Over a
  // range these are the range's own figures, so on the fund's lifetime it is the whole fund.
  const unallocated = range
    ? committed + total(range.recycled) - total(range.fees) - total(range.org) - total(range.partnership) - total(range.invested)
    : c.remaining - c.plannedCost
  type Line = { label: string; note?: string; actual?: number | null; forecast?: number | null; total?: number | null; strong?: boolean; warn?: boolean }
  const sum = (a?: number | null, b?: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0))
  const split = (x: Split, strong?: boolean): Pick<Line, 'actual' | 'forecast' | 'total' | 'strong'> => ({ actual: x.actual, forecast: x.forecast, total: x.actual + x.forecast, strong })
  const groups: { title: string; lines: Line[] }[] = range ? [
    { title: 'Capital', lines: [
      { label: 'Committed capital', total: committed, strong: true },
      { label: 'Capital called', ...split(range.called) },
      { label: 'Uncalled capital', note: 'at the end of the range', actual: c.uncalledCapital, forecast: -range.called.forecast, total: c.uncalledCapital - range.called.forecast },
      { label: 'Distributions', ...split(range.distributed) },
      { label: 'Recycled capital', note: 'proceeds put back to work', ...split(range.recycled) },
    ] },
    { title: 'Fees and expenses', lines: [
      { label: 'Management fees', ...split(range.fees) },
      { label: 'Organizational expenses', ...split(range.org) },
      { label: 'Partnership expenses', ...split(range.partnership) },
      { label: 'Total fees and expenses', ...split({ actual: range.fees.actual + range.org.actual + range.partnership.actual, forecast: range.fees.forecast + range.org.forecast + range.partnership.forecast }, true) },
    ] },
    { title: 'Investments', lines: [
      { label: 'Invested capital', ...split(range.invested, true) },
      { label: unallocated < 0 ? 'Over-committed' : 'Not yet allocated', note: 'committed + recycled − fees, expenses and investments', total: unallocated, strong: true, warn: unallocated < 0 },
    ] },
  ] : [
    { title: 'Capital', lines: [
      { label: 'Committed capital', total: committed, strong: true },
      { label: 'Capital called', note: lastCall ? `last call ${lastCall}` : undefined, actual: c.calledCapital, forecast: callsToCome, total: sum(c.calledCapital, callsToCome) },
      { label: 'Uncalled capital', actual: c.uncalledCapital, forecast: callsToCome == null ? null : -callsToCome, total: callsToCome == null ? c.uncalledCapital : c.uncalledCapital - callsToCome },
    ] },
    { title: 'Fees and expenses', lines: [
      { label: 'Management fees', actual: c.feesIncurred, forecast: c.feesProjected, total: c.feesIncurred + c.feesProjected },
      { label: 'Organizational expenses', actual: c.orgCostsIncurred, forecast: c.orgCostsProjected, total: c.orgCostsIncurred + c.orgCostsProjected },
      { label: 'Partnership expenses', actual: c.expensesIncurred, forecast: c.expensesProjected, total: c.expensesIncurred + c.expensesProjected },
      { label: 'Total fees and expenses', actual: c.incurredExpenses, forecast: c.projectedExpenses, total: c.totalExpenses, strong: true },
    ] },
    { title: 'Investments', lines: [
      { label: 'New investments', actual: c.deployedInitial, forecast: c.plannedNewCapital, total: c.deployedInitial + c.plannedNewCapital },
      { label: 'Follow-on investments', actual: c.deployedFollowOn, forecast: c.plannedExistingFollowOn + c.plannedNewFollowOn, total: c.deployedFollowOn + c.plannedExistingFollowOn + c.plannedNewFollowOn },
      { label: 'Invested capital', actual: c.deployedTotal, forecast: c.plannedCost, total: c.deployedTotal + c.plannedCost, strong: true },
      { label: unallocated < 0 ? 'Over-committed' : 'Not yet allocated', total: unallocated, strong: true, warn: unallocated < 0 },
    ] },
  ]
  // A line with nothing in it for this vehicle — no actual, no forecast, no total — is left out.
  const hasFigures = (l: Line) => [l.actual, l.forecast, l.total].some(v => v != null && Math.abs(v) >= 0.5)
  const cell = (v: number | null | undefined, cls = '') => (
    <td className={cn('px-3 py-2 text-right tabular-nums', cls)} title={v == null ? undefined : fmtFull(v)}>{v == null ? '' : fmt(v)}</td>
  )
  return (
    <div className="overflow-x-auto rounded-card border bg-card shadow-sm dark:shadow-none dark:border">
      <table className="w-full whitespace-nowrap text-sm">
        <thead><tr className="border-b bg-muted/50">
          <th className="px-3 py-2 text-left font-medium">Capital planning{range && <span className="ml-2 text-xs font-normal text-muted-foreground">{range.label}</span>}</th>
          <th className="px-3 py-2 text-right font-medium">Actual</th>
          <th className="px-3 py-2 text-right font-medium">Forecast</th>
          <th className="px-3 py-2 text-right font-medium">Total</th>
          <th className="w-28 px-3 py-2 text-right font-medium">% committed</th>
        </tr></thead>
        <tbody>
          {groups.map(g => ({ ...g, lines: g.lines.filter(hasFigures) })).filter(g => g.lines.length > 0).map(g => (
            <Fragment key={g.title}>
              <tr className="border-b"><td colSpan={5} className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.title}</td></tr>
              {g.lines.map(l => (
                <tr key={l.label} className={cn('border-b last:border-b-0', l.strong && 'font-medium')}>
                  <td className={cn('px-3 py-2', l.warn && 'text-destructive')}>
                    {l.label}{l.note && <span className="ml-2 text-xs font-normal text-muted-foreground">{l.note}</span>}
                  </td>
                  {cell(l.actual)}
                  {cell(l.forecast)}
                  {cell(l.total, l.warn ? 'text-destructive' : '')}
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(l.total ?? null)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
