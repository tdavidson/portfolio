// The four dashboard layouts. Each takes a payload and returns the nodes to show.
//
// Every view has two densities. INLINE is a card in the conversation: the host fits it to its
// content and clips anything too tall, so it carries the headline figures, one chart and a way
// to open the rest. FULL is the whole dashboard, shown when the host gives the view the screen
// (or, on a host with no fullscreen, when the user expands it in place).

import { h } from './dom'
import { barChart, lineChart, type BarDatum } from './charts'
import { DASH, fractionPercent, multiple, percent, share, shortDate, titleCase, type Formatters } from './format'
import { button, dataTable, empty, note, section, segmented, tiles, type Column, type Tile } from './ui'
import {
  STATEMENT_PRESETS, STATEMENT_PRESET_LABEL, VIEW_TOOL,
  type CompanyMetricSeries, type CompanyPayload, type DashboardPayload, type LpPayload, type LpRow,
  type PartnerCapitalRow, type PortfolioPayload, type PortfolioPosition, type StatementPreset,
  type StatementsData, type StatementsPayload,
} from '../payload'

export interface ViewContext {
  fmt: Formatters
  /** True for the inline card; false for the full dashboard. */
  compact: boolean
  /** Whether "open the full dashboard" can do anything in this host. */
  canExpand: boolean
  expand(): void
  /** Run a dashboard tool and show its result: `push` keeps the current view to go back to. */
  open(tool: string, args: Record<string, unknown>, mode: 'push' | 'replace'): void
  /** Charts observe their container; this is called when the view is replaced. */
  onDispose(dispose: () => void): void
  /** Which statement is showing, kept across a period change. */
  statementTab: StatementTab
  setStatementTab(tab: StatementTab): void
}

export type StatementTab = 'balance' | 'income' | 'cash' | 'capital'

export function renderView(payload: DashboardPayload, ctx: ViewContext): Node[] {
  switch (payload.view) {
    case 'portfolio': return portfolio(payload, ctx)
    case 'company': return company(payload, ctx)
    case 'statements': return statements(payload, ctx)
    case 'lps': return lps(payload, ctx)
  }
}

const signed = (fmt: Formatters, v: number) => (v > 0 ? `+${fmt.compact(v)}` : fmt.compact(v))

function expandButton(ctx: ViewContext, label: string): HTMLElement | null {
  return ctx.compact && ctx.canExpand ? h('div', { class: 'actions' }, button(label, ctx.expand, 'primary')) : null
}

// ---------------------------------------------------------------------------------------------
// Portfolio overview
// ---------------------------------------------------------------------------------------------

function portfolio(payload: PortfolioPayload, ctx: ViewContext): Node[] {
  const { fmt } = ctx
  const { positions, totals, performance } = payload.data
  const out: Node[] = []

  const headline: Tile[] = [
    { label: 'Fair value', value: fmt.compact(totals.fairValue), sub: `${positions.length} ${positions.length === 1 ? 'position' : 'positions'}` },
    { label: 'Cost', value: fmt.compact(totals.cost) },
    { label: 'Unrealized gain', value: signed(fmt, totals.unrealized) },
    { label: 'Gross MOIC', value: multiple(totals.grossMoic), sub: totals.realized ? `${fmt.compact(totals.realized)} realized` : undefined },
  ]
  out.push(tiles(headline))

  // The inline card leads with the portfolio itself; the fund's own position is one tap away.
  if (!ctx.compact && performance && performance.length > 0) {
    // Summed across vehicles first; the ratios are of the sums, never an average of ratios.
    const t = performance.reduce((a, v) => ({
      committed: a.committed + v.committed, called: a.called + v.called,
      distributed: a.distributed + v.distributed, nav: a.nav + v.nav,
    }), { committed: 0, called: 0, distributed: 0, nav: 0 })
    const called = share(t.called, t.committed)
    out.push(section('Fund performance', tiles([
      {
        label: 'Called', value: fmt.compact(t.called),
        meter: called === null ? null : called / 100,
        sub: called === null ? `of ${fmt.compact(t.committed)} committed` : `${percent(called, 0)} of ${fmt.compact(t.committed)} committed`,
      },
      { label: 'Distributed', value: fmt.compact(t.distributed) },
      { label: 'DPI', value: multiple(t.called > 0 ? t.distributed / t.called : null), sub: 'Distributions to paid-in' },
      { label: 'TVPI', value: multiple(t.called > 0 ? (t.distributed + t.nav) / t.called : null), sub: 'Total value to paid-in' },
    ])))
  }

  if (positions.length === 0) {
    out.push(empty('No positions with a cost or fair value in this scope.'))
    return out
  }

  const openCompany = (p: PortfolioPosition) => ctx.open(VIEW_TOOL.company, { company: p.companyId, ...(payload.args.vehicle ? { vehicle: payload.args.vehicle } : {}) }, 'push')

  const shown = positions.slice(0, ctx.compact ? 5 : 12)
  const rest = positions.slice(shown.length)
  const bars: BarDatum[] = shown.map(p => ({
    label: p.company,
    value: p.fairValue,
    reference: p.cost,
    valueLabel: fmt.compact(p.fairValue),
    tooltip: [
      { value: fmt.money(p.fairValue), label: 'fair value' },
      { value: fmt.money(p.cost), label: 'cost' },
      { value: multiple(p.moic), label: 'MOIC' },
    ],
    onActivate: () => openCompany(p),
  }))
  if (rest.length > 0) {
    const fairValue = rest.reduce((s, p) => s + p.fairValue, 0)
    const cost = rest.reduce((s, p) => s + p.cost, 0)
    bars.push({
      label: `${rest.length} ${rest.length === 1 ? 'other' : 'others'}`,
      value: fairValue,
      reference: cost,
      valueLabel: fmt.compact(fairValue),
      tooltip: [{ value: fmt.money(fairValue), label: 'fair value' }, { value: fmt.money(cost), label: 'cost' }],
    })
  }
  out.push(section('Fair value and cost by company',
    barChart(bars, { valueName: 'Fair value', referenceName: 'Cost', ariaLabel: 'Fair value and cost by company, largest first' })))

  if (ctx.compact) {
    const more = expandButton(ctx, `See all ${positions.length} positions`)
    if (more) out.push(more)
    return out
  }

  const columns: Column<PortfolioPosition>[] = [
    { header: 'Company', cell: p => p.company, sort: p => p.company.toLowerCase() },
    { header: 'Stage', cell: p => p.stage ?? DASH, sort: p => p.stage ?? '', minWidth: 'lg' },
    { header: 'Status', cell: p => titleCase(p.status) || DASH, sort: p => p.status ?? '', minWidth: 'lg' },
    { header: 'Cost', numeric: true, cell: p => fmt.money(p.cost), sort: p => p.cost, minWidth: 'md' },
    { header: 'Fair value', numeric: true, cell: p => fmt.money(p.fairValue), sort: p => p.fairValue },
    { header: 'Unrealized', numeric: true, cell: p => fmt.money(p.unrealized), sort: p => p.unrealized, minWidth: 'md' },
    { header: 'MOIC', numeric: true, cell: p => multiple(p.moic), sort: p => p.moic ?? -Infinity },
    { header: '% of portfolio', numeric: true, cell: p => percent(p.pctOfPortfolio), sort: p => p.pctOfPortfolio, minWidth: 'md' },
  ]
  out.push(section('Holdings', dataTable(positions, columns, {
    caption: 'Every position with cost, fair value, unrealized gain, MOIC and share of the portfolio',
    onRow: openCompany,
    rowLabel: p => `Open ${p.company}`,
    initialSort: { column: 4, descending: true },
    footer: ['Total', '', '', fmt.money(totals.cost), fmt.money(totals.fairValue), fmt.money(totals.unrealized), multiple(totals.grossMoic), ''],
  })))

  if (performance && performance.length > 1) {
    out.push(section('By vehicle', dataTable(performance, [
      { header: 'Vehicle', cell: v => v.vehicle, sort: v => v.vehicle.toLowerCase() },
      { header: 'Committed', numeric: true, cell: v => fmt.money(v.committed), sort: v => v.committed, minWidth: 'md' },
      { header: 'Called', numeric: true, cell: v => fmt.money(v.called), sort: v => v.called },
      { header: 'Distributed', numeric: true, cell: v => fmt.money(v.distributed), sort: v => v.distributed, minWidth: 'md' },
      { header: 'NAV', numeric: true, cell: v => fmt.money(v.nav), sort: v => v.nav },
      { header: 'DPI', numeric: true, cell: v => multiple(v.dpi), sort: v => v.dpi ?? -Infinity, minWidth: 'md' },
      { header: 'TVPI', numeric: true, cell: v => multiple(v.tvpi), sort: v => v.tvpi ?? -Infinity },
    ], { caption: 'Committed, called, distributed and NAV for each vehicle' })))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Company detail
// ---------------------------------------------------------------------------------------------

/**
 * A metric's readings in its own unit: "$" before the number, "%" and words after it. The axis
 * gets the short form: a word unit ("people", "months") is in the card's heading already, and
 * repeated on every tick it would be wider than the plot's margin.
 */
function metricFormat(series: CompanyMetricSeries, fmt: Formatters): { value: (v: number) => string; tick: (v: number) => string } {
  const unit = (series.unit ?? '').trim()
  const plain = (v: number) => fmt.number(v)
  if (!unit) return { value: plain, tick: plain }
  if (unit === '%') { const f = (v: number) => `${fmt.number(v)}%`; return { value: f, tick: f } }
  // A currency symbol leads; anything else (months, people, seats) follows.
  if (/^[^\p{L}\p{N}\s]{1,3}$/u.test(unit)) {
    const f = (v: number) => `${v < 0 ? '-' : ''}${unit}${fmt.number(Math.abs(v))}`
    return { value: f, tick: f }
  }
  return { value: v => `${fmt.number(v)} ${unit}`, tick: plain }
}

function metricCard(series: CompanyMetricSeries, ctx: ViewContext): HTMLElement {
  const { value: format, tick } = metricFormat(series, ctx.fmt)
  const values = series.values
  const last = values[values.length - 1]
  const prior = values.length > 1 ? values[values.length - 2] : null
  const change = prior && prior.value !== 0 ? ((last.value - prior.value) / Math.abs(prior.value)) * 100 : null

  const plot = h('div', null)
  const card = h('div', { class: 'metric-card' },
    h('div', { class: 'metric-head' },
      h('p', { class: 'metric-name' }, series.name),
      h('p', { class: 'metric-latest' }, format(last.value)),
    ),
    h('p', { class: 'caption' },
      last.period,
      change === null ? '' : ` · ${change > 0 ? '+' : ''}${percent(change, 0)} vs ${prior!.period}`),
    plot,
  )
  // Laid out before the chart is sized: the plot needs a width to draw to.
  queueMicrotask(() => ctx.onDispose(lineChart(plot, values.map(v => ({ label: v.period, value: v.value })), {
    format,
    formatTick: tick,
    ariaLabel: `${series.name} over ${values.length} periods, latest ${format(last.value)} in ${last.period}. Use the arrow keys to read each period.`,
  })))

  if (!ctx.compact) {
    // The table twin of the chart: every reading, without a pointer.
    card.appendChild(h('details', { class: 'values' },
      h('summary', null, 'Values'),
      h('table', { class: 'table table-tight' },
        h('tbody', null, values.slice().reverse().map(v =>
          h('tr', null, h('th', { scope: 'row' }, v.period), h('td', { class: 'num' }, format(v.value)))))),
    ))
  }
  return card
}

function company(payload: CompanyPayload, ctx: ViewContext): Node[] {
  const { fmt } = ctx
  const d = payload.data
  const out: Node[] = []

  const status = titleCase(d.status)
  if (status || d.vehicles.length > 0) {
    out.push(h('p', { class: 'chips' },
      status ? h('span', { class: 'chip' }, status) : null,
      d.vehicles.map(v => h('span', { class: 'chip' }, v))))
  }

  const t: Tile[] = [
    { label: 'Invested', value: fmt.compact(d.summary.invested) },
    { label: 'Fair value', value: fmt.compact(d.summary.fairValue) },
    { label: 'MOIC', value: multiple(d.summary.moic) },
  ]
  if (d.summary.realized) t.push({ label: 'Realized', value: fmt.compact(d.summary.realized) })
  if (d.summary.grossIrr !== null && Math.abs(d.summary.grossIrr) >= 0.0005) t.push({ label: 'Gross IRR', value: fractionPercent(d.summary.grossIrr) })
  out.push(tiles(t))

  if (!ctx.compact && d.overview) out.push(h('p', { class: 'prose' }, d.overview))

  const metrics = ctx.compact ? d.metrics.slice(0, 2) : d.metrics
  if (metrics.length > 0) {
    out.push(section('Metrics', h('div', { class: 'metric-grid' }, metrics.map(m => metricCard(m, ctx)))))
  } else if (!ctx.compact) {
    out.push(section('Metrics', empty('No metrics have been recorded for this company yet.')))
  }

  if (ctx.compact) {
    const hidden = d.metrics.length - metrics.length
    const label = hidden > 0 ? `See ${hidden} more ${hidden === 1 ? 'metric' : 'metrics'} and the rounds` : 'See the rounds'
    const more = d.rounds.length > 0 || hidden > 0 ? expandButton(ctx, label) : null
    if (more) out.push(more)
    return out
  }

  if (d.rounds.length > 0) {
    out.push(section('Rounds', dataTable(d.rounds, [
      { header: 'Round', cell: r => r.roundName || DASH },
      { header: 'Date', cell: r => shortDate(r.date), sort: r => r.date ?? '' },
      { header: 'Invested', numeric: true, cell: r => fmt.money(r.invested), sort: r => r.invested },
      { header: 'Share price', numeric: true, cell: r => fmt.price(r.sharePrice), minWidth: 'md' },
      { header: 'Current value', numeric: true, cell: r => fmt.money(r.currentValue), sort: r => r.currentValue },
      { header: 'Realized', numeric: true, cell: r => fmt.money(r.realized), sort: r => r.realized, minWidth: 'md' },
    ], { caption: 'Each round with the amount invested, its current value and proceeds realized' })))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------------------------

type Line = { label: string; amount: string; kind?: 'heading' | 'total' | 'grand' | 'sub' }

function statementTable(caption: string, lines: Line[]): HTMLElement {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table statement' },
    h('caption', { class: 'sr-only' }, caption),
    h('tbody', null, lines.map(l =>
      h('tr', { class: l.kind ? `line-${l.kind}` : undefined },
        h('th', { scope: 'row' }, l.label),
        h('td', { class: 'num' }, l.amount))))))
}

function sectionLines(fmt: Formatters, s: { label: string; rows: { code?: string; name: string; amount: number }[]; total: number }): Line[] {
  return [
    { label: s.label, amount: '', kind: 'heading' },
    ...s.rows.map(r => ({ label: r.code ? `${r.code} · ${r.name}` : r.name, amount: fmt.money(r.amount), kind: 'sub' as const })),
    { label: `Total ${s.label.toLowerCase()}`, amount: fmt.money(s.total), kind: 'total' },
  ]
}

function capitalTable(fmt: Formatters, data: StatementsData['partnersCapital']): HTMLElement {
  const labels = data.totals.activity.map(a => a.label)
  const row = (r: PartnerCapitalRow, total = false) => h('tr', { class: total ? 'line-grand' : undefined },
    h('th', { scope: 'row' }, r.name),
    h('td', { class: 'num' }, fmt.money(r.beginning)),
    r.activity.map(a => h('td', { class: 'num' }, fmt.money(a.amount))),
    h('td', { class: 'num' }, fmt.money(r.ending)))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table wrap-head' },
    h('caption', { class: 'sr-only' }, "Statement of changes in partners' capital: each partner's beginning balance, activity for the period and ending balance"),
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, 'Partner'),
      h('th', { scope: 'col', class: 'num' }, 'Beginning'),
      labels.map(l => h('th', { scope: 'col', class: 'num' }, l)),
      h('th', { scope: 'col', class: 'num' }, 'Ending'))),
    h('tbody', null, data.partners.map(p => row(p))),
    h('tfoot', null, row(data.totals, true))))
}

function statements(payload: StatementsPayload, ctx: ViewContext): Node[] {
  const { fmt } = ctx
  const d = payload.data
  const out: Node[] = []

  const preset = (STATEMENT_PRESETS as readonly string[]).includes(d.period.preset) ? (d.period.preset as StatementPreset) : null
  out.push(h('div', { class: 'filters' }, segmented(
    'Statement period',
    STATEMENT_PRESETS.map(p => ({ value: p, label: STATEMENT_PRESET_LABEL[p] })),
    preset,
    p => ctx.open(VIEW_TOOL.statements, { vehicle: d.vehicle, period: p }, 'replace'),
  )))

  out.push(tiles([
    { label: 'Total assets', value: fmt.compact(d.balanceSheet.assets.total), sub: d.period.end ? `as of ${shortDate(d.period.end)}` : undefined },
    { label: 'Total liabilities', value: fmt.compact(d.balanceSheet.liabilities.total) },
    { label: d.balanceSheet.equityLabel, value: fmt.compact(d.balanceSheet.equityTotal) },
    { label: 'Net income', value: fmt.compact(d.incomeStatement.netIncome), sub: d.period.label },
  ]))

  // Stated in words with the amount, never by colour alone.
  out.push(Math.abs(d.balanceSheet.check) < 0.005
    ? note('The balance sheet balances: assets equal liabilities plus capital.')
    : note(`Out of balance by ${fmt.money(d.balanceSheet.check)}: assets do not equal liabilities plus capital.`, 'warning'))

  if (ctx.compact) {
    const more = expandButton(ctx, 'Open the statements')
    if (more) out.push(more)
    return out
  }

  const tabs: { value: StatementTab; label: string }[] = [
    { value: 'balance', label: 'Balance sheet' },
    { value: 'income', label: 'Income statement' },
    ...(d.cashFlows ? [{ value: 'cash' as const, label: 'Cash flows' }] : []),
    { value: 'capital', label: "Partners' capital" },
  ]
  const tab = tabs.some(t => t.value === ctx.statementTab) ? ctx.statementTab : 'balance'
  out.push(h('div', { class: 'filters' }, segmented('Statement', tabs, tab, ctx.setStatementTab)))

  if (tab === 'balance') {
    out.push(statementTable(`Balance sheet as of ${shortDate(d.period.end)}`, [
      ...sectionLines(fmt, d.balanceSheet.assets),
      ...sectionLines(fmt, d.balanceSheet.liabilities),
      { label: d.balanceSheet.equityLabel, amount: fmt.money(d.balanceSheet.equityTotal), kind: 'total' },
      { label: `Total liabilities and ${d.balanceSheet.equityLabel.toLowerCase()}`, amount: fmt.money(d.balanceSheet.liabilities.total + d.balanceSheet.equityTotal), kind: 'grand' },
    ]))
    if (Math.abs(d.balanceSheet.unallocatedEarnings) >= 0.005) {
      out.push(note(`${fmt.money(d.balanceSheet.unallocatedEarnings)} of net income has not been allocated to partners yet, because the period is not closed. Fund totals are right; per-partner balances do not include it.`))
    }
  } else if (tab === 'income') {
    out.push(statementTable(`Income statement for ${d.period.label}`, [
      ...sectionLines(fmt, d.incomeStatement.income),
      ...sectionLines(fmt, d.incomeStatement.expenses),
      { label: 'Net income', amount: fmt.money(d.incomeStatement.netIncome), kind: 'grand' },
    ]))
  } else if (tab === 'cash' && d.cashFlows) {
    out.push(statementTable(`Statement of cash flows for ${d.period.label}`, [
      { label: 'Cash at start of period', amount: fmt.money(d.cashFlows.openingCash), kind: 'total' },
      ...sectionLines(fmt, d.cashFlows.operating),
      ...sectionLines(fmt, d.cashFlows.financing),
      { label: 'Net change in cash', amount: fmt.money(d.cashFlows.netChange), kind: 'total' },
      { label: 'Cash at end of period', amount: fmt.money(d.cashFlows.endingCash), kind: 'grand' },
    ]))
  } else {
    if (d.partnersCapital.partners.length === 0) {
      out.push(empty('No partner capital activity in this period.'))
    } else {
      out.push(capitalTable(fmt, d.partnersCapital))
    }
    if (d.partnersCapital.carryWithheld) {
      out.push(note('Carried interest and the General Partner are not shown, because your access does not include GP economics. The rows above therefore do not add up to total capital on the balance sheet.', 'warning'))
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// LP capital
// ---------------------------------------------------------------------------------------------

interface InvestorTotal { investor: string; commitment: number; paidIn: number }

/**
 * Called against committed, one bar per investor: the bar's full length is the commitment, in a
 * light step of the series colour, and the solid part is what has been paid in. A meter, not two
 * series: the track and the fill are the same quantity at two stages.
 */
function fundingBars(investors: InvestorTotal[], fmt: Formatters): HTMLElement {
  const max = Math.max(0, ...investors.map(i => i.commitment))
  const pct = (v: number) => (max > 0 ? `${Math.max(0, Math.min(1, v / max)) * 100}%` : '0%')
  return h('div', { class: 'chart' },
    h('div', { class: 'legend' },
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch swatch-bar' }), 'Paid-in'),
      h('span', { class: 'legend-item' }, h('span', { class: 'swatch swatch-track' }), 'Uncalled commitment')),
    h('div', { class: 'bars', role: 'list', 'aria-label': 'Paid-in capital against commitment by investor, largest commitment first' },
      investors.map(i => {
        const called = share(i.paidIn, i.commitment)
        const label = called === null ? fmt.compact(i.paidIn) : `${percent(called, 0)} of ${fmt.compact(i.commitment)}`
        return h('div', {
          class: 'bar-row', role: 'listitem',
          'aria-label': `${i.investor}: ${fmt.money(i.paidIn)} paid in of ${fmt.money(i.commitment)} committed`,
        },
          h('div', { class: 'bar-label', title: i.investor }, i.investor),
          h('div', { class: 'bar-track' },
            h('div', { class: 'bar-commit', style: { width: pct(i.commitment) } }),
            h('div', { class: 'bar-fill', style: { width: pct(Math.min(i.paidIn, i.commitment)) } })),
          h('div', { class: 'bar-value bar-value-wide' }, label))
      })))
}

function lps(payload: LpPayload, ctx: ViewContext): Node[] {
  const { fmt } = ctx
  const { rows, totals } = payload.data
  const out: Node[] = []

  const called = share(totals.paidIn, totals.commitment)
  out.push(tiles([
    { label: 'Commitments', value: fmt.compact(totals.commitment) },
    {
      label: 'Paid-in', value: fmt.compact(totals.paidIn),
      meter: called === null ? null : called / 100,
      sub: called === null ? undefined : `${percent(called, 0)} of commitments called`,
    },
    { label: 'Distributions', value: fmt.compact(totals.distributions) },
    { label: 'NAV', value: fmt.compact(totals.nav) },
    { label: 'DPI', value: multiple(totals.dpi) },
    { label: 'TVPI', value: multiple(totals.tvpi) },
  ]))

  if (rows.length === 0) {
    out.push(empty('No LP positions in this scope.'))
    return out
  }

  // An investor may hold through several entities and vehicles: one bar per investor.
  const byInvestor = new Map<string, InvestorTotal>()
  for (const r of rows) {
    const cur = byInvestor.get(r.investor) ?? { investor: r.investor, commitment: 0, paidIn: 0 }
    cur.commitment += r.commitment
    cur.paidIn += r.paidIn
    byInvestor.set(r.investor, cur)
  }
  const investors = Array.from(byInvestor.values()).sort((a, b) => b.commitment - a.commitment)
  const limit = ctx.compact ? 5 : 12
  const shown = investors.slice(0, limit)
  const rest = investors.slice(limit)
  if (rest.length > 0) {
    shown.push({
      investor: `${rest.length} ${rest.length === 1 ? 'other' : 'others'}`,
      commitment: rest.reduce((s, i) => s + i.commitment, 0),
      paidIn: rest.reduce((s, i) => s + i.paidIn, 0),
    })
  }
  out.push(section('Called against committed', fundingBars(shown, fmt)))

  if (ctx.compact) {
    const more = expandButton(ctx, `See all ${investors.length} investors`)
    if (more) out.push(more)
    return out
  }

  const columns: Column<LpRow>[] = [
    { header: 'Investor', cell: r => r.investor, sort: r => r.investor.toLowerCase() },
    { header: 'Entity', cell: r => (r.entity === r.investor ? DASH : r.entity), sort: r => r.entity.toLowerCase(), minWidth: 'lg' },
    { header: 'Vehicle', cell: r => r.vehicle, sort: r => r.vehicle.toLowerCase(), minWidth: 'md' },
    { header: 'Commitment', numeric: true, cell: r => fmt.money(r.commitment), sort: r => r.commitment },
    { header: 'Paid-in', numeric: true, cell: r => fmt.money(r.paidIn), sort: r => r.paidIn },
    { header: 'Distributions', numeric: true, cell: r => fmt.money(r.distributions), sort: r => r.distributions, minWidth: 'md' },
    { header: 'NAV', numeric: true, cell: r => fmt.money(r.nav), sort: r => r.nav },
    { header: 'DPI', numeric: true, cell: r => multiple(r.dpi), sort: r => r.dpi ?? -Infinity, minWidth: 'lg' },
    { header: 'TVPI', numeric: true, cell: r => multiple(r.tvpi), sort: r => r.tvpi ?? -Infinity },
    { header: 'Net IRR', numeric: true, cell: r => fractionPercent(r.irr), sort: r => r.irr ?? -Infinity, minWidth: 'lg' },
  ]
  out.push(section('Positions', dataTable(rows, columns, {
    caption: 'Every LP position with commitment, paid-in, distributions, NAV and multiples',
    initialSort: { column: 3, descending: true },
    footer: ['Total', '', '', fmt.money(totals.commitment), fmt.money(totals.paidIn), fmt.money(totals.distributions), fmt.money(totals.nav), multiple(totals.dpi), multiple(totals.tvpi), ''],
  })))
  return out
}
