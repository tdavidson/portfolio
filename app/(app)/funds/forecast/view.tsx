'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useAnalystContext } from '@/components/analyst-context'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { addMonths, presetRange, type Interval, type MonthKey, type RangePreset } from '@/lib/forecast/months'
import type { PlanDetail, SeriesResult, VarianceResponse } from '@/lib/forecast/service'
import { CashChart, CashFlowTimeline, PnlChart } from './charts'
import { FeeLinksDialog } from './fee-links'
import { RuleDialog, type RuleSubmit } from './rule-dialog'
import { MonthRangePicker, MoreMenu, NewPlanMenu, type RangeChoice } from './toolbar'
import { VarianceSection } from './variance'
import { ForecastEntries } from './entries'
import { onApplied } from '@/lib/pending-actions/applied-event'
import { cashCellAdjustments, NO_ADJUSTMENTS, type CashCategory } from '@/lib/forecast/adjustments'

type PlanListItem = PlanDetail['plan'] & { versions: { id: string; versionNo: number; label: string | null; status: string; publishedAt: string }[] }
type View = 'combined' | 'plan' | 'actual' | 'variance'
type Preset = RangeChoice

const selectCls = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

const STATUS_LABEL: Record<string, string> = {
  actual: 'Actual',
  actual_unclosed: 'Not closed',
  forecast: 'Forecast',
  mixed: 'Part forecast',
  none: 'No data',
}

/**
 * Blank out periods the view has no data for (status 'none'), so a month with no actuals yet reads
 * "—" in the table and leaves a gap in the charts rather than plotting a zero.
 */
function maskNoData(s: SeriesResult): SeriesResult {
  const none = s.periods.map(p => p.status === 'none')
  if (!none.some(Boolean)) return s
  const blank = <T,>(xs: T[]) => xs.map((x, i) => (none[i] ? null : x)) as any
  return {
    ...s,
    lines: s.lines.map(l => ({ ...l, values: blank(l.values) })),
    revenue: blank(s.revenue),
    expenses: blank(s.expenses),
    netIncome: blank(s.netIncome),
    cash: blank(s.cash),
    cashFlows: s.cashFlows ? Object.fromEntries(Object.entries(s.cashFlows).map(([k, v]) => [k, blank(v)])) as any : null,
    cashDetail: s.cashDetail ? s.cashDetail.map(l => ({ ...l, values: blank(l.values) })) : null,
    cashAccounts: s.cashAccounts.map(a => ({ ...a, ending: blank(a.ending) })),
  }
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export function ForecastView({ vehicle, vehicleId }: { vehicle: string; vehicleId: string | null }) {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const full = useCallback((v: number | null | undefined) => formatCurrencyFull(v ?? null, currency), [currency])
  const short = useCallback((v: number | null) => formatCurrency(v, currency), [currency])

  const [plans, setPlans] = useState<PlanListItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [planId, setPlanId] = useState<string>('')
  const [versionId, setVersionId] = useState<string>('')
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [view, setView] = useState<View>('combined')
  const [preset, setPreset] = useState<Preset>('plan')
  const [start, setStart] = useState<MonthKey>(`${thisMonth().slice(0, 4)}-01`)
  const [end, setEnd] = useState<MonthKey>(`${thisMonth().slice(0, 4)}-12`)
  const [interval, setIntervalChoice] = useState<Interval>('month')
  const [statement, setStatement] = useState<'pnl' | 'cash' | 'entries'>('pnl')
  // A period clicked on a statement: the Entries tab opens on its months.
  const [entryMonths, setEntryMonths] = useState<string[] | null>(null)
  const openEntries = (months: string[]) => { if (detail) { setEntryMonths(months); setStatement('entries') } }
  // A cash figure being typed over (investing and financing lines, forecast months).
  const [cashEdit, setCashEdit] = useState<{ key: string; index: number; value: string } | null>(null)
  const commitCashEdit = async () => {
    if (!cashEdit || !detail || !series) return
    const raw = cashEdit.value.replace(/[$,\s()]/g, '')
    const e = cashEdit
    setCashEdit(null)
    if (raw === '' || !Number.isFinite(Number(raw))) return
    try {
      const next = cashCellAdjustments(detail.plan.adjustments ?? NO_ADJUSTMENTS, {
        category: e.key as CashCategory, month: series.periods[e.index].months[0], cash: Number(raw),
        entries: detail.entries, accounts: detail.allAccounts, cashAccountIds: detail.cashAccountIds,
      })
      await save({ adjustments: next })
    } catch (err) {
      setActionError((err as Error).message)
    }
  }
  const [series, setSeries] = useState<SeriesResult | null>(null)
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ accountId: string; month: MonthKey; value: string } | null>(null)
  const [ruleFor, setRuleFor] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [linking, setLinking] = useState(false)
  const { ask, hasAIKey } = useAnalystContext()
  const { kind: vehicleKind } = useVehicle()
  // The Analyst drafts; a person approves. The prompt only starts the conversation — it is put in
  // the input for the user to edit (add hires, price changes) and send.
  const draftWithAi = () => ask(
    `Draft a 12-month rolling forecast for ${vehicle}. Start from forecast_suggest_rules (it reads up to 36 months of closed history), ` +
    `tell me which accounts you are unsure about and why, then stage it with create_forecast_plan. ` +
    // Investment flows, fees and a GP's share and carry come from portfolio construction, not from
    // rules typed by hand (lib/forecast/principles.ts) — unless this is a management company.
    (vehicleKind === 'manco' ? '' : `Include portfolio construction flows. `) +
    `Things to factor in: `,
  )
  const [baseVersion, setBaseVersion] = useState<string>('approved')
  const [compare, setCompare] = useState<string>('actual')
  const [variance, setVariance] = useState<VarianceResponse | null>(null)

  // ---- loading ---------------------------------------------------------------------------------

  const loadPlans = useCallback(async () => {
    try {
      const res = await json<{ plans: PlanListItem[] }>(await lf('/api/accounting/forecast'))
      setPlans(res.plans)
      setListError(null)
      return res.plans
    } catch (e) {
      setListError((e as Error).message)
      setPlans([])
      return []
    }
  }, [lf])

  useEffect(() => {
    loadPlans().then(ps => { if (ps.length && !planId) setPlanId(ps[0].id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPlans])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return null }
    const d = await json<PlanDetail>(await lf(`/api/accounting/forecast/${id}`))
    setDetail(d)
    return d
  }, [lf])

  // An Analyst draft approved in the panel lands here without a page refresh: a new plan is opened,
  // a changed one reloaded.
  useEffect(() => onApplied(({ actionType, result }) => {
    if (!/forecast_plan$/.test(actionType)) return
    const created = (result as { planId?: string } | null)?.planId
    loadPlans().then(() => {
      if (created) setPlanId(created)
      else if (planId) loadDetail(planId).catch(() => {})
    })
  }), [loadPlans, loadDetail, planId])


  useEffect(() => {
    setVersionId('')
    setEditing(null)
    loadDetail(planId).catch(e => setActionError((e as Error).message))
  }, [planId, loadDetail])

  // The range follows the preset; "plan" is the cutoff's year through the plan's last month.
  useEffect(() => {
    if (preset === 'custom') return
    if (preset === 'plan') {
      if (!detail) {
        const r = presetRange('current_year', thisMonth())
        setStart(r.start); setEnd(r.end)
        return
      }
      const first = detail.plan.kind === 'budget' ? detail.window.first : `${detail.cutoff.slice(0, 4)}-01`
      setStart(first)
      setEnd(detail.window.last)
      return
    }
    const r = presetRange(preset, thisMonth())
    setStart(r.start); setEnd(r.end)
  }, [preset, detail])

  useEffect(() => {
    if (detail) setView(detail.plan.kind === 'budget' ? 'plan' : 'combined')
    else setView('actual')
  }, [detail?.plan.id, detail?.plan.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const seriesQuery = useMemo(() => {
    const q = new URLSearchParams({ start, end, interval, view: !planId ? 'actual' : view === 'variance' ? 'combined' : view })
    if (planId) q.set('plan', planId)
    if (versionId) q.set('version', versionId)
    return q.toString()
  }, [start, end, interval, view, planId, versionId])

  const loadSeries = useCallback(async () => {
    if (start > end) { setSeriesError('The start month is after the end month'); return }
    setLoading(true)
    try {
      setSeries(maskNoData(await json<SeriesResult>(await lf(`/api/accounting/forecast/series?${seriesQuery}`))))
      setSeriesError(null)
    } catch (e) {
      setSeriesError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [lf, seriesQuery, start, end])

  useEffect(() => { if (plans !== null && view !== 'variance') loadSeries() }, [loadSeries, plans, view])

  const varianceQuery = useMemo(() => {
    const q = new URLSearchParams({ base: planId, baseVersion, compare, start, end, interval })
    return q.toString()
  }, [planId, baseVersion, compare, start, end, interval])

  const loadVariance = useCallback(async () => {
    if (!planId || start > end) return
    setLoading(true)
    try {
      setVariance(await json<VarianceResponse>(await lf(`/api/accounting/forecast/variance?${varianceQuery}`)))
      setSeriesError(null)
    } catch (e) {
      setVariance(null)
      setSeriesError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [lf, varianceQuery, planId, start, end])

  useEffect(() => { if (view === 'variance') loadVariance() }, [view, loadVariance])

  // A budget defaults its baseline to the approved version if it has one, else the draft.
  useEffect(() => {
    if (!detail) return
    setBaseVersion(detail.versions.some(v => v.status === 'approved') ? 'approved' : 'draft')
    setCompare('actual')
  }, [detail?.plan.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- writes ----------------------------------------------------------------------------------

  const save = useCallback(async (body: Record<string, unknown>) => {
    if (!detail) return false
    setBusy(true)
    setActionError(null)
    try {
      const next = await json<PlanDetail>(await lf(`/api/accounting/forecast/${detail.plan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: detail.plan.revision, ...body }),
      }))
      setDetail(next)
      await loadSeries()
      return true
    } catch (e) {
      setActionError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }, [detail, lf, loadSeries])

  const commitEdit = async () => {
    if (!editing) return
    const raw = editing.value.replace(/[$,\s]/g, '')
    const amount = raw === '' ? null : Number(raw)
    if (amount !== null && !Number.isFinite(amount)) { setActionError('Enter a number, or leave it blank to clear the override'); return }
    const e = editing
    setEditing(null)
    await save({ overrides: [{ accountId: e.accountId, month: e.month, amount }] })
  }

  const saveRule = async (r: RuleSubmit) => {
    if (!ruleFor) return
    if (await save({ rules: [{ accountId: ruleFor, ...r }] })) setRuleFor(null)
  }

  const removeRule = async () => {
    if (!ruleFor) return
    if (await save({ removeRules: [ruleFor] })) setRuleFor(null)
  }

  // ---- derived ---------------------------------------------------------------------------------

  const ruleByAccount = useMemo(() => new Map((detail?.rules ?? []).map(r => [r.accountId, r])), [detail])
  const editable = !!detail && !versionId && interval === 'month' && view !== 'actual'
  const accountsWithoutRows = useMemo(() => {
    if (!detail) return []
    const shown = new Set(series?.lines.map(l => l.accountId) ?? [])
    return detail.accounts.filter(a => !shown.has(a.id))
  }, [detail, series])

  const exportHref = view === 'variance'
    ? `/api/accounting/forecast/export?${varianceQuery}&kind=variance&group=${encodeURIComponent(vehicle)}`
    : `/api/accounting/forecast/export?${seriesQuery}&group=${encodeURIComponent(vehicle)}`

  // ---- render ----------------------------------------------------------------------------------

  return (
    <FundSubpageChrome
      title="Forecast"
      description="Monthly budgets and rolling forecasts from the posted books. Forecasts never post to the ledger."
      vehicle={vehicle}
      vehicleId={vehicleId}
    >
      {listError && <p className="mb-4 text-sm text-destructive">{listError}</p>}

      {/* Two rows. Top: which plan this is, and what you can do with it. Below: how you are
          looking at it — version, view, range, interval — in one row of controls. */}
      <div className="mb-3 flex items-center gap-3">
        {/* Which plan is on screen — said, not hidden in a dropdown. One plan: its name, as the
            page's subject. Several: a chip each to switch. None: nothing (the page is the actuals). */}
        {(plans ?? []).length === 1 && (() => {
          const p = plans![0]
          return (
            <p className="min-w-0 truncate text-base font-medium" title={p.name}>
              {p.name}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{p.kind === 'budget' ? `Budget ${p.fiscalYear}` : 'Rolling forecast'}</span>
            </p>
          )
        })()}
        {(plans ?? []).length > 1 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Plan">
            {plans!.map(p => {
              const active = p.id === planId
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPlanId(p.id)}
                  title={p.name}
                  className={cn(
                    'inline-flex h-8 max-w-[22rem] items-center gap-1.5 rounded-md border px-3 text-sm',
                    active ? 'border-foreground/30 bg-muted text-foreground' : 'border-input bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.kind === 'budget' ? `Budget ${p.fiscalYear}` : 'Forecast'}</span>
                </button>
              )
            })}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {detail?.stale && !versionId && (
            <Button variant="outline" onClick={() => save({})} disabled={busy} title="The books have moved since this draft was compiled">
              <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh
            </Button>
          )}
          <MoreMenu items={[
            { label: 'Publish…', onSelect: () => setPublishing(true), hidden: !detail || !!versionId, disabled: busy },
            { label: 'Construction flows', checked: !!detail?.plan.includeConstruction, disabled: busy,
              hidden: !detail || !!versionId || detail.vehicleKind === 'manco',
              onSelect: () => save({ patch: { includeConstruction: !detail?.plan.includeConstruction } }) },
            { label: 'Fee links…', onSelect: () => setLinking(true) },
            { label: 'Download CSV', href: exportHref },
          ]} />
          <NewPlanMenu onManual={() => setCreating(true)} onDraftWithAi={hasAIKey ? draftWithAi : undefined} />
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Only once something has been published: before that the working draft is all there is. */}
        {detail && detail.versions.length > 0 && (
          <select className={selectCls} value={versionId} onChange={e => setVersionId(e.target.value)} aria-label="Version">
            <option value="">Working draft</option>
            {detail.versions.map(v => (
              <option key={v.id} value={v.id}>v{v.versionNo}{v.status === 'approved' ? ' · approved' : ''}{v.label ? ` · ${v.label}` : ''}</option>
            ))}
          </select>
        )}
        {detail && (
          <select className={selectCls} value={view} onChange={e => setView(e.target.value as View)} aria-label="View">
            <option value="combined">Actual + {detail.plan.kind === 'budget' ? 'budget' : 'forecast'}</option>
            <option value="plan">{detail.plan.kind === 'budget' ? 'Budget' : 'Forecast'} only</option>
            <option value="actual">Actual only</option>
            <option value="variance">Variance</option>
          </select>
        )}
        {detail && view === 'variance' && (
          <>
            <select className={selectCls} value={baseVersion} onChange={e => setBaseVersion(e.target.value)} aria-label="Measured against">
              {detail.versions.some(v => v.status === 'approved') && <option value="approved">Against the approved baseline</option>}
              <option value="draft">Against the working draft</option>
              {detail.versions.map(v => <option key={v.id} value={v.id}>Against v{v.versionNo}{v.label ? ` · ${v.label}` : ''}</option>)}
            </select>
            <select className={selectCls} value={compare} onChange={e => setCompare(e.target.value)} aria-label="Compare">
              <option value="actual">Actuals</option>
              {(plans ?? []).filter(p => p.id !== detail.plan.id).map(p => <option key={p.id} value={p.id}>{p.name} (latest)</option>)}
            </select>
          </>
        )}
        <MonthRangePicker
          preset={preset} onPreset={setPreset}
          start={start} end={end}
          onStart={m => { setPreset('custom'); setStart(m) }}
          onEnd={m => { setPreset('custom'); setEnd(m) }}
          planLabel={detail ? 'Plan range' : 'Current year'}
        />
        {/* Presentation only: storage and every calculation stay monthly; the server re-adds the
            months into quarters or years for the table, every chart, the variance and the CSV alike. */}
        <select className={selectCls} value={interval} onChange={e => setIntervalChoice(e.target.value as Interval)} aria-label="Show by">
          <option value="month">Monthly</option>
          <option value="quarter">Quarterly</option>
          <option value="year">Annual</option>
        </select>
      </div>
      {plans && plans.length === 0 && !listError && (
        // No button: New plan is right above, and the actuals below are the page's content, not a void.
        <p className="mb-4 text-sm text-muted-foreground">
          No budgets or forecasts for {vehicle} yet. The actuals below come straight from the posted ledger.
        </p>
      )}

      {/* Where the actuals stand, in one line — including that the latest months are not closed,
          which used to be two warning banners saying the same thing. The version is in its own
          control above, so it is not repeated here. */}
      {series && (
        <p className="mb-3 text-sm text-muted-foreground">
          Books closed through <span className="text-foreground">{monthLabel(series.closedThrough) ?? 'never'}</span>
          {series.actualsThrough && <>
            {' · '}Actuals through <span className="text-foreground">{monthLabel(series.actualsThrough)}</span>
            {series.actualsThrough > (series.closedThrough ?? '') && <span className="text-warning"> (not closed after {monthLabel(series.closedThrough) ?? 'the start'})</span>}
          </>}
        </p>
      )}

      <ForecastNotes
        planKey={planId || `actuals:${vehicle}`}
        notes={[...((view === 'variance' ? variance?.warnings : series?.warnings) ?? []), ...(detail && !versionId ? detail.warnings : [])]
          // Said once, in the status line above.
          .filter(w => !/include months that are not closed|later actual months are not final/.test(w))
          .filter((w, i, all) => all.indexOf(w) === i)}
      />
      {actionError && <p className="mb-3 text-sm text-destructive">{actionError}</p>}
      {seriesError && <p className="mb-3 text-sm text-destructive">{seriesError}</p>}

      {view === 'variance' && variance && (
        <VarianceSection
          data={variance}
          fmt={full}
          short={short}
          baseLabel={baseVersion === 'approved' ? 'Budget' : baseVersion === 'draft' ? 'Draft' : `v${detail?.versions.find(v => v.id === baseVersion)?.versionNo ?? ''}`}
          compareLabel={compare === 'actual' ? 'Actual' : (plans ?? []).find(p => p.id === compare)?.name ?? 'Plan'}
        />
      )}

      {series && view !== 'variance' && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <CashChart series={series} fmt={short} />
          <PnlChart series={series} fmt={short} />
          {series.cashFlows && (['called', 'invested', 'proceeds', 'distributed'] as const).some(k => series.cashFlows![k].some(Boolean)) && (
            <div className="lg:col-span-2"><CashFlowTimeline series={series} fmt={short} /></div>
          )}
        </div>
      )}

      {loading && !series && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}

      {series && view !== 'variance' && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <div className="inline-flex rounded-md border border-input p-0.5" role="group" aria-label="Statement">
              {(detail ? (['pnl', 'cash', 'entries'] as const) : (['pnl', 'cash'] as const)).map(s => (
                <button key={s} type="button" onClick={() => { setStatement(s); if (s !== 'entries') setEntryMonths(null) }}
                  className={cn('h-8 rounded-sm px-3 text-sm', statement === s ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {s === 'pnl' ? 'P&L' : s === 'cash' ? 'Cash' : 'Entries'}
                </button>
              ))}
            </div>
            {editable && statement === 'pnl' && <span className="text-xs text-muted-foreground">Click a forecast month to change it, an account to set its rule, or a period heading to see its entries.</span>}
            {detail && statement === 'cash' && <span className="text-xs text-muted-foreground">{interval === 'month' && !versionId ? 'Click a forecast investment, exit, contribution or distribution to change it; any other figure shows its entries.' : 'Click a figure to see the entries behind it.'}</span>}
            {!editable && detail && !versionId && interval !== 'month' && statement === 'pnl' && (
              <span className="text-xs text-muted-foreground">Showing {interval === 'quarter' ? 'quarters' : 'years'} — switch to Monthly to override a month.</span>
            )}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {statement === 'entries' && detail ? (
            <ForecastEntries
              detail={detail}
              fmt={v => full(v)}
              editable={!versionId}
              months={entryMonths}
              onClearMonths={() => setEntryMonths(null)}
              save={save}
              onEditRule={id => setRuleFor(id)}
            />
          ) : (
          <div className="overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="sticky left-0 z-10 min-w-[14rem] bg-muted px-3 py-2 text-left font-medium">Account</th>
                  {series.periods.map(p => (
                    <th key={p.key} onClick={() => openEntries(p.months)} title={detail ? 'See the entries in this period' : undefined}
                      className={cn('min-w-[7rem] px-3 py-2 text-right font-medium', detail && 'cursor-pointer hover:bg-accent/40', series.boundary && p.months.includes(series.boundary) && p.months[p.months.length - 1] === series.boundary && 'border-r-2 border-r-foreground/30')}>
                      <div>{p.label}</div>
                      <div className={cn('text-xs', p.status === 'actual_unclosed' ? 'font-medium text-foreground' : p.status === 'actual' || p.status === 'none' ? 'font-normal text-muted-foreground' : 'font-normal text-info')}>
                        {STATUS_LABEL[p.status]}{p.partial ? ' (part)' : ''}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statement === 'pnl' ? (
                  <>
                    <SectionRow label="Revenue" span={series.periods.length} />
                    {series.lines.filter(l => l.type === 'income').map(l => (
                      <AccountRow key={l.accountId} line={l} series={series} fmt={full} rule={ruleByAccount.get(l.accountId)}
                        editable={editable} editing={editing} setEditing={setEditing} commit={commitEdit} onRule={() => setRuleFor(l.accountId)} canRule={!!detail && !versionId} />
                    ))}
                    <TotalRow label="Total revenue" values={series.revenue} fmt={full} />
                    <SectionRow label="Expenses" span={series.periods.length} />
                    {series.lines.filter(l => l.type === 'expense').map(l => (
                      <AccountRow key={l.accountId} line={l} series={series} fmt={full} rule={ruleByAccount.get(l.accountId)}
                        editable={editable} editing={editing} setEditing={setEditing} commit={commitEdit} onRule={() => setRuleFor(l.accountId)} canRule={!!detail && !versionId} />
                    ))}
                    <TotalRow label="Total expenses" values={series.expenses} fmt={full} />
                    <TotalRow label="Net income" values={series.netIncome} fmt={full} strong />
                  </>
                ) : (
                  <>
                    <TotalRow label="Opening cash" values={series.cash.map(c => c?.opening ?? null)} fmt={full} />
                    {(['operating', 'investing', 'financing'] as const).map(section => {
                      const lines = (series.cashDetail ?? []).filter(l => l.section === section)
                      // On a draft by month, the lines a figure can be typed into show even when empty —
                      // so a distribution can be added to a plan that has none yet.
                      if (detail && !versionId && interval === 'month') {
                        const wanted: Record<string, { key: string; label: string }[]> = {
                          investing: [{ key: 'invested', label: 'Investments' }, { key: 'proceeds', label: 'Exit proceeds' }],
                          financing: [{ key: 'called', label: 'Capital contributions' }, { key: 'distributed', label: 'Distributions' }],
                        }
                        for (const w of wanted[section] ?? []) {
                          if (!lines.some(l => l.key === w.key)) lines.push({ section, key: w.key, label: w.label, code: null, values: series.periods.map(() => 0) } as (typeof lines)[number])
                        }
                      }
                      if (!lines.length) return null
                      const total = series.periods.map((p, i) => (p.status === 'none' ? null : lines.reduce((s, l) => s + (l.values[i] ?? 0), 0)))
                      return (
                        <CashSectionRows key={section} section={section} lines={lines} total={total} span={series.periods.length} fmt={full}
                          onCell={detail ? i => openEntries(series.periods[i].months) : undefined}
                          canEdit={(key, i) => !!detail && !versionId && interval === 'month' && ['invested', 'proceeds', 'called', 'distributed'].includes(key)
                            && series.periods[i].status === 'forecast'}
                          cashEdit={cashEdit} setCashEdit={setCashEdit} commitCashEdit={commitCashEdit} />
                      )
                    })}
                    <TotalRow label="Net cash movement" values={series.cash.map(c => c?.movement ?? null)} fmt={full} />
                    <TotalRow label="Ending cash" values={series.cash.map(c => c?.ending ?? null)} fmt={full} strong />
                    {series.cashAccounts.length > 1 && series.cashAccounts.map(a => (
                      <tr key={a.accountId} className="border-b">
                        <td className="sticky left-0 z-10 bg-card px-3 py-2 pl-6 text-muted-foreground">
                          <span className="font-mono text-xs">{a.code}</span> {a.name}
                        </td>
                        {a.ending.map((v, i) => <td key={i} className="px-3 py-2 text-right tabular-nums text-muted-foreground">{full(v)}</td>)}
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          )}

          {detail && !versionId && statement === 'pnl' && accountsWithoutRows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Add a rule for</span>
              <select className={selectCls} value="" onChange={e => e.target.value && setRuleFor(e.target.value)} aria-label="Add a rule">
                <option value="">Choose an account…</option>
                {accountsWithoutRows.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </select>
            </div>
          )}
        </>
      )}

      <RuleDialog
        open={!!ruleFor}
        account={detail?.accounts.find(a => a.id === ruleFor) ?? null}
        rule={ruleFor ? ruleByAccount.get(ruleFor) ?? null : null}
        saving={busy}
        error={actionError}
        onClose={() => setRuleFor(null)}
        onSave={saveRule}
        onRemove={removeRule}
      />

      <CreatePlanDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async id => { setCreating(false); await loadPlans(); setPlanId(id) }}
        plans={plans ?? []}
      />

      <FeeLinksDialog open={linking} vehicle={vehicle} onClose={() => setLinking(false)} onChanged={() => { if (detail) save({}) }} />

      {detail && (
        <PublishDialog
          open={publishing}
          detail={detail}
          onClose={() => setPublishing(false)}
          onPublished={async () => { setPublishing(false); await loadDetail(detail.plan.id); await loadPlans() }}
        />
      )}
    </FundSubpageChrome>
  )
}

// ---- rows ------------------------------------------------------------------------------------------

function SectionRow({ label, span }: { label: string; span: number }) {
  return (
    <tr className="border-b">
      <td className="sticky left-0 z-10 bg-card px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</td>
      <td colSpan={span} />
    </tr>
  )
}

const SECTION_LABEL = { operating: 'Operating activities', investing: 'Investing activities', financing: 'Financing activities' } as const

/**
 * One section of the cash-flow statement: money in positive, money out negative. Operating lines
 * are the accounts the cash was for (a bill's payment shows against its expense, not the payable it
 * cleared); investing and financing lines are the capital flows.
 */
function CashSectionRows({ section, lines, total, span, fmt, onCell, canEdit, cashEdit, setCashEdit, commitCashEdit }: {
  section: keyof typeof SECTION_LABEL
  lines: NonNullable<SeriesResult['cashDetail']>
  total: (number | null)[]
  span: number
  fmt: (v: number | null) => string
  /** Open the entries behind a period's figure. */
  onCell?: (periodIndex: number) => void
  /** Whether this line's figure in this period can be typed over (it then writes the entry). */
  canEdit?: (key: string, periodIndex: number) => boolean
  cashEdit?: { key: string; index: number; value: string } | null
  setCashEdit?: (e: { key: string; index: number; value: string } | null) => void
  commitCashEdit?: () => void
}) {
  return (
    <>
      <SectionRow label={SECTION_LABEL[section]} span={span} />
      {lines.map(l => (
        <tr key={l.key} className="border-b hover:bg-accent/40">
          <td className="sticky left-0 z-10 bg-card px-3 py-2">
            {l.code && <span className="font-mono text-xs text-muted-foreground">{l.code}</span>} {l.label}
          </td>
          {l.values.map((v, i) => {
            const editableCell = canEdit?.(l.key, i) ?? false
            if (cashEdit && cashEdit.key === l.key && cashEdit.index === i) {
              return (
                <td key={i} className="px-1 py-1 text-right">
                  <input autoFocus inputMode="decimal" value={cashEdit.value} aria-label={`${l.label} amount`}
                    onChange={e => setCashEdit?.({ ...cashEdit, value: e.target.value })}
                    onBlur={() => commitCashEdit?.()}
                    onKeyDown={e => { if (e.key === 'Enter') commitCashEdit?.(); if (e.key === 'Escape') setCashEdit?.(null) }}
                    className="h-8 w-full rounded border border-input bg-background px-2 text-right text-sm tabular-nums" />
                </td>
              )
            }
            return (
              <td key={i}
                onClick={editableCell ? () => setCashEdit?.({ key: l.key, index: i, value: v ? String(Math.abs(v)) : '' }) : onCell && v ? () => onCell(i) : undefined}
                title={editableCell ? 'Type a new amount — the entry behind it is written for you' : undefined}
                className={cn('px-3 py-2 text-right tabular-nums', editableCell ? 'cursor-text hover:bg-accent/40' : onCell && v && 'cursor-pointer hover:underline')}>{fmt(v)}</td>
            )
          })}
        </tr>
      ))}
      <TotalRow label={`Net cash from ${section}`} values={total} fmt={fmt} />
    </>
  )
}

function TotalRow({ label, values, fmt, strong }: { label: string; values: (number | null)[]; fmt: (v: number | null) => string; strong?: boolean }) {
  return (
    <tr className={cn('border-b', strong && 'bg-muted/30')}>
      <td className={cn('sticky left-0 z-10 bg-card px-3 py-2', strong ? 'font-semibold' : 'font-medium')}>{label}</td>
      {values.map((v, i) => <td key={i} className={cn('px-3 py-2 text-right tabular-nums', strong && 'font-semibold')}>{fmt(v)}</td>)}
    </tr>
  )
}

function AccountRow({ line, series, fmt, rule, editable, editing, setEditing, commit, onRule, canRule }: {
  line: SeriesResult['lines'][number]
  series: SeriesResult
  fmt: (v: number | null) => string
  rule: PlanDetail['rules'][number] | undefined
  editable: boolean
  editing: { accountId: string; month: MonthKey; value: string } | null
  setEditing: (e: { accountId: string; month: MonthKey; value: string } | null) => void
  commit: () => void
  onRule: () => void
  canRule: boolean
}) {
  const overridden = new Set(series.overridden[line.accountId] ?? [])
  const source = series.sources[line.accountId]
  return (
    <tr className="border-b hover:bg-accent/40">
      <td className="sticky left-0 z-10 bg-card px-3 py-2">
        {canRule ? (
          <button type="button" onClick={onRule} className="text-left hover:underline" title={rule?.basis || 'Set a rule'}>
            <span className="font-mono text-xs text-muted-foreground">{line.code}</span> {line.name}
          </button>
        ) : (
          <span><span className="font-mono text-xs text-muted-foreground">{line.code}</span> {line.name}</span>
        )}
        {source && <div className="text-xs text-muted-foreground">{rule?.basis || source.basis}</div>}
        {rule?.warnings.length ? <div className="text-sm text-warning" title={rule.warnings.join('\n')}>{rule.warnings.length} note{rule.warnings.length === 1 ? '' : 's'}</div> : null}
      </td>
      {series.periods.map((p, i) => {
        const month = p.months[0]
        const isForecast = p.status === 'forecast'
        const canEdit = editable && isForecast && p.months.length === 1
        const isEditing = editing && editing.accountId === line.accountId && editing.month === month
        return (
          <td key={p.key} className={cn('px-3 py-2 text-right tabular-nums', isForecast && 'bg-muted/30')}>
            {isEditing ? (
              <input
                autoFocus
                className="h-7 w-24 rounded-sm border border-input bg-background px-1 text-right tabular-nums"
                value={editing!.value}
                onChange={e => setEditing({ ...editing!, value: e.target.value })}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(null) }}
                aria-label={`${line.name} ${p.label}`}
              />
            ) : canEdit ? (
              <button type="button" className="w-full text-right hover:underline" onClick={() => setEditing({ accountId: line.accountId, month, value: String(line.values[i] || '') })}>
                {fmt(line.values[i])}{p.months.some(m => overridden.has(m)) && <span className="ml-1 text-info" title="Overridden this month">•</span>}
              </button>
            ) : (
              <>{fmt(line.values[i])}{p.months.some(m => overridden.has(m)) && <span className="ml-1 text-info" title="Includes an overridden month">•</span>}</>
            )}
          </td>
        )
      })}
    </tr>
  )
}

// ---- dialogs ---------------------------------------------------------------------------------------

function CreatePlanDialog({ open, onClose, onCreated, plans }: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
  plans: PlanListItem[]
}) {
  const lf = useLedgerFetch()
  const year = Number(thisMonth().slice(0, 4))
  const [kind, setKind] = useState<'budget' | 'rolling_forecast'>('rolling_forecast')
  const [name, setName] = useState('')
  const [fiscalYear, setFiscalYear] = useState(String(year + 1))
  const [horizon, setHorizon] = useState('12')
  const [seed, setSeed] = useState('suggested')
  const [includeConstruction, setIncludeConstruction] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (open) { setError(null); setName('') } }, [open])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = {
        kind,
        name: name.trim() || (kind === 'budget' ? `${fiscalYear} budget` : `Rolling forecast ${thisMonth()}`),
        fiscalYear: kind === 'budget' ? Number(fiscalYear) : undefined,
        horizonMonths: kind === 'rolling_forecast' ? Number(horizon) : undefined,
        seed: seed.startsWith('plan:') ? { from: 'plan', planId: seed.slice(5) } : { from: seed },
        includeConstruction,
      }
      const res = await json<PlanDetail>(await lf('/api/accounting/forecast', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
      onCreated(res.plan.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New plan</DialogTitle>
          <DialogDescription>A budget is a fixed plan for a year. A rolling forecast starts after the last closed month and moves forward as the books close.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Type</span>
            <select className={cn(selectCls, 'w-full')} value={kind} onChange={e => setKind(e.target.value as any)}>
              <option value="rolling_forecast">Rolling forecast</option>
              <option value="budget">Annual budget</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'budget' ? `${fiscalYear} budget` : 'Rolling forecast'} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeConstruction} onChange={e => setIncludeConstruction(e.target.checked)} />
            Include portfolio construction’s investments, exits, calls and distributions (funds and SPVs)
          </label>
          {kind === 'budget' ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Fiscal year</span>
              <Input inputMode="numeric" value={fiscalYear} onChange={e => setFiscalYear(e.target.value)} />
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Horizon</span>
              <select className={cn(selectCls, 'w-full')} value={horizon} onChange={e => setHorizon(e.target.value)}>
                {[12, 18, 24, 36].map(h => <option key={h} value={h}>{h} months</option>)}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Start from</span>
            <select className={cn(selectCls, 'w-full')} value={seed} onChange={e => setSeed(e.target.value)}>
              <option value="suggested">Suggested from each account’s history (12–36 closed months)</option>
              {kind === 'budget' && <option value="last_year">Last year’s actuals, month by month</option>}
              <option value="blank">Blank</option>
              {plans.map(p => <option key={p.id} value={`plan:${p.id}`}>Copy rules from {p.name}</option>)}
            </select>
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PublishDialog({ open, detail, onClose, onPublished }: {
  open: boolean
  detail: PlanDetail
  onClose: () => void
  onPublished: () => void
}) {
  const lf = useLedgerFetch()
  const hasApproved = detail.versions.some(v => v.status === 'approved')
  const [status, setStatus] = useState<'published' | 'approved'>('published')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) { setError(null); setLabel(''); setStatus(detail.plan.kind === 'budget' && !hasApproved ? 'approved' : 'published') }
  }, [open, detail.plan.kind, hasApproved])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await json(await lf(`/api/accounting/forecast/${detail.plan.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: detail.plan.revision, status, label: label.trim() || null }),
      }))
      onPublished()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish {detail.plan.name}</DialogTitle>
          <DialogDescription>
            Freezes the plan as it stands, with actuals through {detail.cutoff}. A published version never changes — later edits and new
            actuals go into the working draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">As</span>
            <select className={cn(selectCls, 'w-full')} value={status} onChange={e => setStatus(e.target.value as any)}>
              <option value="published">{detail.plan.kind === 'budget' ? 'A revision' : 'A forecast snapshot'}</option>
              <option value="approved" disabled={hasApproved}>The approved baseline{hasApproved ? ' (already set)' : ''}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Label</span>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={`Q${Math.ceil(Number(addMonths(detail.cutoff, 1).slice(5)) / 3)} reforecast`} />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "2026-08" → "Aug 2026". */
function monthLabel(m: string | null | undefined): string | null {
  if (!m || !/^\d{4}-\d{2}/.test(m)) return m ?? null
  const [y, mo] = m.split('-').map(Number)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1]} ${y}`
}

/**
 * The forecast's notes — inferred exit months, missing accounts, a linked fund without a schedule —
 * in one panel rather than a banner each. Collapsed to a count; each can be dismissed, and stays
 * dismissed for this plan in this browser until its wording changes (a new note is a new fact).
 * "Out of date — refresh" is never hidden: it is the one that asks for an action.
 */
function ForecastNotes({ planKey, notes }: { planKey: string; notes: string[] }) {
  const storageKey = `forecast-notes-dismissed:${planKey}`
  const [dismissed, setDismissed] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try { setDismissed(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')) } catch { setDismissed([]) }
  }, [storageKey])
  const persist = (next: string[]) => {
    setDismissed(next)
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* private window: dismiss for this visit only */ }
  }
  const urgent = notes.filter(n => /refresh to recompile/.test(n))
  const rest = notes.filter(n => !urgent.includes(n))
  const shown = rest.filter(n => !dismissed.includes(n))
  const hiddenCount = rest.length - shown.length
  if (urgent.length === 0 && rest.length === 0) return null
  return (
    <div className="mb-4 space-y-2">
      {urgent.map(n => (
        <div key={n} className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{n}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="rounded-md border text-sm">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <span>{shown.length > 0 ? `${shown.length} note${shown.length === 1 ? '' : 's'} on this forecast` : 'No open notes'}{hiddenCount > 0 ? ` · ${hiddenCount} dismissed` : ''}</span>
            <span className="ml-auto text-xs">{open ? 'Hide' : 'Show'}</span>
          </button>
          {open && (
            <ul className="divide-y border-t">
              {shown.map(n => (
                <li key={n} className="flex items-start gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">{n}</span>
                  <button type="button" onClick={() => persist([...dismissed, n])} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="px-3 py-2">
                  <button type="button" onClick={() => persist(dismissed.filter(d => !rest.includes(d)))} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                    Show {hiddenCount} dismissed
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
