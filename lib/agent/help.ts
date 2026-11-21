// The MCP `help` tool's content: what this connection can do, by topic, for the member asking.
//
// show_home is the visual welcome. `help` is the text answer behind it, for a host that cannot draw
// the home dashboard and for the questions the home page does not answer: "how do I save a view?",
// "what charts can you make?", "what are the common views?", "why did my change not happen?".
//
// Pure: no server imports. The handler (dashboard-tools.ts) gathers the member's own lists (saved
// dashboards and views, the starters their access allows) and passes them in, so every answer is
// already limited to what they may open. Wording stays generic: no fund's names or figures here.

import { areasFor, DASHBOARD_TIPS, type CanRead } from './getting-started'
import type { StarterView } from '@/lib/custom-views/starters'
import { CHART_TYPES } from '@/lib/custom-views/spec'
import { AREA_TOPICS, HELP_TOPICS, type HelpTopic } from './help-topics'

export { HELP_TOPICS, type HelpTopic } from './help-topics'

const TOPIC_BLURB: Record<HelpTopic, string> = {
  overview: 'what this connection can do, in one page',
  views: 'custom views: open, build, change, share and export them',
  starters: 'commonly used views, ready to open and save',
  dashboards: 'the built-in dashboards and saved dashboards',
  charts: 'charting figures, and the chart types a view can use',
  exports: 'PDFs and Excel files',
  approvals: 'why a change can wait for approval, and how to approve it',
  funds: 'working in more than one fund',
  portfolio: 'companies, positions, marks and KPIs',
  books: 'statements, the ledger, the bank and fund performance',
  lps: 'commitments, calls, distributions and investor reporting',
  forecast: 'budgets, forecasts and variance',
  deals: 'inbound deal flow',
  diligence: 'deals in diligence, memos and checklists',
}

export interface HelpInput {
  topic?: unknown
  fundName?: string | null
  canRead?: CanRead
  /** The built-in dashboards this member may open, by label. */
  dashboards: string[]
  /** Their saved and shared dashboards, by name. */
  savedDashboards: string[]
  /** Their saved and shared custom views, by name. */
  savedViews: string[]
  /** The starter views their access allows. */
  starters: StarterView[]
  /** How many funds this connection can work in, when known. */
  fundCount?: number | null
}

export interface HelpResult {
  topic: HelpTopic
  /** The answer, for the assistant to put in its own words. */
  text: string
  /** Other topics to offer, with what each covers. */
  more_topics: { topic: HelpTopic; about: string }[]
  saved_views?: string[]
  saved_dashboards?: string[]
  /** Starters as { key, name, description }; with topic "starters", each also carries its spec. */
  starters?: ({ key: string; name: string; description: string; spec?: Record<string, unknown> })[]
  /** For the assistant, not the user: which tools do what for this topic. */
  for_assistant: string
}

/** The topic asked for, or overview. A near miss ("view", "custom views", "LP") still lands. */
export function helpTopic(raw: unknown): HelpTopic {
  const t = String(raw ?? '').trim().toLowerCase().replace(/[^a-z ]/g, '')
  if (!t) return 'overview'
  if ((HELP_TOPICS as readonly string[]).includes(t)) return t as HelpTopic
  const alias: [RegExp, HelpTopic][] = [
    [/starter|template|common|example|gallery/, 'starters'],
    [/view/, 'views'],
    [/dashboard|home/, 'dashboards'],
    [/chart|graph|plot/, 'charts'],
    [/pdf|excel|export|download|file|report card/, 'exports'],
    [/approv|stag|pending/, 'approvals'],
    [/fund/, 'funds'],
    [/lp|investor|capital|call|distribution/, 'lps'],
    [/book|ledger|statement|bank|account|journal/, 'books'],
    [/forecast|budget|variance/, 'forecast'],
    [/deal|pitch|inbound/, 'deals'],
    [/diligence|memo/, 'diligence'],
    [/portfolio|compan|kpi|position|mark/, 'portfolio'],
  ]
  return alias.find(([re]) => re.test(t))?.[1] ?? 'overview'
}

const list = (items: string[], none: string) => (items.length ? items.join(', ') : none)
const bullet = (items: string[]) => items.map(i => `- ${i}`)

export function buildHelp(input: HelpInput): HelpResult {
  const topic = helpTopic(input.topic)
  const areas = areasFor(input.canRead)
  const areaKeys = new Set(areas.map(a => a.key))
  const lines: string[] = []
  let forAssistant = ''
  const result: Partial<HelpResult> = {}
  const starterList = (starters: StarterView[]) => starters.map(s => ({ key: s.key, name: s.name, description: s.description }))

  switch (topic) {
    case 'overview': {
      lines.push(`Connected to ${input.fundName ?? 'the fund'}'s Portfolio app, as this member. Everything is limited to what their own access allows.`)
      lines.push('', 'What they can ask about:')
      lines.push(...bullet(areas.map(a => `${a.label}: ${a.blurb} For example, "${a.questions[0]}"`)))
      lines.push('', `Dashboards they can open: ${list(input.dashboards, 'none for this access')}.`)
      if (input.savedDashboards.length) lines.push(`Their saved dashboards: ${input.savedDashboards.join(', ')}.`)
      lines.push(`Their custom views: ${list(input.savedViews, 'none saved yet')}.`)
      if (input.starters.length) lines.push(`Starter views to begin from: ${input.starters.map(s => s.name).join(', ')}.`)
      lines.push('', 'Tips:', ...bullet(DASHBOARD_TIPS))
      lines.push('', 'Ask for help on a topic for more: views, starters, charts, exports, approvals, or any area above.')
      result.saved_views = input.savedViews
      result.saved_dashboards = input.savedDashboards
      result.starters = starterList(input.starters)
      forAssistant = 'Give a short, friendly overview with three suggestions to try first; do not list tool names. ' +
        'Call show_home instead when the host can draw it. Call help again with a topic for a how-to question.'
      break
    }
    case 'views': {
      lines.push('Custom views are layouts of tiles, charts, tables and notes over live fund data. A view saves the layout, never the figures: each time it opens, every block loads again as the person viewing it, so two members can open the same view and each sees only what their own access allows.')
      lines.push('', `Their views: ${list(input.savedViews, 'none saved yet')}.`)
      if (input.starters.length) lines.push(`Starter views: ${input.starters.map(s => s.name).join(', ')}.`)
      lines.push('', 'What they can do:')
      lines.push(...bullet([
        'Open a view by name: "open my Monday portfolio view". Filters such as vehicle and as-of date can be changed when opening it.',
        'Build a new one by describing it: "NAV, unfunded and the ten largest positions, filterable by vehicle". It is shown live before anything is saved.',
        'Start from a starter view and change it in words, then save it under their own name.',
        'Change a saved view: "add unfunded commitments as a tile to my LP view".',
        'Share a view with the fund, export it as a PDF or Excel workbook, or delete it.',
        'Every saved view is also under Views in the app, and the app\'s New view page offers the same starters.',
      ]))
      result.saved_views = input.savedViews
      result.starters = starterList(input.starters)
      forAssistant = 'list_custom_views lists them; open_custom_view opens one; preview_custom_view shows a new or changed spec live; ' +
        'save_custom_view saves (only when asked); get_custom_view_spec reads a spec to change it; export_custom_view makes a PDF or xlsx link; ' +
        'delete_custom_view removes one (only when asked). For a starter, call help with topic "starters" to get its spec, then preview_custom_view.'
      break
    }
    case 'starters': {
      lines.push('Starter views are commonly used layouts, ready to open on live data. Open one as it is, or change it in words and save it under a new name.')
      if (input.starters.length) {
        lines.push('', ...bullet(input.starters.map(s => `${s.name}: ${s.description}`)))
      } else {
        lines.push('', 'None of the starters fit this member\'s access.')
      }
      result.starters = input.starters.map(s => ({ key: s.key, name: s.name, description: s.description, spec: s.spec }))
      forAssistant = 'To open a starter, pass its spec to preview_custom_view as it is (add arguments for vehicle or as_of if the user names one). ' +
        'To keep it, call save_custom_view with the spec and the name the user wants, only once they ask. Change the spec freely first; ' +
        'preview_custom_view says what is wrong if an edit breaks it.'
      break
    }
    case 'dashboards': {
      lines.push(`Built-in dashboards they can open: ${list(input.dashboards, 'none for this access')}.`)
      lines.push(`Their saved dashboards: ${list(input.savedDashboards, 'none saved yet')}.`)
      lines.push('', ...bullet([
        'Open one by asking for it: "show the portfolio dashboard", "statements for the main fund, last quarter".',
        'Say "save this as Q3 LP review" to keep a dashboard with its settings; it reopens on current figures in any later conversation.',
        'Inside a dashboard, click a company or change the period, then ask about what is on screen.',
        'For a layout of their own choosing, build a custom view instead (help topic "views").',
      ]))
      result.saved_dashboards = input.savedDashboards
      forAssistant = 'show_home, show_portfolio_dashboard, show_company_dashboard, show_financial_statements, show_lp_dashboard and show_capital_calls draw them; ' +
        'list_dashboards, open_dashboard, save_dashboard and delete_dashboard manage saved ones.'
      break
    }
    case 'charts': {
      lines.push('Two ways to get a chart:')
      lines.push(...bullet([
        'A quick chart of figures already in the conversation: "chart fair value by company", "plot NAV by quarter". Bars compare categories; a line follows one measure over time.',
        `A chart in a custom view, which stays live and can be saved. Views can use these chart types: ${CHART_TYPES.join(', ')}, plus KPI tiles with sparklines and period comparisons, gauges, tables with totals and colour, pivots and heatmaps.`,
      ]))
      lines.push('', 'Commonly used charts:')
      lines.push(...bullet([
        'Largest positions by fair value (bar)',
        'Share of fair value by stage or industry (pie)',
        'NAV by investor (bar)',
        'DPI and TVPI by vehicle (columns)',
        'Income and expenses by quarter (columns)',
        'Cash at month end (line)',
        'A reported KPI by company and period (heatmap)',
        'Deals by status, or diligence deals by stage (bar or funnel)',
      ]))
      if (input.starters.length) lines.push('', `Each of these is in a starter view: ${input.starters.map(s => s.name).join(', ')}.`)
      result.starters = starterList(input.starters)
      forAssistant = 'show_chart draws figures you already fetched (never invent them). For a live chart, write a custom view spec and call preview_custom_view; ' +
        'the starters (help topic "starters") are worked examples of every common chart.'
      break
    }
    case 'exports': {
      lines.push('Files they can ask for, each as a download link that works for a short time and only for them:')
      lines.push(...bullet([
        'A custom view as a PDF or an Excel workbook.',
        ...(areaKeys.has('books') ? ['Financial statements and fund performance as PDFs, and a forecast as a workbook.'] : []),
        ...(areaKeys.has('lps') ? ['An investor\'s capital account statement or report card as a PDF, and report cards for many investors at once.'] : []),
        ...(areaKeys.has('diligence') ? ['A diligence memo as a document.'] : []),
      ]))
      forAssistant = 'export_custom_view, financial_statements_pdf, fund_performance_pdf, forecast_workbook, lp_statement_pdf, lp_report_card_pdf, ' +
        'lp_report_cards_zip, diligence_memo_export. Use search_tools if one is not in your list. Links expire: call the tool again rather than re-sharing an old link.'
      break
    }
    case 'approvals': {
      lines.push('Some changes made from a conversation wait for approval instead of applying at once. When that happens nothing has changed yet: the change is staged, and the person approves it in the conversation or in the app.')
      lines.push(...bullet([
        'Each staged change is shown in plain words first; it applies only after an explicit yes.',
        'A fix made of several changes is staged as one run, so it is approved once.',
        'Some changes can only be approved in the app, by an admin; the link to it comes back with the change.',
        'Changes still waiting are listed on the pending changes page in the app, where they can be approved or withdrawn.',
      ]))
      forAssistant = 'list_pending_actions lists them; approve_action applies one only after the user says yes; reject_action declines; ' +
        'stage_run groups several changes. Never approve on your own judgement.'
      break
    }
    case 'funds': {
      const n = input.fundCount ?? null
      lines.push(n && n > 1
        ? `This connection can work in ${n} funds, one at a time. Every answer says which fund it came from, and changes only go to the active fund.`
        : 'A connection can work in one fund or, for some admins, several funds one at a time. Every answer says which fund it came from, and changes only go to the active fund.')
      lines.push(...bullet([
        'Ask "which funds can you see?" or "switch to the other fund" on a connection with more than one.',
        'Switching here does not move any other conversation.',
      ]))
      forAssistant = 'list_funds lists them and use_fund switches, where the connection serves more than one fund. Confirm the fund with the user before any change when more than one could be meant.'
      break
    }
    default: {
      const area = areas.find(a => a.key === topic)
      if (!area) {
        lines.push('This member\'s access does not include that area. Ask an admin of the fund if they need it.')
        forAssistant = 'Do not describe what that area holds.'
        break
      }
      const starters = input.starters.filter(s => s.area === topic)
      lines.push(`${area.label}: ${area.blurb}`, '', 'Questions to try:', ...bullet(area.questions.map(q => `"${q}"`)))
      if (starters.length) lines.push('', `Starter views: ${starters.map(s => `${s.name} (${s.description})`).join('; ')}`)
      result.starters = starterList(starters)
      forAssistant = 'Answer with the area\'s read tools; search_tools finds them by keyword.'
    }
  }

  return {
    topic,
    text: lines.join('\n'),
    more_topics: HELP_TOPICS
      .filter(t => t !== topic && (!AREA_TOPICS.includes(t) || areaKeys.has(t)))
      .map(t => ({ topic: t, about: TOPIC_BLURB[t] })),
    ...result,
    for_assistant: forAssistant,
  }
}
