// Getting started with the fund from Claude, ChatGPT or any MCP client: the example questions, the
// prompt templates, and the help text. ONE catalog, read by every place that teaches it — the
// home dashboard (`show_home`), MCP `prompts/list`, the plugin's conversation starters, Settings →
// API and MCP, and the Support page — so they cannot drift into suggesting different things.
//
// Pure: no server imports (Settings and the Support page import it into the browser). Access is
// passed in as a predicate, so the same catalog filters to a member's own areas on the server and
// shows everything where there is no member (the plugin README, the Support page).

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'

/** Can the caller read this area? Absent = show everything (no member to filter for). */
export type CanRead = (domain: Domain, feature?: FeatureKey) => boolean

export interface Area {
  key: string
  label: string
  /** What the area is, in one line. */
  blurb: string
  domain: Domain
  feature?: FeatureKey
  /** Questions to try — written as a person would type them. */
  questions: string[]
}

export const AREAS: Area[] = [
  {
    key: 'portfolio',
    label: 'Portfolio',
    blurb: 'Companies, positions, marks and KPIs.',
    domain: 'portfolio',
    questions: [
      'Show me the portfolio.',
      'Which companies are marked below cost?',
      'Open the dashboard for our largest position.',
      'How has ARR changed across the portfolio over the last year?',
    ],
  },
  {
    key: 'books',
    label: 'Books',
    blurb: 'Financial statements, the ledger and the bank.',
    domain: 'accounting',
    questions: [
      'Pull up the balance sheet for our main fund, last quarter.',
      'What were our largest expenses this year?',
      'Does cash in the books tie to the bank?',
    ],
  },
  {
    key: 'lps',
    label: 'LP capital',
    blurb: 'Commitments, calls, distributions and NAV by investor.',
    domain: 'lp_capital',
    questions: [
      'Who has funded their capital calls?',
      'Who still owes us on the latest capital call?',
      'Show LP capital as of the last quarter end.',
      "What is each investor's DPI and TVPI?",
      "Give me a PDF of an investor's capital account statement for last quarter.",
    ],
  },
  {
    key: 'forecast',
    label: 'Forecast',
    blurb: 'Budgets, rolling forecasts and variance.',
    domain: 'accounting',
    feature: 'budgeting',
    questions: [
      'Draft a 12-month forecast for the management company.',
      'What are the largest variances to budget this quarter?',
      'Show actual and forecast cash through next year.',
    ],
  },
  {
    key: 'deals',
    label: 'Deal flow',
    blurb: 'Inbound pitches and how they scored.',
    domain: 'dealflow',
    feature: 'deals',
    questions: ['What new deals came in this week?', 'Which inbound deals best fit our thesis?'],
  },
  {
    key: 'diligence',
    label: 'Diligence',
    blurb: 'Deals in diligence, checklists and evidence.',
    domain: 'diligence',
    feature: 'diligence',
    questions: ["What's still open on our diligence checklists?", 'Summarize the evidence on our current deal.'],
  },
]

/** Things every member can do, whatever their areas. */
export const DASHBOARD_TIPS = [
  'Say "save this as Q3 LP review" to keep a dashboard; it always reopens on current figures.',
  'Say "open my Q3 LP review" in any later conversation, in Claude or ChatGPT.',
  'Click a company or change the period inside a dashboard, then ask about what you see.',
  'Ask "what can you do?" to come back here.',
]

export function areasFor(canRead?: CanRead): Area[] {
  return canRead ? AREAS.filter(a => canRead(a.domain, a.feature)) : AREAS
}

// ---------------------------------------------------------------------------------------------
// Prompt templates — MCP `prompts/list` / `prompts/get`
// ---------------------------------------------------------------------------------------------

export interface PromptArgument {
  name: string
  description: string
  required?: boolean
}

export interface PromptTemplate {
  name: string
  title: string
  description: string
  arguments: PromptArgument[]
  /** Domain needed to make the prompt useful. Absent = every member. */
  domain?: Domain
  feature?: FeatureKey
  text: (args: Record<string, string>) => string
}

const opt = (v: string | undefined, f: (s: string) => string) => (v && v.trim() ? f(v.trim()) : '')

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    name: 'get_started',
    title: 'Get started',
    description: 'See what you can do with your fund here — dashboards, questions to ask, and how to save views.',
    arguments: [],
    text: () => 'Show me the home dashboard, then briefly explain what I can do with my fund here and suggest three things to try first.',
  },
  {
    name: 'portfolio_review',
    title: 'Portfolio review',
    description: 'The portfolio dashboard, with what stands out: gains, positions below cost, recent changes.',
    arguments: [{ name: 'as_of', description: 'Optional date (YYYY-MM-DD) to value the portfolio as of.' }],
    domain: 'portfolio',
    text: a => `Show the portfolio dashboard${opt(a.as_of, d => ` as of ${d}`)}. Then summarize: total cost, fair value and gross MOIC; the biggest gains; every position marked below cost; and anything that changed recently.`,
  },
  {
    name: 'company_check_in',
    title: 'Company check-in',
    description: "One company's dashboard, with its performance, KPI trends and risks.",
    arguments: [{ name: 'company', description: 'The company name.', required: true }],
    domain: 'portfolio',
    text: a => `Open the dashboard for ${a.company || 'the company'}. Summarize its performance since our first investment, the trend in its KPIs, and any risks or open questions in its latest updates.`,
  },
  {
    name: 'quarter_end_review',
    title: 'Quarter-end review',
    description: "A vehicle's statements and LP capital for the quarter, and what needs attention before reporting.",
    arguments: [
      { name: 'vehicle', description: 'The fund or SPV.', required: true },
      { name: 'period', description: 'last_quarter (default), this_quarter, ytd, prior_year or itd.' },
    ],
    domain: 'accounting',
    text: a => `For ${a.vehicle || 'the fund'}: show the financial statements for ${a.period || 'last_quarter'}, then the LP capital dashboard. List anything that needs attention before the quarter-end report — whether the balance sheet balances, unfunded calls, unusual expense changes, and the variance against the approved budget if there is one.`,
  },
  {
    name: 'lp_capital_status',
    title: 'LP capital status',
    description: 'Who has funded, what is outstanding, and each investor\'s multiples.',
    arguments: [{ name: 'vehicle', description: 'Optional: one fund or SPV.' }],
    domain: 'lp_capital',
    text: a => `Show the LP capital dashboard${opt(a.vehicle, v => ` for ${v}`)}. Who has funded their calls, what is still outstanding and from whom, and how do DPI and TVPI compare across investors?`,
  },
  {
    name: 'draft_forecast',
    title: 'Draft a forecast',
    description: "A rolling forecast for an entity, suggested from its own history, for you to review.",
    arguments: [
      { name: 'vehicle', description: 'The entity — a fund, SPV or management company.', required: true },
      { name: 'months', description: 'Horizon: 12 (default), 18, 24 or 36.' },
    ],
    domain: 'accounting',
    feature: 'budgeting',
    text: a => `Draft a ${a.months || '12'}-month rolling forecast for ${a.vehicle || 'the entity'}. Start from forecast_suggest_rules, which reads up to 36 months of its closed history. Show me the suggested rule for each account, say which ones you are unsure about and why, and ask what I know that history does not (hires, price changes, new costs) before creating anything.`,
  },
  {
    name: 'budget_variance',
    title: 'Budget variance',
    description: 'Actuals against the approved budget: the largest variances and why.',
    arguments: [{ name: 'vehicle', description: 'The entity with a budget.', required: true }],
    domain: 'accounting',
    feature: 'budgeting',
    text: a => `Compare ${a.vehicle || 'the entity'}'s actuals this year with its approved budget. List the largest variances by account, favourable and unfavourable, and for each say whether it looks like timing or a real change.`,
  },
]

export function promptsFor(canRead?: CanRead): PromptTemplate[] {
  return canRead ? PROMPT_TEMPLATES.filter(p => !p.domain || canRead(p.domain, p.feature)) : PROMPT_TEMPLATES
}

/** `prompts/list` shape. */
export function describePrompt(p: PromptTemplate) {
  return { name: p.name, title: p.title, description: p.description, arguments: p.arguments }
}

export class PromptArgumentError extends Error {}

/** `prompts/get` result for one template, or a PromptArgumentError naming the missing argument. */
export function renderPrompt(p: PromptTemplate, raw: unknown) {
  const args: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') args[k] = v.slice(0, 200)
  }
  for (const a of p.arguments) if (a.required && !args[a.name]?.trim()) throw new PromptArgumentError(`Missing required argument: ${a.name}`)
  return {
    description: p.description,
    messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }],
  }
}

// ---------------------------------------------------------------------------------------------
// Help, as text — for the model, and for any host that cannot draw the home dashboard
// ---------------------------------------------------------------------------------------------

export function helpText(opts: { fundName?: string | null; canRead?: CanRead; dashboards: string[]; saved: string[] }): string {
  const areas = areasFor(opts.canRead)
  const lines: string[] = []
  lines.push(`You are connected to ${opts.fundName ?? 'the fund'}'s Portfolio deployment, signed in as this member. Everything here is limited to what their own access allows.`)
  lines.push('')
  lines.push(`Dashboards you can open: ${opts.dashboards.join(', ') || 'none for this access'}.`)
  if (opts.saved.length) lines.push(`Saved dashboards: ${opts.saved.join(', ')}.`)
  lines.push('')
  lines.push('Things to ask:')
  for (const a of areas) lines.push(`- ${a.label} (${a.blurb}) e.g. "${a.questions[0]}"`)
  lines.push('')
  lines.push('Tips:')
  for (const t of DASHBOARD_TIPS) lines.push(`- ${t}`)
  lines.push('')
  lines.push('Present this to the user as a short, friendly overview with three suggestions to try first; do not list tool names.')
  return lines.join('\n')
}
