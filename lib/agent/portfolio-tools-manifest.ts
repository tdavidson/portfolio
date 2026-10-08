// Pure metadata for the PORTFOLIO agent tools — companies, investments, performance,
// LPs. NO server imports, so this is safe in client components (the Settings key UI
// lists it). Handlers live in portfolio-tools.ts.
//
// These are fund-scoped, not vehicle-scoped: a company can sit in more than one
// vehicle, and "how is the portfolio doing" is a question about the fund. Ledger tools
// are the opposite — every one of them operates on a single set of books. That's the
// `domain` flag, and it's why the dispatcher only injects a `vehicle` argument into
// ledger tools.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }

/** Optional vehicle filter — narrows to one vehicle rather than scoping the call to it. */
const VEHICLE_FILTER = { type: 'string', description: 'Optional: only companies/positions in this vehicle (portfolio_group).' }
const COMPANY = { type: 'string', description: 'Company id, or the company name (matched case-insensitively).' }

export const PORTFOLIO_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'list_vehicles',
    description: "List the fund's investment vehicles (funds, SPVs, GP entities) with their kind.",
    scope: 'read',
    domain: 'portfolio',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'list_companies',
    description: 'List portfolio companies with stage, industry, status, and which vehicles hold them.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE_FILTER,
        status: { type: 'string', description: 'Optional: active | exited | written_off' },
        q: { type: 'string', description: 'Optional: match on company name or industry.' },
      },
    },
  },
  {
    name: 'company_detail',
    description: 'One company in full: overview, founders, why we invested, stage, industry, status, and its investment summary (cost, fair value, MOIC, ownership, rounds).',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: { company: COMPANY, vehicle: VEHICLE_FILTER },
      required: ['company'],
    },
  },
  {
    name: 'list_investments',
    description: 'The raw investment transactions (purchases, marks, FX revaluations, proceeds) for a company, or for a whole vehicle.',
    scope: 'read',
    domain: 'portfolio',
    // Same switch its web equivalent (api/portfolio/investments) names. Without it, hiding the
    // Investments feature wouldn't apply over MCP.
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Optional: company id or name. Omit to get every transaction in the vehicle.' },
        vehicle: VEHICLE_FILTER,
      },
    },
  },
  {
    name: 'portfolio_summary',
    description: 'Every position with cost, fair value, unrealized gain, MOIC and % of the portfolio, plus fund totals. This is the schedule of investments as the tracker sees it.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE_FILTER,
        as_of: { type: 'string', description: 'Optional ISO date — value the portfolio as of then rather than today.' },
      },
    },
  },
  {
    name: 'fund_performance',
    description: 'Fund-level performance per vehicle: committed, called, distributed, NAV, DPI, RVPI, TVPI, and gross MOIC on invested capital.',
    scope: 'read',
    domain: 'portfolio',
    // Committed / called / distributed / NAV, read straight from the LP register — the fund's
    // financial position, not the portfolio's. Its route sibling (/api/accounting/fund-economics)
    // is gated `accounting`, and this must match: `portfolio` has no fund-level switch, so
    // leaving it there served the books to any member even with accounting switched off.
    accessDomain: 'accounting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE_FILTER },
    },
  },
  {
    name: 'company_metrics',
    description: 'The KPI time series tracked for a company (ARR, headcount, runway, whatever the fund records).',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: { company: COMPANY },
      required: ['company'],
    },
  },
  {
    name: 'list_lps',
    description: 'LP positions per vehicle: commitment, paid-in, distributions, NAV and multiples for each partner.',
    scope: 'read',
    domain: 'portfolio',
    // Named partners and their commitments. Dispatched as a portfolio tool (fund-scoped, no
    // vehicle injection), but it is LP capital for access — the two fields answer different
    // questions.
    accessDomain: 'lp_capital',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE_FILTER },
    },
  },
  {
    name: 'get_updates',
    description:
      "Portfolio-reporting updates (what companies sent us: the email plus extracted attachment text). " +
      "One composable retrieval: list a company's history, search across updates with words or \"quoted phrases\", " +
      'or take each company\'s LATEST update only (mode latest_per_company — current state, never an old mention). ' +
      'Results are excerpts with source locators (page, slide, sheet/rows, section), exact match counts, a cursor, ' +
      'and extraction warnings — treat a partial/failed extraction as "could not read", not "did not mention". ' +
      'Pass ids: [update_id] for the full body and attachment text of specific updates, or artifact: { id, offset } ' +
      'to page through one long attachment. Text is cut to max_chars and every cut is marked.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        query: { type: 'string', description: 'Words, "quoted phrases", OR alternatives, -negations. Identifiers and figures fall back to exact substring matching.' },
        mode: { type: 'string', enum: ['list', 'search', 'latest_per_company'], description: 'list = newest first with a short preview (default without a query); search = ranked matches (default with a query); latest_per_company = each company\'s most recent update, optionally filtered by query.' },
        since: { type: 'string', description: 'Inclusive ISO date YYYY-MM-DD' },
        until: { type: 'string', description: 'Inclusive ISO date YYYY-MM-DD' },
        order: { type: 'string', enum: ['relevance', 'newest'] },
        match: { type: 'string', enum: ['auto', 'lexical', 'exact'], description: 'auto (default) tries word matching then exact substring.' },
        limit: { type: 'number', description: 'Updates per page (1-100; default 10, 50 for latest_per_company)' },
        cursor: { type: 'string', description: 'next_cursor from a previous call' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Full retrieval of up to 10 update ids (body + attachment text)' },
        artifact: {
          type: 'object',
          properties: { id: { type: 'string' }, offset: { type: 'number' } },
          description: 'Read one attachment\'s complete extracted text from a character offset',
        },
        max_chars: { type: 'number', description: 'Character budget for returned text (500-60000; default 12000)' },
      },
    },
  },
  {
    name: 'record_investment',
    description:
      'Record a portfolio transaction (investment | unrealized_gain_change | proceeds | round_info). ' +
      'Also books the journal entry it implies in that vehicle\'s ledger: a mark (no cash) posts; a purchase, exit or cash income drafts and posts when matched to its bank transaction. ' +
      'For an FX revaluation set valuation_change_source="fx" and supply fx_rate/prior_fx_rate/original_position_value.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group) the transaction belongs to. Required for it to reach the ledger.' },
        transaction_type: { type: 'string', enum: ['investment', 'unrealized_gain_change', 'proceeds', 'round_info'] },
        transaction_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        round_name: { type: 'string' },
        investment_cost: { type: 'number', description: 'investment: amount invested' },
        shares_acquired: { type: 'number' },
        share_price: { type: 'number' },
        unrealized_value_change: { type: 'number', description: 'unrealized_gain_change: the fund-currency value change' },
        current_share_price: { type: 'number' },
        cost_basis_exited: { type: 'number', description: 'proceeds: cost basis coming off the books' },
        proceeds_received: { type: 'number', description: 'proceeds: cash received' },
        valuation_change_source: { type: 'string', enum: ['mark', 'fx', 'quote', 'nav'], description: "'fx' books the change as a currency translation, not investment performance; 'quote' and 'nav' are a quoted price and a manager's NAV, booked as a mark" },
        original_currency: { type: 'string' },
        fx_rate: { type: 'number' },
        prior_fx_rate: { type: 'number' },
        original_position_value: { type: 'number', description: 'Position value in its own currency — held constant across an FX revaluation' },
        notes: { type: 'string' },
      },
      required: ['company', 'transaction_type', 'transaction_date'],
    },
  },
]
