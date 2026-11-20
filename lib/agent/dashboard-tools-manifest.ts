// Pure metadata for the DASHBOARD tools: the four views an assistant can render in the
// conversation, and the saved dashboards a member keeps. NO server imports (the Settings key UI
// lists these). Handlers live in dashboard-tools.ts.
//
// THESE ARE AN MCP SURFACE, NOT PART OF THE SHARED REGISTRY. `AGENT_TOOLS` feeds the REST agent
// and the in-app Analyst as well, and neither can draw a view: a `show_*` tool there would only
// hand the model a second, heavier copy of `portfolio_summary`. So the MCP endpoint appends this
// list to the registry (lib/mcp-apps/server.ts) and nothing else sees it.
//
// A `show_*` tool returns the SAME figures as the read tools beside it (it calls their handlers),
// so a dashboard and an answer in prose can never disagree. What it adds is `_meta.ui`: a host
// that speaks MCP Apps renders the result in the dashboard view; one that does not gets the
// figures as text and loses nothing.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { CHART_KINDS, CHART_MAX_POINTS, CHART_UNITS, DASHBOARD_VIEWS, STATEMENT_PRESETS } from '@/lib/mcp-apps/payload'

export interface DashboardToolMeta extends AgentToolMeta {
  /** The result is a DashboardPayload, drawn by the dashboard view where the host supports it. */
  ui?: boolean
  /**
   * A MEMBER'S OWN DATA: membership is the whole test, the tool's `accessDomain` is not consulted.
   *
   * The tool twin of the route registry's level `'any'` (lib/access/route-domains.ts). A saved
   * dashboard is a name and a set of arguments the member chose; gating the list on any one
   * domain would hide it from a member who holds a different one. It is not a way around a grant:
   * `open_dashboard` checks the saved view's own domain before it reads a single figure.
   *
   * A personal WRITE still needs a write-scoped credential and a role that may change things.
   * The consent screen tells a read-only connection it "cannot change anything", and the
   * read-only demo account must not be a place anyone can leave rows.
   *
   * KNOWN CONSEQUENCE: the OAuth flow issues a write scope only to a member who can write in some
   * domain (lib/oauth/store.ts `grantableScope`), so a member whose every grant is read-only can
   * open dashboards, including shared ones, but cannot save their own. That is the price of the
   * consent screen's sentence staying true. To let every member keep bookmarks, treat a personal
   * write as needing no scope in `authorizeMcpTool` and reword that sentence; do not do one
   * without the other.
   */
  personal?: boolean
}

const VEHICLE = { type: 'string', description: 'Optional: only this vehicle (fund or SPV). Use list_vehicles to see them.' }
const ISO_DATE = 'ISO date (YYYY-MM-DD)'

const DASHBOARD_REF = {
  type: 'string',
  description: 'The dashboard id or its name, as list_dashboards returns them.',
}

const ARGUMENTS = {
  type: 'object',
  description:
    'The arguments of the view, exactly as you would pass them to its show_ tool: ' +
    'portfolio { vehicle?, as_of? }, company { company, vehicle? }, ' +
    'statements { vehicle?, period?, start?, end? }, lps { vehicle?, as_of? }. ' +
    'Leave out as_of, start and end unless the user asked to pin a date: a saved dashboard without them opens on current figures.',
}

const CUSTOM_SPEC = {
  type: 'object',
  description: 'The view spec: { title, description?, params?, blocks }. See the tool description for the block shapes.',
}

const CUSTOM_ARGS = {
  type: 'object',
  description: 'Optional filter values, for the params the view offers: { vehicle?, as_of? (YYYY-MM-DD) }.',
}

const CUSTOM_REF = { type: 'string', description: 'The view id or its name, as list_custom_views returns them.' }

export const DASHBOARD_TOOL_MANIFEST: DashboardToolMeta[] = [
  {
    name: 'show_home',
    description:
      'Show the home dashboard: the dashboards this user can open, their saved and shared dashboards, and example ' +
      'questions for each area they can access. Use this when the user asks what you can do, asks for help, says ' +
      '"get started" or "home", or seems unsure what to ask. Then give a short, friendly overview with three ' +
      'suggestions to try first. The same overview also comes back as text.',
    scope: 'read',
    domain: 'portfolio',
    // Everyone gets a home page: it lists only what the member's own access allows.
    personal: true,
    ui: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_chart',
    description:
      'Draw figures you already have as a chart in the conversation: bars to compare categories (fair value by ' +
      'company, commitments by investor), or a line to follow one measure over time (NAV by quarter). One measure per ' +
      'chart. Use this when the user asks to chart, plot or graph something no dashboard shows. Take the figures from ' +
      'the tools you called; never invent or estimate them. It reads no data itself.',
    scope: 'read',
    domain: 'portfolio',
    // Reads nothing: it draws numbers the conversation already holds, which the member's own
    // access produced. So, like home, membership is the test.
    personal: true,
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The chart title, e.g. "Fair value by company".' },
        kind: { type: 'string', enum: [...CHART_KINDS], description: 'bar to compare categories; line for one measure over time, oldest first.' },
        unit: { type: 'string', enum: [...CHART_UNITS], description: "How values are written: the fund's currency, a plain number, percent (12.5 = 12.5%) or a multiple (1.8 = 1.8x)." },
        measure: { type: 'string', description: 'What the values measure, e.g. "Fair value" or "TVPI".' },
        points: {
          type: 'array',
          maxItems: CHART_MAX_POINTS,
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, value: { type: 'number' } },
            required: ['label', 'value'],
          },
          description: `The figures, at most ${CHART_MAX_POINTS}.`,
        },
        source: { type: 'string', description: 'Optional: where the figures came from, e.g. "Portfolio summary as of 30 Jun 2026".' },
      },
      required: ['title', 'kind', 'measure', 'points'],
    },
  },
  {
    name: 'show_portfolio_dashboard',
    description:
      'Show the portfolio overview as an interactive dashboard: cost, fair value, unrealized gain and gross MOIC, ' +
      'fair value against cost by company, and the full holdings table, plus committed, called, distributed, NAV, ' +
      'DPI and TVPI per vehicle where the user may see them. Use this when the user asks to see, show, open or ' +
      'visualize the portfolio or the fund. The figures also come back as text, so answer follow-up questions from them.',
    scope: 'read',
    domain: 'portfolio',
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        as_of: { type: 'string', description: `Optional ${ISO_DATE}: value the portfolio as of then instead of today.` },
      },
    },
  },
  {
    name: 'show_company_dashboard',
    description:
      'Show one portfolio company as an interactive dashboard: invested, fair value, MOIC and IRR, its KPI history ' +
      'as charts (ARR, headcount, runway, whatever the fund tracks) and its rounds. Use this when the user asks to ' +
      'see, show or chart a company. The figures also come back as text.',
    scope: 'read',
    domain: 'portfolio',
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company id, or the company name (matched case-insensitively).' },
        vehicle: VEHICLE,
      },
      required: ['company'],
    },
  },
  {
    name: 'show_financial_statements',
    description:
      'Show a vehicle\'s financial statements as an interactive view: balance sheet, income statement, cash flows ' +
      'and the statement of changes in partners\' capital for a period, with the balance check. Use this when the ' +
      'user asks to see the statements, the balance sheet, the P&L or the books of a fund. The figures also come back as text.',
    scope: 'read',
    // Fund-scoped at dispatch (it resolves its own vehicle, so a single-vehicle fund need not name
    // one), but it reads the ledger: the grant is `accounting`, as for financial_statements.
    domain: 'portfolio',
    accessDomain: 'accounting',
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'The vehicle whose books to show. Optional when the fund has a single vehicle.' },
        period: {
          type: 'string',
          enum: [...STATEMENT_PRESETS],
          description: 'The statement period. Default ytd. Ignored when start or end is given.',
        },
        start: { type: 'string', description: `Optional custom period start, ${ISO_DATE}.` },
        end: { type: 'string', description: `Optional custom period end, ${ISO_DATE}. The balance sheet is struck as of this date.` },
      },
    },
  },
  {
    name: 'show_lp_dashboard',
    description:
      'Show LP capital as an interactive dashboard: commitments, paid-in, distributions and NAV with DPI and TVPI, ' +
      'how much of each investor\'s commitment has been called, and the position of every investor and entity, ' +
      'derived live from the books. Use this when the user asks to see the LPs, capital accounts or who has funded. ' +
      'The figures also come back as text.',
    scope: 'read',
    domain: 'lp',
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        as_of: { type: 'string', description: `Optional ${ISO_DATE}. Defaults to today.` },
      },
    },
  },
  {
    name: 'show_capital_calls',
    description:
      'Show a capital call as an interactive dashboard: the amount called, received and still owed, and every LP\'s ' +
      'status — paid, partly paid, says they wired (from the LP portal, not yet received), unpaid, overdue — with the ' +
      'fund\'s other calls to switch between. Use when the user asks who has paid a call, who still owes, or to see ' +
      'the capital calls. Defaults to the latest call. The figures also come back as text.',
    scope: 'read',
    domain: 'lp',
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        call: { type: 'string', description: 'Which call: "latest" (default), its number, its date (YYYY-MM-DD), or its id.' },
      },
    },
  },
  {
    name: 'list_dashboards',
    description:
      'List the dashboards this user can open: the standard ones, the ones they saved, and the ones colleagues ' +
      'shared with the fund. Call this when the user asks for "my dashboards", or names a dashboard you have not seen.',
    scope: 'read',
    domain: 'portfolio',
    personal: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_dashboard',
    description:
      'Open a saved or standard dashboard by id or name and show it with current figures. Use this when the user ' +
      'asks for a dashboard by name ("open my Q3 LP dashboard"). The figures also come back as text.',
    scope: 'read',
    domain: 'portfolio',
    personal: true,
    ui: true,
    inputSchema: {
      type: 'object',
      properties: { dashboard: DASHBOARD_REF },
      required: ['dashboard'],
    },
  },
  {
    name: 'save_dashboard',
    description:
      'Save a dashboard under a name so the user can reopen it in any later conversation. Saves the view and its ' +
      'arguments, never the figures: it always opens on current data. Saving under a name the user already has ' +
      'replaces that dashboard. Only call this when the user asks to save, keep or pin a dashboard.',
    scope: 'write',
    domain: 'portfolio',
    personal: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the user calls it, up to 80 characters.' },
        view: { type: 'string', enum: [...DASHBOARD_VIEWS], description: 'Which dashboard this is.' },
        arguments: ARGUMENTS,
        shared: { type: 'boolean', description: 'True to list it for every member of the fund. Default false. Each member still sees only what their own access allows.' },
      },
      required: ['name', 'view'],
    },
  },
  {
    name: 'delete_dashboard',
    description: 'Delete one of the user\'s own saved dashboards, by id or name. Only call this when the user asks to remove it.',
    scope: 'write',
    domain: 'portfolio',
    personal: true,
    inputSchema: {
      type: 'object',
      properties: { dashboard: DASHBOARD_REF },
      required: ['dashboard'],
    },
  },
  // ── Custom views: a member's own layout of blocks over the query datasets (lib/custom-views) ──
  {
    name: 'preview_custom_view',
    description:
      'Build a custom view the user describes ("NAV, unfunded and the ten largest positions, filterable by vehicle") ' +
      'and show it live, before saving. Write a spec: { title, description?, params?: ["vehicle","as_of"], blocks: [...] }. ' +
      'Blocks come from a fixed set: ' +
      'kpi { label, source, value, format, sub? } shows the first row of one result column; ' +
      'bar | line { label, source, x, y, series?, format } charts one measure (line: oldest first); with series ' +
      '(a result column such as stage or vehicle, grouped by alongside x) bars stack one segment per value and a ' +
      'line chart draws one line per value; ' +
      'table { label, source, columns?: [{ column, label?, format? }] }; ' +
      'text { text } is plain copy. Every data block has span (3, 4, 6, 8 or 12 of 12) and ' +
      'source { tool, dataset, query }: tool is one of the query tools (query_portfolio, query_lps, query_deals, ' +
      'query_diligence, query_ledger), dataset and columns are theirs, and query is what you would pass that tool ' +
      '(columns, where, group_by, aggregates, order_by, limit). value, x, y, series and table columns name RESULT columns ' +
      '(an aggregate is named by its "as"). format is currency, number, percent, multiple, date or text. Never put ' +
      'figures in the spec: every block loads live, as the person viewing it. If the spec is wrong the error names ' +
      'what is allowed; fix it and preview again. Then offer to save it with save_custom_view.',
    scope: 'read',
    domain: 'portfolio',
    // Every block is checked against the dataset's own gate as it loads, so membership is the test
    // for the tool; a block the member cannot read comes back marked, with no rows.
    personal: true,
    ui: true,
    inputSchema: {
      type: 'object',
      properties: {
        spec: CUSTOM_SPEC,
        arguments: CUSTOM_ARGS,
      },
      required: ['spec'],
    },
  },
  {
    name: 'save_custom_view',
    description:
      'Save a custom view under a name so the user can open it in the app (Views) and in any later conversation. ' +
      'Saves the spec, never the figures. Saving under a name the user already has replaces it (the old version ' +
      'is kept in its history). Preview it first, and only save when the user asks to.',
    scope: 'write',
    domain: 'portfolio',
    personal: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the user calls it, up to 80 characters.' },
        spec: CUSTOM_SPEC,
        shared: { type: 'boolean', description: 'True to list it for every member of the fund. Default false. Each member still sees only what their own access allows.' },
      },
      required: ['name', 'spec'],
    },
  },
  {
    name: 'open_custom_view',
    description: 'Open a saved custom view by id or name and show it with current figures. The figures also come back as text.',
    scope: 'read',
    domain: 'portfolio',
    personal: true,
    ui: true,
    inputSchema: {
      type: 'object',
      properties: { view: CUSTOM_REF, arguments: CUSTOM_ARGS },
      required: ['view'],
    },
  },
  {
    name: 'list_custom_views',
    description: 'List the custom views this user saved and the ones colleagues shared with the fund.',
    scope: 'read',
    domain: 'portfolio',
    personal: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_custom_view_spec',
    description: 'Read a saved custom view\'s spec, to change it: edit the spec, preview it, then save it under the same name.',
    scope: 'read',
    domain: 'portfolio',
    personal: true,
    inputSchema: {
      type: 'object',
      properties: { view: CUSTOM_REF },
      required: ['view'],
    },
  },
  {
    name: 'delete_custom_view',
    description: 'Delete one of the user\'s own custom views, by id or name. Only call this when the user asks to remove it.',
    scope: 'write',
    domain: 'portfolio',
    personal: true,
    inputSchema: {
      type: 'object',
      properties: { view: CUSTOM_REF },
      required: ['view'],
    },
  },
]
