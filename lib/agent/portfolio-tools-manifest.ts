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
import { UPLOADED_FILES_SCHEMA } from './upload-tools-manifest'
import { KEYLESS_TOOL_MANIFEST } from './keyless-tools-manifest'

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
      'For an FX revaluation set valuation_change_source="fx" and supply fx_rate/prior_fx_rate/original_position_value. ' +
      'For an exit, proceeds_received is the GROSS realized (escrow included) and proceeds_escrow the part of it held back: ' +
      'the entry books gross − escrow to cash, the escrow to 1350 escrow receivable, and gross − cost_basis_exited as realized gain.',
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
        proceeds_received: { type: 'number', description: 'proceeds: GROSS proceeds realized at the exit, INCLUDING any amount held back in escrow (not the cash received). Cash booked = proceeds_received − proceeds_escrow' },
        proceeds_escrow: { type: 'number', description: 'proceeds: the part of proceeds_received held back in escrow (a receivable, booked to 1350). Part of the gross, never added to it; must not exceed proceeds_received' },
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
  {
    name: 'update_investment',
    description:
      'Correct a recorded portfolio transaction (list_investments gives its id): change only the fields you pass. ' +
      'Its journal entry is retracted and re-derived from the new values, as an edit on the company page does. ' +
      'To turn a mark into an FX revaluation, pass valuation_change_source="fx" with fx_rate/prior_fx_rate/original_position_value/original_currency. ' +
      'proceeds_received on an exit is the GROSS realized, escrow included; proceeds_escrow is the part of it held back (cash booked = gross − escrow). ' +
      'Refused for a transaction in a closed period or one the fund register owns.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        transaction_id: { type: 'string', description: 'The transaction id, from list_investments.' },
        vehicle: { type: 'string', description: "The transaction's vehicle (portfolio_group)." },
        transaction_type: { type: 'string', enum: ['investment', 'unrealized_gain_change', 'proceeds', 'round_info'] },
        transaction_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        round_name: { type: 'string' },
        notes: { type: 'string' },
        investment_cost: { type: 'number' },
        shares_acquired: { type: 'number' },
        share_price: { type: 'number' },
        unrealized_value_change: { type: 'number', description: 'unrealized_gain_change: the fund-currency value change' },
        current_share_price: { type: 'number' },
        cost_basis_exited: { type: 'number' },
        proceeds_received: { type: 'number', description: 'proceeds: GROSS proceeds realized at the exit, INCLUDING any amount held back in escrow (not the cash received). Cash booked = proceeds_received − proceeds_escrow' },
        proceeds_escrow: { type: 'number', description: 'proceeds: the part of proceeds_received held back in escrow (a receivable, booked to 1350). Part of the gross, never added to it; must not exceed proceeds_received' },
        valuation_change_source: { type: 'string', enum: ['mark', 'fx', 'quote', 'nav'] },
        original_currency: { type: 'string' },
        fx_rate: { type: 'number' },
        prior_fx_rate: { type: 'number' },
        original_position_value: { type: 'number', description: 'Position value in its own currency — held constant across an FX revaluation' },
      },
      required: ['company', 'transaction_id'],
    },
  },
  {
    name: 'delete_investment',
    description:
      'Delete a recorded portfolio transaction (list_investments gives its id) and retract its journal entry, as a delete on the company page does. ' +
      'Refused for a transaction in a closed period, one the fund register owns, or a SAFE/note a conversion depends on.',
    scope: 'write',
    domain: 'portfolio',
    accessFeature: 'investments',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        transaction_id: { type: 'string', description: 'The transaction id, from list_investments.' },
        vehicle: { type: 'string', description: "The transaction's vehicle (portfolio_group)." },
      },
      required: ['company', 'transaction_id'],
    },
  },
  {
    name: 'submit_company_update',
    description:
      "Hand the fund a portfolio company's update: a quarterly letter, board deck or KPI sheet. Pass the text you have, " +
      'and/or files (up to 5: PDF, Word, Excel, PowerPoint, CSV, text, images): upload each with company_update_upload_url and ' +
      'pass uploaded_files (up to 25 MB each; never ask the person to paste a file into chat), or send one under 3 MB you ' +
      'already hold as base64 in files. It runs the same ' +
      'pipeline as an emailed update: matched to the company (name it if you know it), kept on the company\'s Updates, ' +
      'its KPIs recorded as metric values, and anything uncertain sent to the review queue. Returns what was recorded and what needs review.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: { ...COMPANY, description: 'Company id or name. Omit to let the app identify it from the content.' },
        subject: { type: 'string', description: 'A title, e.g. "Acme Q3 2026 investor update".' },
        text: { type: 'string', description: 'The update\'s text (up to 100,000 characters).' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { filename: { type: 'string' }, content_base64: { type: 'string' } },
            required: ['filename', 'content_base64'],
          },
        },
        uploaded_files: UPLOADED_FILES_SCHEMA('company_update_upload_url', 'up to 25 MB each'),
      },
    },
  },
  {
    name: 'company_update_status',
    description:
      'What became of a company update handed over with submit_company_update: still processing, done or failed, the company ' +
      'it was matched to, the KPIs recorded and anything sent for review. Pass the job_id it returned.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', description: 'The job id a tool returned (its job.id).' } }, required: ['job_id'] },
  },
  {
    name: 'record_metric_value',
    description:
      "Set one KPI value for a portfolio company for a period, e.g. MRR for Q3 2026. Use company_metrics to see the company's metrics. " +
      'Replaces any value already recorded for that metric and period.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        metric: { type: 'string', description: 'The metric\'s name or slug (e.g. "MRR"), or its id.' },
        period: { type: 'string', description: '"Q3 2026", "Sep 2026", "2026-09" or "FY2025".' },
        value: { type: ['number', 'string'], description: 'A number, or text for a text metric.' },
        notes: { type: 'string' },
      },
      required: ['company', 'metric', 'period', 'value'],
    },
  },
  {
    name: 'create_company',
    description:
      'Add a portfolio company, seeded with the fund\'s default metrics. A member must name at least one of their entities (vehicles).',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        vehicles: { type: 'array', items: { type: 'string' }, description: 'The entities (portfolio groups) that hold it.' },
        stage: { type: 'string' },
        industry: { type: 'array', items: { type: 'string' } },
        overview: { type: 'string' },
        founders: { type: 'string' },
        why_invested: { type: 'string' },
        contact_emails: { type: 'array', items: { type: 'string' }, description: 'Addresses its updates come from, so emailed updates match it.' },
        aliases: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_company_note',
    description:
      'Add an internal note on a portfolio company, as the person connected. @mentions of team members notify them. ' +
      'If the company is held by more than one of their entities, name the entity.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'relationships',
    accessFeature: 'notes',
    inputSchema: {
      type: 'object',
      properties: {
        company: COMPANY,
        content: { type: 'string' },
        vehicle: { type: 'string', description: 'The entity the note is for, by name, when more than one holds the company.' },
      },
      required: ['company', 'content'],
    },
  },
  ...KEYLESS_TOOL_MANIFEST,
]
