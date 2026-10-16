'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Plus } from 'lucide-react'
import { useAnalystContext } from '@/components/analyst-context'
import { useCurrency, formatCurrency, formatCurrencyFull } from '@/components/currency-context'
import { useLedgerFetch, useVehicle } from '@/components/accounting-vehicle'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { addMonths, presetRange, type Interval, type MonthKey, type RangePreset } from '@/lib/forecast/months'
import type { PlanDetail, PlanReturnsResponse, SeriesResult, VarianceResponse } from '@/lib/forecast/service'
import { CashChart, PnlChart } from './charts'
import { cashFlowForecastState } from './chart-visibility'
import { FeeLinksDialog } from './fee-links'
import { RuleDialog, type RuleSubmit } from './rule-dialog'
import { MonthRangePicker, MoreMenu, NewPlanMenu, type RangeChoice } from './toolbar'
import { VarianceSection } from './variance'
import { ForecastEntries } from './entries'
import { ConstructionView } from '../construction/view'
import { PlanOverview } from './overview'
import { onApplied } from '@/lib/pending-actions/applied-event'
import { NO_ADJUSTMENTS } from '@/lib/forecast/adjustments'

type PlanListItem = PlanDetail['plan'] & { versions: { id: string; versionNo: number; label: string | null; status: string; publishedAt: string }[] }
type View = 'combined' | 'plan' | 'actual' | 'variance'
type Preset = RangeChoice

const selectCls = 'h-9 rounded-md border border-input bg-background px-2 text-sm'
// The toolbar's controls take the muted style the rest of the app's action buttons use.
const toolbarSelectCls = cn(selectCls, 'text-muted-foreground')

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

export type ForecastTab = 'charts' | 'investments' | 'capital' | 'financials'

const TAB_LABEL: Record<ForecastTab, string> = { charts: 'Charts', investments: 'Investments', capital: 'Capital planning', financials: 'Financials' }

/**
 * Forecast — one plan (plans/plan-unified-plan.md §5). Its key figures and charts sit on top, where
 * every choice shows at once, and four tabs below: **Investments** (the deals, their timing and
 * exits), **Capital planning** (commitment use, reserves, calls and distributions, cash),
 * **Financials** (fees, expenses, the P&L and its entries) and **Returns** (net returns by year and
 * their simulated range). A management company has no portfolio: Financials and Capital planning.
 */
export function ForecastView({ vehicle, vehicleId, kind, initialTab }: { vehicle: string; vehicleId: string | null; kind?: string | null; initialTab?: ForecastTab }) {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const full = useCallback((v: number | null | undefined) => formatCurrencyFull(v ?? null, currency), [currency])
  const short = useCallback((v: number | null) => formatCurrency(v, currency), [currency])

  const [plans, setPlans] = useState<PlanListItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [planId, setPlanId] = useState<string>('')
  const [versionId, setVersionId] = useState<string>('')
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const hasPortfolio = kind !== 'manco'
  const tabs = useMemo<ForecastTab[]>(() => (hasPortfolio ? ['charts', 'investments', 'capital', 'financials'] : ['charts', 'financials', 'capital']), [hasPortfolio])
  const [tab, setTabState] = useState<ForecastTab>(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0])
  // Bumped by every portfolio save, so the overview recomputes (fund saves move the plan's revision).
  const [portfolioSaves, setPortfolioSaves] = useState(0)
  const portfolioTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [chartsSlot, setChartsSlot] = useState<HTMLDivElement | null>(null)
  const [usageSlot, setUsageSlot] = useState<HTMLDivElement | null>(null)
  const [outcomesSlot, setOutcomesSlot] = useState<HTMLDivElement | null>(null)
  // Remounts the construction view after an Analyst edit to it is approved (it reloads on mount).
  const [constructionReload, setConstructionReload] = useState(0)
  const refreshFromPortfolioRef = useRef<(() => void) | null>(null)
  const [view, setView] = useState<View>('combined')
  const [preset, setPreset] = useState<Preset>('plan')
  const [start, setStart] = useState<MonthKey>(`${thisMonth().slice(0, 4)}-01`)
  const [end, setEnd] = useState<MonthKey>(`${thisMonth().slice(0, 4)}-12`)
  const [interval, setIntervalChoice] = useState<Interval>('month')
  const [statement, setStatement] = useState<'pnl' | 'cash' | 'entries'>('pnl')
  // Accrual or cash basis, for both statements: the income statement by when income and expenses are
  // earned and incurred, or when their cash moves; the cash-flow statement by the indirect method
  // (from net income) or the direct one.
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual')
  // A period clicked on a statement: the Entries tab opens on its months.
  const [entryMonths, setEntryMonths] = useState<string[] | null>(null)
  const openEntries = (months: string[]) => { if (detail) { setEntryMonths(months); setStatement('entries'); setTabState('financials') } }
  // A capital call or distribution being typed over (forecast months).
  const [cashEdit, setCashEdit] = useState<{ key: string; index: number; value: string } | null>(null)
  const commitCashEdit = async () => {
    if (!cashEdit || !detail || !series) return
    const raw = cashEdit.value.replace(/[$,\s()]/g, '')
    const e = cashEdit
    setCashEdit(null)
    const month = series.periods[e.index].months[0]
    // Calls and distributions are capital management (lib/forecast/capital.ts): the typed figure is
    // that month's edit, and a blank goes back to the plan's policy. The waterfall reruns on it.
    // (Investments and exits are entered on the Investments tab, not here.)
    if (e.key !== 'called' && e.key !== 'distributed') return
    if (raw !== '' && !Number.isFinite(Number(raw))) return
    const cap = detail.plan.capital
    const field = e.key === 'called' ? 'calls' : 'distributions'
    const edits = { ...cap[field] }
    if (raw === '') delete edits[month]
    else edits[month] = Math.abs(Number(raw))
    // A figure typed before calls and distributions were capital edits was a hand entry: drop it.
    const legacyId = `cell-${e.key}-${month}`
    const adj = detail.plan.adjustments ?? NO_ADJUSTMENTS
    await save({
      capital: { ...cap, [field]: edits },
      ...(adj.entries.some(x => x.id === legacyId) ? { adjustments: { ...adj, entries: adj.entries.filter(x => x.id !== legacyId) } } : {}),
    })
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
  const [capitalOpen, setCapitalOpen] = useState(false)
  const [returnAssumptionsOpen, setReturnAssumptionsOpen] = useState(false)
  // Bumped by Add Investment: the construction view adds a planned deal and opens it.
  const [addInvestment, setAddInvestment] = useState(0)
  const [linking, setLinking] = useState(false)
  const { ask, hasAIKey, open: analystOpen } = useAnalystContext()
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

  const [plansReady, setPlansReady] = useState(false)
  const initialPlan = useRef<{ fetcher: typeof lf; detail: PlanDetail } | null>(null)
  const planListSeq = useRef(0)
  const loadPlans = useCallback(async (includeInitial = false) => {
    const seq = ++planListSeq.current
    try {
      const res = await json<{ plans: PlanListItem[]; initialPlan?: PlanDetail | null }>(await lf(`/api/accounting/forecast${includeInitial ? '?initial=1' : ''}`))
      if (seq !== planListSeq.current) return []
      if (includeInitial) initialPlan.current = res.initialPlan ? { fetcher: lf, detail: res.initialPlan } : null
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
    let cancelled = false
    setPlansReady(false)
    loadPlans(true).then(ps => { if (!cancelled) { setPlanId(ps[0]?.id ?? ''); setPlansReady(true) } })
    return () => { cancelled = true; planListSeq.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPlans])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return null }
    const cached = initialPlan.current
    initialPlan.current = null
    const d = cached?.fetcher === lf && cached.detail.plan.id === id
      ? cached.detail
      : await json<PlanDetail>(await lf(`/api/accounting/forecast/${id}`))
    setDetail(d)
    return d
  }, [lf])

  // An Analyst draft approved in the panel lands here without a page refresh: a new plan is opened,
  // a changed one reloaded.
  useEffect(() => onApplied(({ actionType, result }) => {
    // A deal or exit the Analyst changed on the Investments tab: reload that view, then recompile.
    if (actionType === 'update_portfolio_construction') {
      setConstructionReload(n => n + 1)
      refreshFromPortfolioRef.current?.()
      return
    }
    if (!/forecast_plan$/.test(actionType)) return
    // An update returns the same plan's id: reload it in place. A new plan's id switches to it (and
    // the planId effect loads it). Reloading the plan moves the range to its new window, and the
    // plan list's change re-fetches the figures — no browser refresh.
    const id = (result as { planId?: string } | null)?.planId ?? planId
    loadPlans().then(() => {
      if (id && id !== planId) setPlanId(id)
      else if (id) loadDetail(id).catch(e => setActionError((e as Error).message))
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
    if (detail) setView('combined')
    else setView('actual')
  }, [detail?.plan.id, detail?.plan.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const seriesQuery = useMemo(() => {
    const q = new URLSearchParams({ start, end, interval, view: !planId ? 'actual' : view === 'variance' ? 'combined' : view })
    if (planId) q.set('plan', planId)
    if (versionId) q.set('version', versionId)
    return q.toString()
  }, [start, end, interval, view, planId, versionId])

  // Only the latest request's answer is shown: a plan reload can fire one for the old range and one
  // for the new, and the old one must not land last.
  const seriesSeq = useRef(0)
  const loadSeries = useCallback(async () => {
    if (!plansReady || (planId && detail?.plan.id !== planId)) return
    if (start > end) { setSeriesError('The start month is after the end month'); return }
    const seq = ++seriesSeq.current
    setLoading(true)
    try {
      const next = maskNoData(await json<SeriesResult>(await lf(`/api/accounting/forecast/series?${seriesQuery}`)))
      if (seq !== seriesSeq.current) return
      setSeries(next)
      setSeriesError(null)
    } catch (e) {
      if (seq === seriesSeq.current) setSeriesError((e as Error).message)
    } finally {
      if (seq === seriesSeq.current) setLoading(false)
    }
  }, [lf, seriesQuery, start, end, plansReady, planId, detail?.plan.id])

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
  }, [detail, lf, loadSeries, setBusy, setActionError])

  // A copy of the open plan as a new scenario — its portfolio, rules, capital and hand edits.
  const copyAsScenario = useCallback(async () => {
    if (!detail) return
    setBusy(true)
    setActionError(null)
    try {
      const p = detail.plan
      const res = await json<PlanDetail>(await lf('/api/accounting/forecast', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: p.kind, name: `${p.name} (copy)`,
          fiscalYear: p.kind === 'budget' ? p.fiscalYear : undefined,
          horizonMonths: p.kind === 'rolling_forecast' ? p.horizonMonths ?? undefined : undefined,
          seed: { from: 'plan', planId: p.id },
        }),
      }))
      await loadPlans()
      setPlanId(res.plan.id)
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [detail, lf, loadPlans, setBusy, setActionError])

  // A draft out of date with its sources (the investments, a linked fund, the books) is recompiled as
  // soon as it opens, once per revision — the figures should never wait on a Refresh click. If the
  // recompile fails, the error shows and Refresh stays.
  const autoRefreshed = useRef(new Set<string>())
  useEffect(() => {
    if (!detail?.stale || versionId || busy) return
    const key = `${detail.plan.id}:${detail.plan.revision}`
    if (autoRefreshed.current.has(key)) return
    autoRefreshed.current.add(key)
    save({})
  }, [detail, versionId, busy, save])

  // The headline charts follow the page's timescale: the same periods the statements show, with the
  // carry split out of each period's distributions (the plan's carry entries, by month).
  const headline = useMemo(() => {
    if (!series?.cashFlows) return null
    const cash = new Set(detail?.cashAccountIds ?? [])
    const carryByMonth = new Map<string, number>()
    for (const e of detail?.entries ?? []) {
      if (e.kind !== 'carry_distribution') continue
      const c = Math.abs(e.postings.filter(p => cash.has(p.accountId)).reduce((sum, p) => sum + p.amount, 0))
      carryByMonth.set(e.date.slice(0, 7), (carryByMonth.get(e.date.slice(0, 7)) ?? 0) + c)
    }
    const periods = series.periods.map((p, i) => {
      const last = p.months[p.months.length - 1]
      const carry = p.months.reduce((sum, m) => sum + (carryByMonth.get(m) ?? 0), 0)
      const distributed = Math.abs(series.cashFlows!.distributed[i] ?? 0)
      return {
        label: p.label, year: Number(last.slice(0, 4)), yearEnd: last.slice(5, 7) === '12' || i === series.periods.length - 1, lastMonth: last,
        actual: p.status === 'actual' || p.status === 'actual_unclosed',
        called: Math.abs(series.cashFlows!.called[i] ?? 0), distributed: Math.max(0, distributed - carry), carry,
      }
    })
    return { periods, years: { first: Number(start.slice(0, 4)), last: Number(end.slice(0, 4)) } }
  }, [series, detail, start, end])

  // Capital planning over the page's date range: calls, distributions, investment and each fee and
  // expense as cash, split actual / forecast by the periods' status — the cash-flow statement's
  // figures, so the two cannot disagree.
  const rangeFlows = useMemo(() => {
    if (!series?.cashFlows || !detail) return null
    const accounts = new Map(detail.allAccounts.map(a => [a.id, a]))
    const zero = () => ({ actual: 0, forecast: 0 })
    const out = { called: zero(), distributed: zero(), invested: zero(), fees: zero(), org: zero(), partnership: zero(), label: `${start} – ${end}` }
    series.periods.forEach((p, i) => {
      if (p.status === 'none') return
      const k = p.status === 'actual' || p.status === 'actual_unclosed' ? 'actual' : 'forecast'
      out.called[k] += Math.max(0, series.cashFlows!.called[i] ?? 0)
      out.distributed[k] += Math.abs(Math.min(0, series.cashFlows!.distributed[i] ?? 0))
      out.invested[k] += Math.abs(Math.min(0, series.cashFlows!.invested[i] ?? 0))
      for (const l of series.cashDetail ?? []) {
        if (l.section !== 'operating') continue
        const a = accounts.get(l.key)
        if (!a || a.type !== 'expense') continue
        const paid = -(l.values[i] ?? 0)
        if (a.subtype === 'management_fee') out.fees[k] += paid
        else if (a.subtype === 'organizational_expense') out.org[k] += paid
        else out.partnership[k] += paid
      }
    })
    return out
  }, [series, detail, start, end])

  // The plan's returns, once per change, with the simulation: the key figures above the tabs and the
  // cash-flow chart's range both read this one response (lib/forecast/plan-returns.ts).
  const returnsPlanId = hasPortfolio ? (detail?.plan.id ?? (planId || null)) : null
  const [planReturns, setPlanReturns] = useState<PlanReturnsResponse | null>(null)
  const [planReturnsError, setPlanReturnsError] = useState<string | null>(null)
  const returnsKey = `${returnsPlanId}:${detail?.plan.revision ?? 0}:${portfolioSaves}`
  useEffect(() => {
    if (!returnsPlanId) { setPlanReturns(null); return }
    let cancelled = false
    fetch(`/api/accounting/forecast/returns?group=${encodeURIComponent(vehicle)}&plan=${encodeURIComponent(returnsPlanId)}&simulate=1`)
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!r.ok) throw new Error(d?.error || 'Could not load the plan\u2019s returns.')
        return d as PlanReturnsResponse
      })
      .then(d => { if (!cancelled) { setPlanReturns(d); setPlanReturnsError(null) } })
      .catch(e => { if (!cancelled) setPlanReturnsError((e as Error).message) })
    return () => { cancelled = true }
  }, [vehicle, returnsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Whether there is a cash-flow forecast for the Charts tab's time-series charts to draw.
  const forecastState = cashFlowForecastState(plans, planId, detail)
  const showForecastCharts = !hasPortfolio || forecastState === 'present'

  const setTab = useCallback((next: ForecastTab) => {
    setTabState(next)
    try {
      const url = new URL(window.location.href)
      if (next === tabs[0]) url.searchParams.delete('tab'); else url.searchParams.set('tab', next)
      window.history.replaceState(null, '', url)
    } catch { /* the URL is a convenience */ }
  }, [tabs])

  // A portfolio save changes the plan under the fund forecast (and bumps its revision): recompile the
  // draft so its months show the new deals, and recompute the overview — shortly after the last
  // save, so typing through a deal's fields recompiles once.
  const refreshFromPortfolio = useCallback(async () => {
    setPortfolioSaves(n => n + 1)
    const ps = await loadPlans().catch(() => null)
    const id = planId || ps?.[0]?.id
    if (!id) return
    if (id !== planId) { setPlanId(id); return }
    try {
      const d = await loadDetail(id)
      if (d?.stale) {
        const next = await json<PlanDetail>(await lf(`/api/accounting/forecast/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: d.plan.revision }),
        }))
        setDetail(next)
      }
      await loadSeries()
    } catch (e) {
      setActionError((e as Error).message)
    }
  }, [planId, loadPlans, loadDetail, lf, loadSeries, setActionError])
  useEffect(() => { refreshFromPortfolioRef.current = () => { refreshFromPortfolio() } }, [refreshFromPortfolio])
  const onPortfolioSaved = useCallback(() => {
    if (portfolioTimer.current) clearTimeout(portfolioTimer.current)
    portfolioTimer.current = setTimeout(() => { refreshFromPortfolio() }, 600)
  }, [refreshFromPortfolio])
  useEffect(() => () => { if (portfolioTimer.current) clearTimeout(portfolioTimer.current) }, [])

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
      description="Actuals and rolling forecasts of investments and returns"
      vehicle={vehicle}
      vehicleId={vehicleId}
    >
      {listError && <p className="mb-4 text-sm text-destructive">{listError}</p>}

      {/* One row: which plan (a chip each, when there is more than one), how you are looking at
          it, and on the right what you can do — refresh, settings, a new plan. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
        {/* Only once something has been published: before that the working draft is all there is. */}
        {detail && detail.versions.length > 0 && (
          <select className={toolbarSelectCls} value={versionId} onChange={e => setVersionId(e.target.value)} aria-label="Version">
            <option value="">Working draft</option>
            {detail.versions.map(v => (
              <option key={v.id} value={v.id}>{v.status === 'approved' ? 'Budget' : 'Scenario'} {v.versionNo}{v.label ? ` · ${v.label}` : ''}</option>
            ))}
          </select>
        )}
        {/* The dates decide what is actual and what is forecast (actuals through the cutoff, the
            plan after it), so there is no view to choose — only, once the plan has a saved budget,
            whether to measure against it. */}
        {detail && tab === 'financials' && detail.versions.some(v => v.status === 'approved') && (
          <Button variant="outline" aria-pressed={view === 'variance'} onClick={() => setView(v => (v === 'variance' ? 'combined' : 'variance'))}
            className={cn(view === 'variance' ? 'bg-accent text-foreground' : 'text-muted-foreground')}>
            Variance
          </Button>
        )}
        {detail && tab === 'financials' && view === 'variance' && (
          <>
            <select className={toolbarSelectCls} value={baseVersion} onChange={e => setBaseVersion(e.target.value)} aria-label="Measured against">
              {detail.versions.some(v => v.status === 'approved') && <option value="approved">Against the budget</option>}
              <option value="draft">Against the working draft</option>
              {detail.versions.map(v => <option key={v.id} value={v.id}>Against {v.status === 'approved' ? 'budget' : 'scenario'} {v.versionNo}{v.label ? ` · ${v.label}` : ''}</option>)}
            </select>
            <select className={toolbarSelectCls} value={compare} onChange={e => setCompare(e.target.value)} aria-label="Compare">
              <option value="actual">Actuals</option>
              {(plans ?? []).filter(p => p.id !== detail.plan.id).map(p => <option key={p.id} value={p.id}>{p.name} (latest)</option>)}
            </select>
          </>
        )}
        {(<>
        <MonthRangePicker
          preset={preset} onPreset={setPreset}
          start={start} end={end}
          onStart={m => { setPreset('custom'); setStart(m) }}
          onEnd={m => { setPreset('custom'); setEnd(m) }}
          planLabel={detail ? 'Plan range' : 'Current year'}
        />
        {/* Presentation only: storage and every calculation stay monthly; the server re-adds the
            months into quarters or years for the table, every chart, the variance and the CSV alike. */}
        <select className={toolbarSelectCls} value={interval} onChange={e => setIntervalChoice(e.target.value as Interval)} aria-label="Show by">
          <option value="month">Monthly</option>
          <option value="quarter">Quarterly</option>
          <option value="year">Annual</option>
        </select>
        </>)}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ForecastNotes
            planKey={planId || `actuals:${vehicle}`}
            notes={[...((view === 'variance' ? variance?.warnings : series?.warnings) ?? []), ...(detail && !versionId ? detail.warnings : [])]
              // Said elsewhere: unclosed months in the status line; out of date by the Refresh button.
              .filter(w => !/include months that are not closed|later actual months are not final|out of date/.test(w))
              .filter((w, i, all) => all.indexOf(w) === i)}
          />
          {detail?.stale && !versionId && (
            <Button variant="outline" size="icon" className="text-muted-foreground" onClick={() => save({})} disabled={busy}
              aria-label="Refresh — the investments, a linked fund or the books changed since this forecast was worked out"
              title="Refresh — the investments, a linked fund or the books changed since this forecast was worked out">
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
          {hasPortfolio && !versionId && (
            <Button variant="outline" className="text-muted-foreground" onClick={() => { setTab('investments'); setAddInvestment(n => n + 1) }}>
              {/* Shorter while the Analyst panel narrows the page. */}
              <Plus className="mr-1.5 h-4 w-4" /> {analystOpen ? 'Investment' : 'Add Investment'}
            </Button>
          )}
          <MoreMenu items={[
            { label: 'Return assumptions', onSelect: () => setReturnAssumptionsOpen(true), hidden: !hasPortfolio || !!versionId },
            { label: 'Calls and distributions', onSelect: () => setCapitalOpen(true), hidden: !detail || !!versionId || detail.vehicleKind === 'manco', disabled: busy },
            { label: 'Entity links', onSelect: () => setLinking(true) },
            { label: 'Download Excel', href: `${exportHref}&format=xlsx` },
            { label: 'Download CSV', href: exportHref },
          ]} />
          <NewPlanMenu onManual={() => setCreating(true)} onDraftWithAi={hasAIKey ? draftWithAi : undefined} onCopy={detail && !versionId ? copyAsScenario : undefined} onSave={detail && !versionId ? () => setPublishing(true) : undefined} />
        </div>
      </div>
      {plans && plans.length === 0 && !listError && (
        // No button: New plan is right above, and the actuals below are the page's content, not a void.
        <p className="mb-4 text-sm text-muted-foreground">
          No budgets or forecasts for {vehicle} yet.{hasPortfolio ? ' Change anything below and its plan is made for you.' : ' The actuals below come straight from the posted ledger.'}
        </p>
      )}

      {actionError && <p className="mb-3 text-sm text-destructive">{actionError}</p>}
      {seriesError && <p className="mb-3 text-sm text-destructive">{seriesError}</p>}

      {hasPortfolio && (
        <PlanOverview planId={returnsPlanId} data={planReturns} error={planReturnsError} fmt={short} />
      )}


      {tabs.length > 1 && (
        <div className="mb-4 flex overflow-x-auto border-b" role="tablist" aria-label="Forecast">
          {tabs.map(k => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm', tab === k ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      )}


      {/* Charts: every chart on the page, in one place. The construction view draws its own into the
          slots (cash flows and multiples by year; committed capital usage; the outcome histogram);
          they stay mounted on the other tabs, just hidden. */}
      <div className={cn('mb-6 space-y-6', tab !== 'charts' && 'hidden')}>
        {/* Without a cash-flow forecast, only the charts that stand on the portfolio and the calls to
            date: the cash-flow, multiples, income and cash charts would plot actuals against an
            empty future (./chart-visibility.ts). A management company has only those, so keeps them. */}
        {hasPortfolio && forecastState === 'none' && (
          <p className="text-sm text-muted-foreground">More charts appear here once a cash flow forecast is created.</p>
        )}
        {showForecastCharts && hasPortfolio && <div ref={setChartsSlot} className="empty:hidden" />}
        {showForecastCharts && series && (
          <div className="grid gap-4 lg:grid-cols-2">
            <PnlChart series={series} fmt={short} />
            <CashChart series={series} fmt={short} />
          </div>
        )}
        {hasPortfolio && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div ref={setUsageSlot} className="empty:hidden" />
            <div ref={setOutcomesSlot} className="empty:hidden" />
          </div>
        )}
      </div>

      {hasPortfolio && (
        // One construction view for the three tabs that show part of it, so an edit in progress
        // survives a tab switch; hidden (not unmounted) on Financials.
        <div className={cn('mb-6', (tab === 'financials' || tab === 'charts') && 'hidden')}>
          {versionId && tab !== 'financials' && <p className="mb-3 text-sm text-muted-foreground">A saved scenario&rsquo;s portfolio is saved with it; this is the working draft&rsquo;s, which you can still change.</p>}
          <ConstructionView
            key={`${planId || 'primary'}:${constructionReload}`}
            section={tab === 'financials' || tab === 'charts' ? 'investments' : tab}
            chartsSlot={chartsSlot}
            usageSlot={usageSlot}
            outcomesSlot={outcomesSlot}
            headline={headline}
            addInvestment={addInvestment}
            planReturns={planReturns}
            rangeFlows={rangeFlows}
            assumptionsOpen={returnAssumptionsOpen}
            onAssumptionsClose={() => setReturnAssumptionsOpen(false)}
            vehicle={vehicle}
            planId={planId || null}
            onSaved={onPortfolioSaved}
          />
        </div>
      )}

      {tab === 'financials' && (<>
      {tab === 'financials' && view === 'variance' && variance && (
        <VarianceSection
          data={variance}
          fmt={full}
          short={short}
          baseLabel={baseVersion === 'approved' ? 'Budget' : baseVersion === 'draft' ? 'Draft' : `Scenario ${detail?.versions.find(v => v.id === baseVersion)?.versionNo ?? ''}`}
          compareLabel={compare === 'actual' ? 'Actual' : (plans ?? []).find(p => p.id === compare)?.name ?? 'Plan'}
        />
      )}


      {loading && !series && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}

      {series && view !== 'variance' && tab === 'financials' && (
        <>
          {/* How to change the statement, above the statement switcher. */}
          <p className="mb-2 text-xs text-muted-foreground empty:hidden">
            {editable && statement === 'pnl' && basis === 'accrual' && <span>Click a forecast month to change it, an account to set its rule, or a period heading to see its entries.</span>}
            {detail && statement === 'cash' && <span>{interval === 'month' && !versionId ? 'Click a forecast contribution or distribution to change it; investments and exits are changed on Investments. Any other figure shows its entries.' : 'Click a figure to see the entries behind it.'}</span>}
            {!editable && detail && !versionId && interval !== 'month' && statement === 'pnl' && (
              <span>Showing {interval === 'quarter' ? 'quarters' : 'years'} — switch to Monthly to override a month.</span>
            )}
          </p>
          <div className="mb-2 flex items-center gap-2">
            <div className="inline-flex shrink-0 rounded-md border border-input p-0.5" role="group" aria-label="Statement">
              {(detail ? (['pnl', 'cash', 'entries'] as const) : (['pnl', 'cash'] as const)).map(s => (
                <button key={s} type="button" onClick={() => { setStatement(s); if (s !== 'entries') setEntryMonths(null) }}
                  className={cn('h-8 whitespace-nowrap rounded-sm px-3 text-sm', statement === s ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {s === 'pnl' ? 'Income Statement' : s === 'cash' ? 'Statement of Cash Flows' : 'Journal Entries'}
                </button>
              ))}
            </div>
            {statement !== 'entries' && (
              <select className={cn(toolbarSelectCls, "h-9")} value={basis} onChange={e => setBasis(e.target.value as 'accrual' | 'cash')} aria-label="Basis">
                <option value="accrual">Accrual basis</option>
                <option value="cash">Cash basis</option>
              </select>
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
              onOpenInvestments={hasPortfolio ? () => setTab('investments') : undefined}
              vehicle={vehicle}
              range={{ start, end }}
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
                {statement === 'pnl' && basis === 'cash' && series.cashBasis ? (
                  // Cash basis: each line as the cash it moved, when it moved. Read-only — rules and
                  // overrides set the accrual figures, and the cash follows from their timing.
                  <>
                    <SectionRow label="Revenue (cash received)" span={series.periods.length} />
                    {series.cashBasis.lines.filter(l => l.type === 'income').map(l => <PlainRow key={l.accountId} label={l.name} code={l.code} values={l.values} fmt={full} />)}
                    <TotalRow label="Total revenue" values={series.cashBasis.revenue} fmt={full} />
                    <SectionRow label="Expenses (cash paid)" span={series.periods.length} />
                    {series.cashBasis.lines.filter(l => l.type === 'expense').map(l => <PlainRow key={l.accountId} label={l.name} code={l.code} values={l.values} fmt={full} />)}
                    {series.cashBasis.accruals.some(v => Math.abs(v ?? 0) >= 0.005) && (
                      <PlainRow label="Earlier accruals paid or collected" values={series.cashBasis.accruals.map(v => (v == null ? null : -v))} fmt={full}
                        title="Payables, accrued costs and prepaid fees settled in cash, on entries that name no income or expense account" />
                    )}
                    <TotalRow label="Total expenses" values={series.cashBasis.expenses.map((v, i) => v - (series.cashBasis!.accruals[i] ?? 0))} fmt={full} />
                    <TotalRow label="Net income (cash basis)" values={series.cashBasis.netIncome} fmt={full} strong />
                  </>
                ) : statement === 'pnl' ? (
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
                    {basis === 'accrual' && series.indirect && (
                      // The indirect method: from net income to operating cash.
                      <>
                        <SectionRow label={SECTION_LABEL.operating} span={series.periods.length} />
                        <PlainRow label="Net income" values={series.indirect.netIncome} fmt={full} />
                        <PlainRow label="Less investment gains (not operating cash)" values={series.indirect.investmentGains} fmt={full} />
                        <PlainRow label="Change in accruals, prepaids and payables" values={series.indirect.workingCapital} fmt={full} />
                        <TotalRow label="Net cash from operating activities" values={series.indirect.operating} fmt={full} />
                      </>
                    )}
                    {(['operating', 'investing', 'financing'] as const).filter(section => !(section === 'operating' && basis === 'accrual' && series.indirect)).map(section => {
                      const lines = (series.cashDetail ?? []).filter(l => l.section === section)
                      // On a draft by month, the lines a figure can be typed into show even when empty —
                      // so a distribution can be added to a plan that has none yet.
                      if (detail && !versionId && interval === 'month') {
                        const wanted: Record<string, { key: string; label: string }[]> = {
                          financing: [{ key: 'called', label: 'Capital contributions' }, { key: 'distributed', label: 'Distributions' }],
                        }
                        for (const w of wanted[section] ?? []) {
                          if (!lines.some(l => l.key === w.key)) lines.push({ section, key: w.key, label: w.label, code: null, values: series.periods.map(() => 0) } as (typeof lines)[number])
                        }
                      }
                      if (!lines.length) return null
                      const total = series.periods.map((p, i) => (p.status === 'none' ? null : lines.filter(l => !l.parent).reduce((s, l) => s + (l.values[i] ?? 0), 0)))
                      return (
                        <CashSectionRows key={section} section={section} lines={lines} total={total} span={series.periods.length} fmt={full}
                          onCell={detail ? i => openEntries(series.periods[i].months) : undefined}
                          canEdit={(key, i) => !!detail && !versionId && interval === 'month' && ['called', 'distributed'].includes(key)
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

      </>)}

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

      {detail && capitalOpen && (
        <CapitalPolicyDialog
          capital={detail.plan.capital}
          saving={busy}
          onClose={() => setCapitalOpen(false)}
          onSave={async policy => { if (await save({ capital: { ...detail.plan.capital, policy } })) setCapitalOpen(false) }}
          onClearEdits={async () => { await save({ capital: { ...detail.plan.capital, calls: {}, distributions: {} } }) }}
        />
      )}

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

/** A read-only statement line: label (and account code), then a figure per period. */
function PlainRow({ label, code, values, fmt, title }: { label: string; code?: string; values: (number | null)[]; fmt: (v: number | null) => string; title?: string }) {
  return (
    <tr className="border-b" title={title}>
      <td className="sticky left-0 z-10 bg-card px-3 py-2">{code && <span className="mr-1.5 font-mono text-xs text-muted-foreground">{code}</span>}{label}</td>
      {values.map((v, i) => <td key={i} className="px-3 py-2 text-right tabular-nums">{fmt(v)}</td>)}
    </tr>
  )
}

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
          <td className={cn('sticky left-0 z-10 bg-card px-3 py-2', l.parent && 'pl-6 text-muted-foreground')}>
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
        {rule?.warnings.length ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" onClick={e => e.stopPropagation()} className="text-sm text-warning underline-offset-4 hover:underline">{rule.warnings.length} note{rule.warnings.length === 1 ? '' : 's'}</button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-0 text-sm">
              <ul className="divide-y">
                {rule.warnings.map(w => <li key={w} className="px-3 py-2">{w}</li>)}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
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
          {kind === 'budget' ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Fiscal year</span>
              <Input inputMode="numeric" value={fiscalYear} onChange={e => setFiscalYear(e.target.value)} />
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Horizon</span>
              <select className={cn(selectCls, 'w-full')} value={horizon} onChange={e => setHorizon(e.target.value)}>
                {[12, 18, 24, 36, 60, 120, 180, 240].map(h => <option key={h} value={h}>{h < 60 ? `${h} months` : `${h / 12} years`}</option>)}
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
          <DialogTitle>Save scenario</DialogTitle>
          <DialogDescription>
            Saves {detail.plan.name} as it stands — investments, financials and capital — with actuals through {detail.cutoff}. A saved
            scenario never changes, so you can compare against it as actuals come in; later edits go into the working draft. A budget
            is the scenario the plan is measured against (one per plan).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Save as</span>
            <select className={cn(selectCls, 'w-full')} value={status} onChange={e => setStatus(e.target.value as any)}>
              <option value="published">Scenario</option>
              <option value="approved" disabled={hasApproved}>Budget{hasApproved ? ' (already set)' : ''}</option>
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
          <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/**
 * The forecast's notes — inferred exit months, missing accounts, a linked fund without a schedule —
 * in one panel rather than a banner each. Collapsed to a count; each can be dismissed, and stays
 * dismissed for this plan in this browser until its wording changes (a new note is a new fact).
 * "Out of date — refresh" is never hidden: it is the one that asks for an action.
 */
/**
 * The plan's notes — what the forecast assumed or could not do — behind one button beside Refresh, so
 * they are a click away without pushing the figures down. Each can be dismissed (remembered in this
 * browser), and dismissed ones brought back.
 */
function ForecastNotes({ planKey, notes }: { planKey: string; notes: string[] }) {
  const storageKey = `forecast-notes-dismissed:${planKey}`
  const [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => {
    try { setDismissed(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')) } catch { setDismissed([]) }
  }, [storageKey])
  const persist = (next: string[]) => {
    setDismissed(next)
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* private window: dismiss for this visit only */ }
  }
  const shown = notes.filter(n => !dismissed.includes(n))
  const hiddenCount = notes.length - shown.length
  if (notes.length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="text-muted-foreground" aria-label={`${shown.length} note${shown.length === 1 ? '' : 's'} on this forecast`}>
          <AlertTriangle className={cn('h-4 w-4', shown.length > 0 && 'text-warning')} />
          {shown.length > 0 && <span className="tabular-nums">{shown.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0 text-sm">
        <p className="border-b px-3 py-2 font-medium">Notes on this forecast</p>
        {shown.length === 0 && <p className="px-3 py-2 text-muted-foreground">No open notes.</p>}
        <ul className="divide-y">
          {shown.map(n => (
            <li key={n} className="flex items-start gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">{n}</span>
              <button type="button" onClick={() => persist([...dismissed, n])} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 && (
          <div className="border-t px-3 py-2">
            <button type="button" onClick={() => persist(dismissed.filter(d => !notes.includes(d)))} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
              Show {hiddenCount} dismissed
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * How the fund forecast works out calls and distributions when no month is set by hand
 * (lib/forecast/capital.ts): a cash reserve the calls keep the fund above, and when — and with what
 * left in the bank — exit proceeds are paid out. Months typed into the cash statement override it.
 */
function CapitalPolicyDialog({ capital, saving, onClose, onSave, onClearEdits }: {
  capital: PlanDetail['plan']['capital']
  saving: boolean
  onClose: () => void
  onSave: (policy: PlanDetail['plan']['capital']['policy']) => void
  onClearEdits: () => void
}) {
  const [callReserve, setCallReserve] = useState(String(capital.policy.calls.reserve || ''))
  const [lag, setLag] = useState(String(capital.policy.distributions.lagMonths || ''))
  const [distReserve, setDistReserve] = useState(String(capital.policy.distributions.reserve || ''))
  const n = (s: string) => Number(s.replace(/[$,\s]/g, '')) || 0
  const edits = Object.keys(capital.calls).length + Object.keys(capital.distributions).length
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Calls and distributions</DialogTitle>
          <DialogDescription>Default setting for capital calls and distributions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Keep at least this much cash — capital is called to cover any shortfall</span>
            <Input inputMode="decimal" value={callReserve} onChange={e => setCallReserve(e.target.value)} placeholder="0" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Distribute exit proceeds this many months after they arrive</span>
            <Input inputMode="numeric" value={lag} onChange={e => setLag(e.target.value)} placeholder="0" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Keep this much back when distributing</span>
            <Input inputMode="decimal" value={distReserve} onChange={e => setDistReserve(e.target.value)} placeholder="0" />
          </label>
          {edits > 0 && (
            <p className="text-xs text-muted-foreground">
              {edits} month{edits === 1 ? ' is' : 's are'} set by hand and override{edits === 1 ? 's' : ''} these.{' '}
              <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={onClearEdits}>Clear them</button>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={() => onSave({ calls: { reserve: n(callReserve) }, distributions: { lagMonths: Math.round(n(lag)), reserve: n(distReserve) } })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
