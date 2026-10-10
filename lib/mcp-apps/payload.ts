// The contract between the dashboard tools (server) and the dashboard view (the HTML the host
// renders in the conversation). Pure types and constants, NO server imports: the view bundle
// (lib/mcp-apps/app, built by scripts/build-mcp-app.mjs) imports this file into a browser.
//
// A dashboard tool returns one `DashboardPayload`. Over MCP it travels twice in the same result:
//   - `structuredContent` is the whole payload, for the view to render;
//   - `content` is `payload.data` as JSON text, for the model to read and answer questions from.
// Hosts differ on whether the model sees `structuredContent` (ChatGPT shows it, the MCP Apps spec
// does not add it to context), so the text block is what makes "ask a question about what you are
// looking at" work in both.

export const DASHBOARD_VIEWS = ['portfolio', 'company', 'statements', 'lps', 'calls'] as const
export type DashboardView = (typeof DASHBOARD_VIEWS)[number]

/** The tool that renders each view. The view calls these by name to drill in or change a filter. */
export const VIEW_TOOL: Record<DashboardView, string> = {
  portfolio: 'show_portfolio_dashboard',
  company: 'show_company_dashboard',
  statements: 'show_financial_statements',
  lps: 'show_lp_dashboard',
  calls: 'show_capital_calls',
}

export const VIEW_LABEL: Record<DashboardView, string> = {
  portfolio: 'Portfolio overview',
  company: 'Company detail',
  statements: 'Financial statements',
  lps: 'LP capital',
  calls: 'Capital calls',
}

export interface DashboardBranding {
  fundName: string | null
  /** ISO 4217. Figures are stored in the fund's reporting currency. */
  currency: string
  /**
   * The fund's theme as `--name:value` pairs (lib/theme.ts `themeCssVars`), so a white-labelled
   * deployment's dashboards carry its colour. Validated on the server; the view re-checks the
   * shape before applying any of it.
   */
  cssVars: string
}

interface PayloadBase<V extends DashboardView, D> {
  view: V
  title: string
  /** One line under the title: the vehicle, the period, the as-of date. */
  subtitle: string | null
  /** The arguments that produced this payload, so the view can re-request it with one changed. */
  args: Record<string, unknown>
  /** ISO timestamp. Dashboards are live, so the view says when the figures were read. */
  generatedAt: string
  branding: DashboardBranding
  data: D
}

// ---------------------------------------------------------------------------------------------
// Portfolio overview
// ---------------------------------------------------------------------------------------------

export interface PortfolioPosition {
  company: string
  companyId: string
  status: string | null
  stage: string | null
  industry: string[]
  cost: number
  fairValue: number
  unrealized: number
  realized: number
  moic: number | null
  pctOfPortfolio: number
}

export interface VehiclePerformance {
  vehicle: string
  committed: number
  called: number
  unfunded: number
  distributed: number
  nav: number
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
}

export interface PortfolioData {
  asOf: string
  vehicle: string
  positions: PortfolioPosition[]
  totals: { cost: number; fairValue: number; unrealized: number; realized: number; grossMoic: number | null }
  /**
   * Committed / called / distributed / NAV per vehicle. Null when the caller lacks the
   * `accounting` grant: that half is the fund's financial position, not the portfolio's.
   */
  performance: VehiclePerformance[] | null
  /** The entities this member can see, to switch the dashboard to one of them. */
  vehicles?: string[]
}

// ---------------------------------------------------------------------------------------------
// Company detail
// ---------------------------------------------------------------------------------------------

export interface CompanyRound {
  roundName: string
  date: string | null
  invested: number
  shares: number
  sharePrice: number | null
  currentValue: number
  realized: number
}

export interface CompanyMetricSeries {
  name: string
  unit: string | null
  /** Oldest first. Non-numeric readings are dropped: they cannot be plotted. */
  values: { period: string; value: number }[]
}

export interface CompanyData {
  id: string
  name: string
  status: string | null
  stage: string | null
  industry: string[]
  vehicles: string[]
  overview: string | null
  summary: {
    invested: number
    fairValue: number
    realized: number
    moic: number | null
    grossIrr: number | null
  }
  rounds: CompanyRound[]
  metrics: CompanyMetricSeries[]
}

// ---------------------------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------------------------

export const STATEMENT_PRESETS = ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd'] as const
export type StatementPreset = (typeof STATEMENT_PRESETS)[number]

export const STATEMENT_PRESET_LABEL: Record<StatementPreset, string> = {
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  ytd: 'Year to date',
  prior_year: 'Prior year',
  itd: 'Inception to date',
}

export interface StatementLine { code: string; name: string; amount: number }
export interface StatementSectionData { label: string; rows: StatementLine[]; total: number }

export interface CashFlowSectionData {
  label: string
  rows: { name: string; amount: number }[]
  total: number
}

export interface PartnerCapitalRow {
  name: string
  beginning: number
  /** Activity lines for the period, in the statement's own order: label and signed amount. */
  activity: { label: string; amount: number }[]
  ending: number
}

export interface StatementsData {
  vehicle: string
  period: { preset: string; label: string; start: string | null; end: string | null }
  balanceSheet: {
    assets: StatementSectionData
    liabilities: StatementSectionData
    equityLabel: string
    equityTotal: number
    /** assets - liabilities - equity. Zero when the ledger balances. */
    check: number
    unallocatedEarnings: number
  }
  incomeStatement: {
    income: StatementSectionData
    expenses: StatementSectionData
    netIncome: number
  }
  cashFlows: {
    operating: CashFlowSectionData
    financing: CashFlowSectionData
    netChange: number
    openingCash: number
    endingCash: number
  } | null
  /**
   * Null when the caller may not see LP capital (the fund has switched it off or hidden it). The
   * per-partner roll-forward is LP capital even though it is derived from the books.
   */
  partnersCapital: null | {
    partners: PartnerCapitalRow[]
    totals: PartnerCapitalRow
    /**
     * True when the carry recipients' rows were folded into one combined row because the caller
     * lacks `gp_economics` (lib/access/carry-visibility.ts). The view says so.
     */
    carryWithheld: boolean
  }
}

// ---------------------------------------------------------------------------------------------
// LP capital
// ---------------------------------------------------------------------------------------------

export interface LpRow {
  investor: string
  entity: string
  vehicle: string
  commitment: number
  paidIn: number
  distributions: number
  nav: number
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}

export interface LpData {
  asOf: string | null
  vehicle: string
  rows: LpRow[]
  totals: {
    commitment: number
    paidIn: number
    distributions: number
    nav: number
    dpi: number | null
    rvpi: number | null
    tvpi: number | null
  }
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Capital calls — one call, and who has paid it
// ---------------------------------------------------------------------------------------------

/**
 * Where one partner stands on one call. `says_wired` is the partner's own word from the portal
 * ("we wired on…") with nothing yet received: worth a look at the bank, not a reminder.
 */
export type CallLineStatus = 'paid' | 'partial' | 'says_wired' | 'unpaid'

export interface CallSummary {
  id: string
  number: number | null
  date: string
  dueDate: string | null
  description: string | null
  total: number
  received: number
  outstanding: number
  /** open | partial | settled, from the books (lib/accounting/settlement.ts). */
  status: 'open' | 'partial' | 'settled'
  /** Still owed past the due date. */
  overdue: boolean
}

export interface CallLine {
  lp: string
  called: number
  received: number
  outstanding: number
  status: CallLineStatus
  overdue: boolean
  receivedOn: string | null
  saysWired: { on: string | null; reference: string | null } | null
}

export interface CallsData {
  vehicle: string
  /** Every call on the vehicle, newest first, to switch between. */
  calls: CallSummary[]
  /** The call being shown; null when the vehicle has none. */
  selected: (CallSummary & { lines: CallLine[] }) | null
}

// ---------------------------------------------------------------------------------------------
// Home — where a member starts: what they can open, what they saved, what to ask
// ---------------------------------------------------------------------------------------------

/** Not a saveable dashboard (it has no figures); the launcher for the ones that are. */
export const HOME_TOOL = 'show_home'

export interface HomeData {
  /** The dashboards this member may open, with the tool and arguments that open each. */
  dashboards: { view: DashboardView; label: string; description: string; tool: string; args: Record<string, unknown> }[]
  /** Their own and their colleagues' shared dashboards, most recent first. */
  saved: SavedDashboardSummary[]
  /** Example questions for the areas they can read. Clicking one asks it in the conversation. */
  areas: { key: string; label: string; blurb: string; questions: string[] }[]
  tips: string[]
  /** The same, as text: what the model reads, and what a host without MCP Apps shows. */
  help: string
}

export type PortfolioPayload = PayloadBase<'portfolio', PortfolioData>
export type CompanyPayload = PayloadBase<'company', CompanyData>
export type StatementsPayload = PayloadBase<'statements', StatementsData>
export type LpPayload = PayloadBase<'lps', LpData>
export type CallsPayload = PayloadBase<'calls', CallsData>

export type HomePayload = Omit<PayloadBase<DashboardView, HomeData>, 'view'> & { view: 'home' }

export type DashboardPayload = PortfolioPayload | CompanyPayload | StatementsPayload | LpPayload | CallsPayload | HomePayload

/** Narrowing guard for anything arriving over the wire. */
export function isDashboardPayload(x: unknown): x is DashboardPayload {
  if (!x || typeof x !== 'object') return false
  const p = x as { view?: unknown; data?: unknown }
  return typeof p.view === 'string'
    && ((DASHBOARD_VIEWS as readonly string[]).includes(p.view) || p.view === 'home')
    && !!p.data && typeof p.data === 'object'
}

// ---------------------------------------------------------------------------------------------
// Saved dashboards
// ---------------------------------------------------------------------------------------------

export interface SavedDashboardSummary {
  /** A uuid for a saved dashboard; `standard:<view>` for the ones every member starts with. */
  id: string
  name: string
  view: DashboardView
  arguments: Record<string, unknown>
  /** `standard` ships with the app, `mine` is the caller's own, `shared` is a colleague's. */
  kind: 'standard' | 'mine' | 'shared'
  updatedAt: string | null
}
