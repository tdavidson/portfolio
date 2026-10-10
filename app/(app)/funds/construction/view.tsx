'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, X } from 'lucide-react'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useVehicle, FundSwitcher } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { Metric } from '@/components/ui/metric'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SortTh, compareVals, nextSort, type SortState } from '@/components/sortable-th'
import { CapitalUsageChart, ValueSourcesChart } from './charts'
import { ForecastSection } from './forecast-section'
import { cn } from '@/lib/utils'
import {
  constructionModel, parseAssumptions, DEFAULT_ASSUMPTIONS, blankStage,
  type ConstructionActuals, type ConstructionAssumptions, type ConstructionPositionForecast,
  type ConstructionStage, type PositionReturn, type StageReturn,
} from '@/lib/accounting/construction'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type ForecastEditor = { kind: 'position'; companyId: string } | { kind: 'stage'; key: string }
type PortfolioSortKey = 'name' | 'initialCheck' | 'currentValue' |
  'realizedProceeds' | 'forecastReturn' | 'forecastMoic'

function positionSortValue(row: PositionReturn, key: PortfolioSortKey): string | number | null {
  const { actual } = row
  switch (key) {
    case 'name': return actual.name
    case 'initialCheck': return actual.investedTotal + row.forecast.plannedFollowOn
    case 'currentValue': return row.currentValue
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

export function ConstructionView({ vehicle, vehicleId }: { vehicle: string; vehicleId: string | null }) {
  const currency = useCurrency()
  const fmt = (v: number | null) => (v == null ? '—' : formatCurrency(v, currency))
  const fmtFull = (v: number | null) => (v == null ? '—' : formatCurrencyFull(v, currency))
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)
  const multiple = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}x`)
  const { setVehicle } = useVehicle()
  useEffect(() => { setVehicle(vehicle, vehicleId) }, [vehicle, vehicleId, setVehicle])

  const [actuals, setActuals] = useState<ConstructionActuals | null>(null)
  const [a, setA] = useState<ConstructionAssumptions>(DEFAULT_ASSUMPTIONS)
  const [persisted, setPersisted] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [forecastEditor, setForecastEditor] = useState<ForecastEditor | null>(null)
  const [expenseInputsOpen, setExpenseInputsOpen] = useState(false)
  const [capitalGroupsOpen, setCapitalGroupsOpen] = useState({
    committed: true,
    incurred: false,
    projected: false,
    total: true,
    invested: false,
  })
  const g = `group=${encodeURIComponent(vehicle)}`

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
        setActuals(d.actuals); setA(assumptions); setPersisted(JSON.stringify(assumptions)); setSaveState('idle'); setSaveError(null)
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load the construction model.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [g])

  useEffect(() => {
    if (loading || !actuals) return
    const serialized = JSON.stringify(a)
    if (serialized === persisted) return
    const t = setTimeout(() => {
      setSaveState('saving'); setSaveError(null)
      fetch(`/api/accounting/construction?${g}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: serialized,
      }).then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok) throw new Error(d?.error || 'Could not save the construction model.')
        setPersisted(JSON.stringify(parseAssumptions(d.assumptions, null))); setSaveState('saved'); setSaveError(null)
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

  const body = loading ? (
    <div className="rounded-card border bg-card p-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading construction model…</div>
  ) : loadError ? <EmptyState>{loadError}</EmptyState>
    : !model || !actuals || actuals.committedCapital <= 0 ? <EmptyState>No construction model for {vehicle}. It needs recorded commitments to plan against.</EmptyState>
    : (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <Metric label="Invested capital" value={fmt(model.capital.deployedTotal)} sub={`${pct(model.capital.deployedTotal / model.capital.committedCapital)} of committed capital`} />
          <Metric label="Uncalled capital" value={fmt(model.capital.uncalledCapital)} sub={`${pct(model.capital.uncalledCapital / model.capital.committedCapital)} of committed capital`} />
          <Metric label="Portfolio" value={`${model.capital.companyCount}`} sub="Current investments" />
          <Metric label="Gross MOIC" value={multiple(model.returns.actualGrossMoic)} sub="Current value and realized proceeds" />
          <Metric label="Net MOIC" value={multiple(model.returns.actualNetMoic)} sub="Fund TVPI on called capital" />
        </div>

        {model.warnings.filter(w => !w.startsWith('Fees and expenses are not on the ledger')).map((w, i) => <div key={i} className="flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm text-warning"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{w}</div>)}

        <section>
          <div className="flex items-end justify-between gap-4">
            <div><h2 className="text-lg font-semibold">Investments</h2><p className="mt-1 text-sm text-muted-foreground">Current positions and planned investments</p></div>
            <Button size="sm" variant="outline" onClick={addStage}><Plus className="mr-1 h-3.5 w-3.5" />Add Forecasted Investment</Button>
          </div>
          <div className="mt-4 overflow-hidden rounded-card border bg-card shadow-sm dark:shadow-none dark:border">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead><tr className="border-b bg-muted/50">
                <SortTh label="Investment" sortKey="name" sort={sort} onSort={key => setSort(s => nextSort(s, key, 'asc'))} />
                {([
                  ['Total invested capital', 'initialCheck'], ['Current value', 'currentValue'],
                  ['Realized proceeds', 'realizedProceeds'], ['Forecasted proceeds', 'forecastReturn'],
                  ['Gross MOIC', 'forecastMoic'],
                ] as [string, PortfolioSortKey][]).map(([label, key]) => <SortTh key={key} label={label} sortKey={key} sort={sort} onSort={key => setSort(s => nextSort(s, key))} align="right" />)}
              </tr></thead>
              <tbody>
                {model.returns.positions.length === 0
                  ? <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No portfolio investments are recorded for this vehicle.</td></tr>
                  : sortedPositions.map(row => {
                    const { actual } = row
                    return <tr key={actual.companyId} className="group border-b hover:bg-muted/20">
                      <td className="px-3 py-2"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><Link href={`/companies/${actual.companyId}`} className="min-w-0 truncate hover:underline" title={actual.name}>{actual.name}</Link>{actual.status === 'exited' ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Exited</span> : <button type="button" title="Edit forecast" aria-label={`Edit forecast for ${actual.name}`} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100" onClick={() => setForecastEditor({ kind: 'position', companyId: actual.companyId })}><Pencil className="h-3.5 w-3.5" /></button>}</div></td>
                      <MoneyCell full={fmtFull(actual.investedTotal + row.forecast.plannedFollowOn)}>{fmt(actual.investedTotal + row.forecast.plannedFollowOn)}</MoneyCell>
                      <MoneyCell full={fmtFull(row.currentValue)}>{fmt(row.currentValue)}</MoneyCell>
                      <MoneyCell full={fmtFull(actual.distributions)}>{fmt(actual.distributions)}</MoneyCell>
                      <MoneyCell full={fmtFull(row.estimatedReturn)}>{fmt(row.estimatedReturn)}</MoneyCell>
                      <td className="px-3 py-2 text-right tabular-nums">{multiple(row.estimatedMoic)}</td>
                    </tr>
                  })}

                {sortedStages.map(stage => <tr key={stage.key} className="group border-b hover:bg-muted/20">
                    <td className="px-3 py-2"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 truncate" title={stage.label || 'New investment'}>{stage.label || 'New investment'}</span><button type="button" title="Edit forecast" aria-label={`Edit forecast for ${stage.label || 'new investment'}`} className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100" onClick={() => setForecastEditor({ kind: 'stage', key: stage.key })}><Pencil className="h-3.5 w-3.5" /></button></div></td>
                    <MoneyCell full={fmtFull(stage.allocation)}>{fmt(stage.allocation)}</MoneyCell>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                    <MoneyCell full={fmtFull(stage.estimatedReturn)}>{fmt(stage.estimatedReturn)}</MoneyCell>
                    <td className="px-3 py-2 text-right tabular-nums">{multiple(stage.estimatedMoic)}</td>
                  </tr>)}
              </tbody>
              <tfoot><tr className="bg-muted/40 font-semibold">
                <td className="bg-muted px-3 py-2.5">Projected portfolio</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.capital.deployedTotal + model.capital.plannedCost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.currentPortfolioValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.positions.reduce((sum, row) => sum + row.actual.distributions, 0))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(model.returns.estimatedPortfolioValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{multiple(model.returns.estimatedGrossMoic)}</td>
              </tr></tfoot>
            </table>
          </div>
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between gap-4">
            <div><h2 className="text-lg font-semibold">Capital planning</h2><p className="mt-1 text-sm text-muted-foreground">Capital calls, expenses, investments, and reserves</p></div>
            <Button size="sm" variant="outline" onClick={() => setExpenseInputsOpen(open => !open)}>
              <Pencil className="mr-1 h-3.5 w-3.5" />{expenseInputsOpen ? 'Close expense forecast' : 'Edit expense forecast'}
            </Button>
          </div>
          {expenseInputsOpen && <div className="mt-4 rounded-card border bg-muted/30 px-3">
            <div className="grid gap-3 border-b py-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
              <div><p className="text-sm">Organizational expenses</p><p className="mt-0.5 text-xs text-muted-foreground">One-time costs</p></div>
              <NumberField label="Projected one-time costs" hideLabel value={a.remainingOrgCosts} onChange={v => setA({ ...a, remainingOrgCosts: v })} />
            </div>
            <div className="grid gap-3 border-b py-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
              <div><p className="text-sm">Partnership expenses</p><p className="mt-0.5 text-xs text-muted-foreground">Annual expenses through the final modeled exit, up to 10 years</p></div>
              <NumberField label="Annual expenses, for term below" hideLabel value={a.annualPartnershipExpense} onChange={v => setA({ ...a, annualPartnershipExpense: v })} />
            </div>
            <div className="py-3">
              <p className="text-sm">Management fees</p>
              <div className="mt-2 space-y-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center"><p className="text-xs text-muted-foreground">Annual rate</p><PercentField label="Annual rate" hideLabel value={a.feeAnnualRate} onChange={v => setA({ ...a, feeAnnualRate: v })} /></div>
                <p className="text-xs text-muted-foreground">Forecast through the final modeled exit ({modeledA.feeTermYears} {modeledA.feeTermYears === 1 ? 'year' : 'years'}), capped at 10 years.</p>
                {/* The GP's own commitment pays no fee (construction.ts feePayingShare). */}
                {(actuals?.feePayingShare ?? 1) < 1 && (
                  <p className="text-xs text-muted-foreground">Charged on {(((actuals?.feePayingShare ?? 1)) * 100).toFixed(1)}% of commitments — the GP&rsquo;s own stake pays no fee.</p>
                )}
              </div>
            </div>
          </div>}
          <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
          <div className="min-w-0">
          <div className="overflow-hidden rounded-card border bg-card shadow-sm dark:shadow-none dark:border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/50"><th className="px-3 py-2 text-left font-medium">Capital</th><th className="px-3 py-2 text-right font-medium">Amount</th><th className="w-32 whitespace-nowrap px-3 py-2 text-right font-medium">% committed</th></tr></thead>
              <tbody>
                <CapitalPlanningGroup
                  label="Committed capital"
                  value={model.capital.committedCapital}
                  items={[
                    ['Called capital', model.capital.calledCapital],
                    ['Uncalled capital', model.capital.uncalledCapital],
                  ]}
                  open={capitalGroupsOpen.committed}
                  onToggle={() => setCapitalGroupsOpen(s => ({ ...s, committed: !s.committed }))}
                  committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull}
                />
                <CapitalPlanningGroup
                  label="Actual expenses"
                  value={model.capital.incurredExpenses}
                  items={[
                    ['Organizational expenses', model.capital.orgCostsIncurred],
                    ['Partnership expenses', model.capital.expensesIncurred],
                    ['Management fees', model.capital.feesIncurred],
                  ]}
                  open={capitalGroupsOpen.incurred}
                  onToggle={() => setCapitalGroupsOpen(s => ({ ...s, incurred: !s.incurred }))}
                  committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull}
                />
                <CapitalPlanningGroup
                  label="Projected expenses"
                  value={model.capital.projectedExpenses}
                  items={[
                    ['Organizational expenses', model.capital.orgCostsProjected],
                    ['Partnership expenses', model.capital.expensesProjected],
                    ['Management fees', model.capital.feesProjected],
                  ]}
                  open={capitalGroupsOpen.projected}
                  onToggle={() => setCapitalGroupsOpen(s => ({ ...s, projected: !s.projected }))}
                  committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull}
                />
                <CapitalPlanningGroup
                  label="Total expenses"
                  value={model.capital.totalExpenses}
                  items={[
                    ['Organizational expenses', model.capital.orgCostsIncurred + model.capital.orgCostsProjected],
                    ['Partnership expenses', model.capital.expensesIncurred + model.capital.expensesProjected],
                    ['Management fees', model.capital.feesIncurred + model.capital.feesProjected],
                  ]}
                  open={capitalGroupsOpen.total}
                  onToggle={() => setCapitalGroupsOpen(s => ({ ...s, total: !s.total }))}
                  committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull}
                />
                <CapitalPlanningGroup
                  label="Invested capital"
                  value={model.capital.deployedTotal}
                  items={[
                    ['New invested', model.capital.deployedInitial],
                    ['Follow-on invested', model.capital.deployedFollowOn],
                  ]}
                  open={capitalGroupsOpen.invested}
                  onToggle={() => setCapitalGroupsOpen(s => ({ ...s, invested: !s.invested }))}
                  committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull}
                />
                <CapitalPlanningRow label="Reserved for investment" value={model.capital.remaining} committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull} />
                {model.capital.plannedCost > 0 && <CapitalPlanningRow label="Forecasted investment" value={model.capital.plannedCost} committed={model.capital.committedCapital} fmt={fmt} fmtFull={fmtFull} indent />}
              </tbody>
            </table>
          </div>
          {model.warnings.filter(w => w.startsWith('Fees and expenses are not on the ledger')).map(w => (
            <div key={w} className="mt-3 flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</div>
          ))}
          </div>
          <div className="flex flex-col gap-6">
            <CapitalUsageChart model={model} fmt={fmt} fmtFull={fmtFull} />
            <ValueSourcesChart model={model} fmt={fmt} fmtFull={fmtFull} />
          </div>
          </div>
        </section>

        <ForecastSection model={model} actuals={actuals} a={modeledA} setA={setA} vehicle={vehicle} fmt={fmt} fmtFull={fmtFull} multiple={multiple} />
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

  return <div className="pt-4 md:pt-8 pb-8 w-full">
    <AccountingPageHeader title="Portfolio construction" actions={<FundSwitcher />}><span className="block truncate" title={vehicle}>{vehicle} · Plan capital and return expectations</span></AccountingPageHeader>
    <AccountingBody>{body}</AccountingBody>
  </div>
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
function CapitalPlanningRow({
  label, value, committed, fmt, fmtFull, indent = false,
}: {
  label: string; value: number; committed: number; fmt: (v: number | null) => string; fmtFull: (v: number | null) => string
  indent?: boolean
}) {
  return <tr className="border-b last:border-b-0">
    <td className={cn('px-3 py-2', indent && 'pl-7 text-muted-foreground')}>{label}</td>
    <td className="px-3 py-2 text-right tabular-nums" title={fmtFull(value)}>{fmt(value)}</td>
    <td className="w-24 px-3 py-2 text-right tabular-nums text-muted-foreground">{committed > 0 ? `${((value / committed) * 100).toFixed(2)}%` : '—'}</td>
  </tr>
}
function CapitalPlanningGroup({
  label, value, items, open, onToggle, committed, fmt, fmtFull,
}: {
  label: string; value: number; items: [string, number][]; open: boolean; onToggle: () => void
  committed: number; fmt: (v: number | null) => string; fmtFull: (v: number | null) => string
}) {
  return <>
    <tr className="border-b">
      <td className="px-3 py-2"><button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1 rounded-sm hover:text-foreground text-left">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{label}</button></td>
      <td className="px-3 py-2 text-right tabular-nums" title={fmtFull(value)}>{fmt(value)}</td>
      <td className="w-24 px-3 py-2 text-right tabular-nums text-muted-foreground">{committed > 0 ? `${((value / committed) * 100).toFixed(2)}%` : '—'}</td>
    </tr>
    {open && items.map(([itemLabel, itemValue]) => <CapitalPlanningRow key={itemLabel} label={itemLabel} value={itemValue} committed={committed} fmt={fmt} fmtFull={fmtFull} indent />)}
  </>
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
