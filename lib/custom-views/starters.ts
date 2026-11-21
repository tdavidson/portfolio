// Starter views: a few commonly used custom views, ready to open, change and save.
//
// Each one is an ordinary view spec (spec.ts) over the query datasets, so it holds no figure and
// no fund's own wording: opening it loads every block live, as the person viewing it, through each
// dataset's own access check. They are GENERIC on purpose. Nothing here may name a fund, an
// investor, a company or a metric only one fund tracks; a fund's own layouts are saved views.
//
// One catalog for every place that offers them: the MCP `help` tool (topic "starters") and the
// app's New view page (/api/views/starters). Pure: no server imports.

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import { findDataset, parseViewSpec, type ViewSpec } from './spec'

export interface StarterView {
  key: string
  name: string
  /** What it shows, in one line. */
  description: string
  /** The help area it belongs to (lib/agent/getting-started.ts AREAS). */
  area: string
  spec: Record<string, unknown>
}

const src = (tool: string, dataset: string, query: Record<string, unknown> = {}, computed?: { as: string; formula: string }[]) =>
  ({ tool, dataset, query, ...(computed ? { computed } : {}) })

const positions = (query: Record<string, unknown> = {}, computed?: { as: string; formula: string }[]) => src('query_portfolio', 'positions', query, computed)
const lpPositions = (query: Record<string, unknown> = {}) => src('query_lps', 'lp_positions', query)
const sum = (column: string, as = column) => ({ fn: 'sum', column, as })

export const STARTER_VIEWS: StarterView[] = [
  {
    key: 'portfolio-overview',
    name: 'Portfolio overview',
    description: 'Cost, fair value and gross MOIC as tiles, the ten largest positions, and every position with its gain or loss.',
    area: 'portfolio',
    spec: {
      title: 'Portfolio overview',
      description: 'Cost, fair value and gross MOIC, the largest positions, and each position\'s gain or loss.',
      params: ['vehicle', 'as_of'],
      blocks: [
        { id: 'cost', type: 'kpi', label: 'Cost', span: 3, source: positions({ aggregates: [sum('cost')] }), value: 'cost', format: 'currency' },
        { id: 'fair_value', type: 'kpi', label: 'Fair value', span: 3, source: positions({ aggregates: [sum('fair_value')] }), value: 'fair_value', format: 'currency', compare: 'prior_quarter' },
        { id: 'realized', type: 'kpi', label: 'Realized', span: 3, source: positions({ aggregates: [sum('realized')] }), value: 'realized', format: 'currency' },
        { type: 'kpi', label: 'Gross MOIC on cost held', span: 3, formula: 'fair_value / cost', format: 'multiple' },
        {
          type: 'bar', label: 'Ten largest positions', span: 6, format: 'currency', x: 'company', y: 'fair_value',
          source: positions({ columns: ['company', 'fair_value'], order_by: [{ column: 'fair_value', direction: 'desc' }], limit: 10 }),
        },
        {
          type: 'pie', label: 'Share of fair value by stage', span: 6, format: 'currency', x: 'stage', y: 'fair_value',
          source: positions({ group_by: ['stage'], aggregates: [sum('fair_value')], order_by: [{ column: 'fair_value', direction: 'desc' }], limit: 8 }),
        },
        {
          type: 'table', label: 'Positions', span: 12, totals: true,
          source: positions(
            { columns: ['company', 'company_id', 'status', 'cost', 'fair_value', 'realized', 'moic'], order_by: [{ column: 'fair_value', direction: 'desc' }] },
            [{ as: 'gain', formula: 'fair_value - cost' }],
          ),
          columns: [
            { column: 'company', link: 'company' }, 'status',
            { column: 'cost', format: 'currency' }, { column: 'fair_value', label: 'Fair value', format: 'currency' },
            { column: 'gain', label: 'Unrealized gain', format: 'currency', tone: 'sign' },
            { column: 'realized', format: 'currency' }, { column: 'moic', label: 'MOIC', format: 'multiple' },
          ],
        },
      ],
    },
  },
  {
    key: 'below-cost',
    name: 'Positions below cost',
    description: 'Every active position marked below its remaining cost, largest shortfall first.',
    area: 'portfolio',
    spec: {
      title: 'Positions below cost',
      params: ['vehicle', 'as_of'],
      blocks: [
        {
          type: 'kpi', label: 'Positions below cost', span: 4, format: 'number',
          source: positions({ where: [{ column: 'unrealized', op: 'lt', value: 0 }, { column: 'status', op: 'eq', value: 'active' }], aggregates: [{ fn: 'count', as: 'positions' }] }),
          value: 'positions',
        },
        {
          type: 'kpi', label: 'Total shortfall', span: 4, format: 'currency',
          source: positions({ where: [{ column: 'unrealized', op: 'lt', value: 0 }, { column: 'status', op: 'eq', value: 'active' }], aggregates: [sum('unrealized', 'shortfall')] }),
          value: 'shortfall',
        },
        {
          type: 'table', label: 'Below cost', span: 12, totals: true,
          source: positions({
            columns: ['company', 'company_id', 'stage', 'cost', 'fair_value', 'unrealized', 'moic'],
            where: [{ column: 'unrealized', op: 'lt', value: 0 }, { column: 'status', op: 'eq', value: 'active' }],
            order_by: [{ column: 'unrealized', direction: 'asc' }],
          }),
          columns: [
            { column: 'company', link: 'company' }, 'stage',
            { column: 'cost', format: 'currency' }, { column: 'fair_value', label: 'Fair value', format: 'currency' },
            { column: 'unrealized', label: 'Shortfall', format: 'currency', tone: 'sign' }, { column: 'moic', label: 'MOIC', format: 'multiple' },
          ],
        },
      ],
    },
  },
  {
    key: 'company-kpis',
    name: 'Company KPIs by period',
    description: 'One reported metric across the portfolio, company by period. Pick the metric above the view.',
    area: 'portfolio',
    spec: {
      title: 'Company KPIs by period',
      description: 'Pick a metric to compare it across companies and periods.',
      filters: [{ column: 'metric', label: 'Metric', kind: 'pick' }],
      blocks: [
        {
          type: 'heatmap', label: 'Metric by company and period', span: 12, format: 'number',
          source: src('query_portfolio', 'kpis', { group_by: ['company', 'period'], aggregates: [sum('value')] }),
          rows: 'company', columns: 'period', value: 'value',
        },
      ],
    },
  },
  {
    key: 'lp-capital',
    name: 'LP capital',
    description: 'Commitments, called, distributed and NAV across investors, with each investor\'s multiples.',
    area: 'lps',
    spec: {
      title: 'LP capital',
      params: ['vehicle', 'as_of'],
      blocks: [
        { type: 'kpi', label: 'Commitments', span: 3, source: lpPositions({ aggregates: [sum('commitment')] }), value: 'commitment', format: 'currency' },
        { type: 'kpi', label: 'Called', span: 3, source: lpPositions({ aggregates: [sum('called_capital', 'called')] }), value: 'called', format: 'currency' },
        { type: 'kpi', label: 'Distributed', span: 3, source: lpPositions({ aggregates: [sum('distributions')] }), value: 'distributions', format: 'currency' },
        { type: 'kpi', label: 'NAV', span: 3, source: lpPositions({ aggregates: [sum('nav')] }), value: 'nav', format: 'currency', compare: 'prior_quarter' },
        {
          type: 'bar', label: 'NAV by investor', span: 12, format: 'currency', x: 'investor', y: 'nav',
          source: lpPositions({ group_by: ['investor'], aggregates: [sum('nav')], order_by: [{ column: 'nav', direction: 'desc' }], limit: 15 }),
        },
        {
          type: 'table', label: 'Investors', span: 12, totals: true,
          source: lpPositions({ columns: ['investor', 'vehicle', 'commitment', 'called_capital', 'unfunded', 'distributions', 'nav', 'dpi', 'tvpi'], order_by: [{ column: 'commitment', direction: 'desc' }] }),
          columns: [
            'investor', 'vehicle',
            { column: 'commitment', format: 'currency' }, { column: 'called_capital', label: 'Called', format: 'currency' },
            { column: 'unfunded', format: 'currency' }, { column: 'distributions', format: 'currency' },
            { column: 'nav', label: 'NAV', format: 'currency' },
            { column: 'dpi', label: 'DPI', format: 'multiple' }, { column: 'tvpi', label: 'TVPI', format: 'multiple' },
          ],
        },
      ],
    },
  },
  {
    key: 'capital-calls-outstanding',
    name: 'Capital calls outstanding',
    description: 'What is still owed on capital calls, by investor and call, with what is overdue.',
    area: 'lps',
    spec: {
      title: 'Capital calls outstanding',
      params: ['vehicle'],
      blocks: [
        {
          type: 'kpi', label: 'Outstanding', span: 4, format: 'currency', value: 'outstanding',
          source: src('query_lps', 'capital_call_lines', { where: [{ column: 'outstanding', op: 'gt', value: 0 }], aggregates: [sum('outstanding')] }),
        },
        {
          type: 'kpi', label: 'Overdue', span: 4, format: 'currency', value: 'overdue',
          source: src('query_lps', 'capital_call_lines', { where: [{ column: 'outstanding', op: 'gt', value: 0 }, { column: 'overdue', op: 'eq', value: true }], aggregates: [sum('outstanding', 'overdue')] }),
        },
        {
          type: 'table', label: 'Still owed', span: 12, totals: true,
          source: src('query_lps', 'capital_call_lines', {
            columns: ['lp', 'call_number', 'due_date', 'amount', 'funded', 'outstanding', 'says_wired', 'overdue'],
            where: [{ column: 'outstanding', op: 'gt', value: 0 }],
            order_by: [{ column: 'due_date', direction: 'asc' }],
          }),
          columns: [
            { column: 'lp', label: 'Investor' }, { column: 'call_number', label: 'Call' }, { column: 'due_date', label: 'Due', format: 'date' },
            { column: 'amount', format: 'currency' }, { column: 'funded', format: 'currency' }, { column: 'outstanding', format: 'currency' },
            { column: 'says_wired', label: 'Says wired' }, 'overdue',
          ],
        },
      ],
    },
  },
  {
    key: 'fund-performance',
    name: 'Fund performance',
    description: 'Committed, called, distributed and NAV for each vehicle, with DPI, TVPI and net IRR.',
    area: 'books',
    spec: {
      title: 'Fund performance',
      params: ['as_of'],
      blocks: [
        {
          type: 'column', label: 'DPI and TVPI by vehicle', span: 12, format: 'multiple', x: 'vehicle', y: 'dpi', measures: ['tvpi'], stack: 'grouped',
          source: src('query_funds', 'fund_performance', { columns: ['vehicle', 'dpi', 'tvpi'] }),
        },
        {
          type: 'table', label: 'Vehicles', span: 12,
          source: src('query_funds', 'fund_performance', { columns: ['vehicle', 'committed', 'called', 'unfunded', 'distributed', 'nav', 'dpi', 'tvpi', 'net_lp_irr'] }),
          columns: [
            'vehicle',
            { column: 'committed', format: 'currency' }, { column: 'called', format: 'currency' }, { column: 'unfunded', format: 'currency' },
            { column: 'distributed', format: 'currency' }, { column: 'nav', label: 'NAV', format: 'currency' },
            { column: 'dpi', label: 'DPI', format: 'multiple' }, { column: 'tvpi', label: 'TVPI', format: 'multiple' },
            { column: 'net_lp_irr', label: 'Net LP IRR', format: 'percent' },
          ],
        },
      ],
    },
  },
  {
    key: 'income-and-cash',
    name: 'Income, expenses and cash',
    description: 'One vehicle\'s income and expenses by quarter, its largest expense accounts, and cash at each month end.',
    area: 'books',
    spec: {
      title: 'Income, expenses and cash',
      params: ['vehicle', 'as_of'],
      blocks: [
        {
          type: 'column', label: 'Income and expenses by quarter', span: 6, format: 'currency', x: 'month_quarter', y: 'amount', series: 'type', stack: 'grouped',
          source: src('query_funds', 'pnl_by_month', { group_by: ['month:quarter', 'type'], aggregates: [sum('amount')], order_by: [{ column: 'month_quarter', direction: 'asc' }] }),
        },
        {
          type: 'line', label: 'Cash at month end', span: 6, format: 'currency', x: 'month', y: 'ending',
          source: src('query_funds', 'cash_by_month', { columns: ['month', 'ending'], order_by: [{ column: 'month', direction: 'asc' }] }),
        },
        {
          type: 'table', label: 'Largest expense accounts', span: 12, totals: true,
          source: src('query_funds', 'pnl_by_month', {
            where: [{ column: 'type', op: 'eq', value: 'expense' }],
            group_by: ['account_name'], aggregates: [sum('amount')],
            order_by: [{ column: 'amount', direction: 'desc' }], limit: 15,
          }),
          columns: [{ column: 'account_name', label: 'Account' }, { column: 'amount', label: 'Spent', format: 'currency' }],
        },
      ],
    },
  },
  {
    key: 'deal-flow',
    name: 'Deal flow',
    description: 'Inbound deals by status and thesis fit, and the latest arrivals.',
    area: 'deals',
    spec: {
      title: 'Deal flow',
      blocks: [
        {
          type: 'bar', label: 'Deals by status', span: 6, format: 'number', x: 'status', y: 'deals',
          source: src('query_deals', 'inbound_deals', { group_by: ['status'], aggregates: [{ fn: 'count', as: 'deals' }], order_by: [{ column: 'deals', direction: 'desc' }] }),
        },
        {
          type: 'pie', label: 'Thesis fit', span: 6, format: 'number', x: 'thesis_fit', y: 'deals',
          source: src('query_deals', 'inbound_deals', { group_by: ['thesis_fit'], aggregates: [{ fn: 'count', as: 'deals' }], order_by: [{ column: 'deals', direction: 'desc' }], limit: 8 }),
        },
        {
          type: 'table', label: 'Latest deals', span: 12,
          source: src('query_deals', 'inbound_deals', { columns: ['company', 'stage', 'industry', 'thesis_fit', 'status', 'created_at'], order_by: [{ column: 'created_at', direction: 'desc' }], limit: 25 }),
          columns: ['company', 'stage', 'industry', { column: 'thesis_fit', label: 'Thesis fit' }, 'status', { column: 'created_at', label: 'Received', format: 'date' }],
        },
      ],
    },
  },
  {
    key: 'diligence-pipeline',
    name: 'Diligence pipeline',
    description: 'Deals in diligence by stage, and the open ones with their memo stage.',
    area: 'diligence',
    spec: {
      title: 'Diligence pipeline',
      blocks: [
        {
          type: 'funnel', label: 'Deals by stage', span: 6, format: 'number', x: 'stage', y: 'deals',
          source: src('query_diligence', 'diligence_deals', { group_by: ['stage'], aggregates: [{ fn: 'count', as: 'deals' }], order_by: [{ column: 'deals', direction: 'desc' }] }),
        },
        {
          type: 'table', label: 'Deals', span: 6,
          source: src('query_diligence', 'diligence_deals', { columns: ['name', 'stage', 'status', 'memo_stage', 'created_at'], order_by: [{ column: 'created_at', direction: 'desc' }], limit: 25 }),
          columns: ['name', 'stage', 'status', { column: 'memo_stage', label: 'Memo' }, { column: 'created_at', label: 'Started', format: 'date' }],
        },
      ],
    },
  },
]

/** Can the caller read this dataset's area? Absent = show everything. */
export type CanReadDataset = (domain: Domain, feature?: FeatureKey) => boolean

/** The datasets a starter reads, so it is offered only to members who can read every one. */
function gatesOf(starter: StarterView) {
  const blocks = (starter.spec.blocks as { source?: { tool: string; dataset: string } }[]) ?? []
  return blocks.flatMap(b => {
    const meta = b.source ? findDataset(b.source.tool, b.source.dataset) : undefined
    return meta ? [meta.gate] : []
  })
}

export function startersFor(canRead?: CanReadDataset): StarterView[] {
  return canRead ? STARTER_VIEWS.filter(s => gatesOf(s).every(g => canRead(g.domain, g.feature))) : STARTER_VIEWS
}

/** A starter by key or name (any case), or undefined. */
export function findStarter(ref: unknown, canRead?: CanReadDataset): StarterView | undefined {
  const r = String(ref ?? '').trim().toLowerCase()
  if (!r) return undefined
  return startersFor(canRead).find(s => s.key === r || s.name.toLowerCase() === r)
}

/** The starter's spec, validated as any other spec is. */
export function starterSpec(starter: StarterView): ViewSpec {
  return parseViewSpec(starter.spec)
}
