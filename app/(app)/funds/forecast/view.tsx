'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, Loader2, Plus, RefreshCw, Sparkles } from 'lucide-react'
import { useAnalystContext } from '@/components/analyst-context'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { addMonths, presetRange, type Interval, type MonthKey, type RangePreset } from '@/lib/forecast/months'
import type { PlanDetail, SeriesResult, VarianceResponse } from '@/lib/forecast/service'
import { CashChart, CashFlowTimeline, PnlChart } from './charts'
import { FeeLinksDialog } from './fee-links'
import { RuleDialog, type RuleSubmit } from './rule-dialog'
import { VarianceSection } from './variance'

type PlanListItem = PlanDetail['plan'] & { versions: { id: string; versionNo: number; label: string | null; status: string; publishedAt: string }[] }
type View = 'combined' | 'plan' | 'actual' | 'variance'
type Preset = RangePreset | 'plan' | 'custom'

const selectCls = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

const STATUS_LABEL: Record<string, string> = {
  actual: 'Actual',
  actual_unclosed: 'Not closed',
  forecast: 'Forecast',
  mixed: 'Part forecast',
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
  const [interval, setInterval] = useState<Interval>('month')
  const [statement, setStatement] = useState<'pnl' | 'cash'>('pnl')
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
  // The Analyst drafts; a person approves. The prompt only starts the conversation — it is put in
  // the input for the user to edit (add hires, price changes) and send.
  const draftWithAi = () => ask(
    `Draft a 12-month rolling forecast for ${vehicle}. Start from forecast_suggest_rules (it reads up to 36 months of closed history), ` +
    `tell me which accounts you are unsure about and why, then stage it with create_forecast_plan. ` +
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
      setSeries(await json<SeriesResult>(await lf(`/api/accounting/forecast/series?${seriesQuery}`)))
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
      title="Budget & forecast"
      description="Monthly budgets and rolling forecasts from the posted books. Forecasts never post to the ledger."
      vehicle={vehicle}
      vehicleId={vehicleId}
    >
      {listError && <p className="mb-4 text-sm text-destructive">{listError}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className={selectCls} value={planId} onChange={e => setPlanId(e.target.value)} aria-label="Plan">
          <option value="">Actuals only</option>
          {(plans ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.name} · {p.kind === 'budget' ? `Budget ${p.fiscalYear}` : 'Rolling forecast'}</option>
          ))}
        </select>
        {detail && (
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
        <select className={selectCls} value={preset} onChange={e => setPreset(e.target.value as Preset)} aria-label="Range">
          <option value="plan">{detail ? 'Plan range' : 'Current year'}</option>
          <option value="ytd">Year to date</option>
          <option value="current_year">Current year</option>
          <option value="prior_year">Prior year</option>
          <option value="next_12">Next 12 months</option>
          <option value="next_24">Next 24 months</option>
          <option value="custom">Custom</option>
        </select>
        <Input type="month" className="h-9 w-[9.5rem]" value={start} aria-label="From" onChange={e => { setPreset('custom'); setStart(e.target.value) }} />
        <Input type="month" className="h-9 w-[9.5rem]" value={end} aria-label="To" onChange={e => { setPreset('custom'); setEnd(e.target.value) }} />
        <div className="inline-flex rounded-md border border-input p-0.5" role="group" aria-label="Interval">
          {(['month', 'quarter', 'year'] as Interval[]).map(i => (
            <button key={i} type="button" onClick={() => setInterval(i)}
              className={cn('h-8 rounded-sm px-3 text-sm capitalize', interval === i ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {i === 'month' ? 'Monthly' : i === 'quarter' ? 'Quarterly' : 'Annual'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {detail?.stale && !versionId && (
            <Button variant="outline" size="sm" onClick={() => save({})} disabled={busy}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh actuals
            </Button>
          )}
          {detail && !versionId && (
            <Button variant="outline" size="sm" onClick={() => setPublishing(true)} disabled={busy}>Publish…</Button>
          )}
          {detail && !versionId && detail.vehicleKind !== 'manco' && (
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Include portfolio construction's investments, exits, capital calls and distributions">
              <input type="checkbox" checked={detail.plan.includeConstruction} disabled={busy}
                onChange={e => save({ patch: { includeConstruction: e.target.checked } })} />
              Construction flows
            </label>
          )}
          <Button variant="outline" size="sm" onClick={() => setLinking(true)}>Fee links</Button>
          <Button variant="outline" size="sm" asChild>
            <a href={exportHref}><Download className="mr-1.5 h-4 w-4" /> CSV</a>
          </Button>
          {hasAIKey && (
            <Button variant="outline" size="sm" onClick={draftWithAi}><Sparkles className="mr-1.5 h-4 w-4" /> Draft with AI</Button>
          )}
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New plan</Button>
        </div>
      </div>

      {plans && plans.length === 0 && !listError && (
        <EmptyState className="mb-6" action={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" /> New plan</Button>}>
          No budgets or forecasts for {vehicle} yet. The actuals below come straight from the posted ledger.
        </EmptyState>
      )}

      {series && (
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Books closed through <span className="text-foreground">{series.closedThrough ?? 'never'}</span></span>
          {series.actualsThrough && <span>Actuals through <span className="text-foreground">{series.actualsThrough}</span></span>}
          {series.plan && <span>{series.version ? `Version ${series.version.versionNo} (${series.version.status})` : 'Working draft'}</span>}
        </div>
      )}

      {[...((view === 'variance' ? variance?.warnings : series?.warnings) ?? []), ...(detail && !versionId ? detail.warnings : [])]
        .filter((w, i, all) => all.indexOf(w) === i)
        .map(w => (
          <div key={w} className="mb-2 flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{w}</span>
          </div>
        ))}
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
              {(['pnl', 'cash'] as const).map(s => (
                <button key={s} type="button" onClick={() => setStatement(s)}
                  className={cn('h-8 rounded-sm px-3 text-sm', statement === s ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {s === 'pnl' ? 'P&L' : 'Cash'}
                </button>
              ))}
            </div>
            {editable && statement === 'pnl' && <span className="text-xs text-muted-foreground">Click a forecast month to override it; click an account to set its rule.</span>}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          <div className="overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="sticky left-0 z-10 min-w-[14rem] bg-muted px-3 py-2 text-left font-medium">Account</th>
                  {series.periods.map(p => (
                    <th key={p.key} className={cn('min-w-[7rem] px-3 py-2 text-right font-medium', series.boundary && p.months.includes(series.boundary) && p.months[p.months.length - 1] === series.boundary && 'border-r-2 border-r-foreground/30')}>
                      <div>{p.label}</div>
                      <div className={cn('text-xs', p.status === 'actual_unclosed' ? 'font-medium text-foreground' : p.status === 'actual' ? 'font-normal text-muted-foreground' : 'font-normal text-info')}>{STATUS_LABEL[p.status]}</div>
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
                    <TotalRow label="Net cash movement" values={series.cash.map(c => c?.movement ?? null)} fmt={full} />
                    <TotalRow label="Ending cash" values={series.cash.map(c => c?.ending ?? null)} fmt={full} strong />
                  </>
                )}
              </tbody>
            </table>
          </div>

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
