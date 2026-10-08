// Pure metadata for the agent tools — name, description, scope, and JSON-Schema
// input contract. NO server imports, so this is safe to import into client
// components (e.g. the Settings key-management UI). The handlers live in
// agent-tools.ts, which merges these with server-side implementations.

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'

export interface AgentToolMeta {
  name: string
  description: string
  scope: 'read' | 'write'
  /**
   * WHICH CONTENT AREA THIS TOOL READS OR WRITES — the authorization answer, checked against the
   * caller's grants before the tool runs and used to filter what `tools/list` even shows.
   *
   * Distinct from `domain` below, which is a DISPATCH concern (does this tool need a vehicle?) and
   * cannot answer it: several `ledger` tools are really LP capital (capital_accounts) or GP
   * economics (run_waterfall), and gating those as plain accounting would hand the partners' carry
   * to anyone who can reconcile the bank.
   *
   * Omitted = derived from `domain` (see ACCESS_DOMAIN_BY_DISPATCH in agent-tools.ts). Set it
   * explicitly wherever that derivation would be wrong.
   */
  accessDomain?: Domain
  /**
   * The fund-level switch this tool answers to, where its domain has no single one.
   *
   * `portfolio`, `relationships` and `lp_relations` each span several independently-switchable
   * features, so their DOMAIN has no `primaryFeature` — and `effectiveAccess` with no feature
   * treats the ceiling as wide open. Web routes avoid that by naming their own key
   * (route-domains.ts); a tool must too, or `hidden`/`off` simply doesn't apply to it over MCP —
   * not even for an admin.
   */
  accessFeature?: FeatureKey
  /**
   * `ledger` tools operate on ONE set of books, so the dispatcher resolves a vehicle for
   * them and injects a `vehicle` argument. EVERY OTHER DOMAIN IS FUND-SCOPED — a company
   * can sit in several vehicles, a deal belongs to no vehicle at all, and "how is the
   * fund doing" spans all of them — so they take an optional vehicle FILTER where it
   * makes sense and must never be forced to pick one.
   *
   * That is the only thing `domain` controls at dispatch (see `isLedgerTool`); the rest
   * is grouping for the settings UI. Adding a domain therefore costs a manifest, a
   * handler map, and one line in the registry — MCP, REST, scopes and rate limiting all
   * pick it up for free.
   *
   * Defaults to `ledger` when omitted, which is what every tool in this file is.
   */
  domain?: 'ledger' | 'portfolio' | 'diligence' | 'deals' | 'lp'
  inputSchema: Record<string, any>
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }
const ALLOCATION_ACTIONS = ['management_fee', 'expense', 'gain', 'distribution', 'carry', 'close_period']

export const AGENT_TOOL_MANIFEST: AgentToolMeta[] = [
  { name: 'list_accounts', description: "List the fund's chart of accounts (code, name, type).", scope: 'read', inputSchema: EMPTY_SCHEMA },
  // LP identities + commitments — the lp_capital tier, not plain bookkeeping.
  { name: 'list_entities', description: 'List LP entities with committed capital.', scope: 'read', accessDomain: 'lp_capital', inputSchema: EMPTY_SCHEMA },
  { name: 'capital_accounts', description: 'Per-LP capital-account roll-forward (beginning, contributions, distributions, fees, gains, ending) plus fund NAV.', scope: 'read', accessDomain: 'lp_capital', inputSchema: EMPTY_SCHEMA },
  { name: 'financial_statements', description: 'Trial balance, balance sheet, and income statement derived from posted entries.', scope: 'read', inputSchema: EMPTY_SCHEMA },
  {
    name: 'list_journal',
    description: 'List recent journal entries with their postings.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max entries (default 100)' } } },
  },
  {
    name: 'post_entry',
    description: 'Post a balanced double-entry journal entry. Postings use account codes; amounts are signed (debits positive, credits negative) and MUST sum to zero.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['entryDate', 'postings'],
      properties: {
        entryDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        memo: { type: 'string' },
        sourceType: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'posted'], description: 'default posted' },
        postings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['accountCode', 'amount'],
            properties: {
              accountCode: { type: 'string' },
              amount: { type: 'number', description: 'signed: debit positive, credit negative' },
              currency: { type: 'string', description: 'default USD' },
              lpEntityId: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'allocation',
    description: 'Compute and post a period allocation or period close: management_fee, expense, gain, distribution, carry, or close_period.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['action', 'entryDate'],
      properties: {
        action: { type: 'string', enum: ALLOCATION_ACTIONS },
        entryDate: { type: 'string' },
        memo: { type: 'string' },
        annualRate: { type: 'number', description: 'management_fee: decimal, e.g. 0.02' },
        periodFraction: { type: 'number', description: 'management_fee: e.g. 0.25 for a quarter' },
        amount: { type: 'number', description: 'expense / gain total' },
        overrides: { type: 'object', description: 'management_fee: per-LP { rateOverride, exempt }' },
        perLp: { type: 'object', description: 'distribution / carry: { lpEntityId: amount }' },
        post: { type: 'boolean', description: 'default true; false returns a preview' },
      },
    },
  },
  {
    name: 'list_periods',
    description: 'List the vehicle\'s fiscal periods and whether each is open or closed (locked).',
    scope: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'close_period',
    description: 'Close and lock a fiscal period: snapshot the ledger text and block new postings dated in the range. Body: periodStart, periodEnd, label?.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['periodStart', 'periodEnd'],
      properties: {
        periodStart: { type: 'string' },
        periodEnd: { type: 'string' },
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'export_ledger_text',
    description: "Export the vehicle's ledger as plain-text double-entry.",
    scope: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'post_ledger_text',
    description: 'Author entries as plain-text double-entry: parse and persist each balanced entry. Accounts are referenced by name (Root:Slug:Code) or by chart code.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'plain-text double-entry transactions' },
        reviewToken: { type: 'string', description: 'Token returned by the import comparison. Supply only after presenting the differences and the user authorizes proceeding.' },
        status: { type: 'string', enum: ['draft', 'posted'], description: 'override the per-entry flag' },
      },
    },
  },
  {
    name: 'reconcile',
    description: "Reconcile the ledger's capital accounts against admin figures. `admin` is { lpEntityId: { ending, ... } }.",
    scope: 'read',
    // Returns per-LP capital figures, so it sits with the capital accounts it reconciles.
    accessDomain: 'lp_capital',
    inputSchema: {
      type: 'object',
      properties: {
        admin: { type: 'object', description: 'per-LP admin capital figures' },
        tolerance: { type: 'number', description: 'default 0.01' },
      },
    },
  },
  {
    name: 'import_bank_transactions',
    description: 'Import a CSV/TSV transaction feed (bank, Ramp, QuickBooks export): parse, dedup, stage, and draft a balanced entry per row for review.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['csv'],
      properties: {
        csv: { type: 'string', description: 'CSV/TSV with date, description, and amount (or debit/credit) columns' },
        reviewToken: { type: 'string', description: 'Token returned by the import comparison. Supply only after presenting the differences and the user authorizes proceeding.' },
        source: { type: 'string', description: 'csv | plaid | ramp | quickbooks (default csv)' },
      },
    },
  },
  {
    name: 'categorize_bank_transactions',
    description: 'AI-categorize staged (drafted) bank transactions against the chart of accounts and re-point their draft entries.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'specific transaction ids; omit for all drafted' } },
    },
  },
  {
    name: 'book_capital_call',
    description: 'Turn a bank inflow into a per-LP allocated capital call (pro-rata by commitment), replacing its two-line draft.',
    scope: 'write',
    // Allocates per LP by commitment — LP capital, not just a bank entry.
    accessDomain: 'lp_capital',
    inputSchema: {
      type: 'object',
      required: ['bankTransactionId'],
      properties: { bankTransactionId: { type: 'string' } },
    },
  },
  {
    name: 'list_bank_transactions',
    description: 'List staged bank transactions and their status (drafted / reconciled / ignored).',
    scope: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'bank_reconciliation',
    description: 'Bank reconciliation summary: ledger cash vs the bank feed, with the difference and unmatched count.',
    scope: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'run_waterfall',
    description: 'Compute a European carried-interest waterfall for a distribution (pure calc; does not post).',
    scope: 'read',
    // Carry. Pure calc or not, the answer IS the GP's economics.
    accessDomain: 'gp_economics',
    inputSchema: {
      type: 'object',
      required: ['distributable', 'terms', 'state'],
      properties: {
        distributable: { type: 'number' },
        terms: { type: 'object', properties: { carryRate: { type: 'number' }, catchUpRate: { type: 'number' } } },
        state: {
          type: 'object',
          properties: {
            contributedCapital: { type: 'number' },
            returnedCapital: { type: 'number' },
            preferredPaid: { type: 'number' },
            preferredTarget: { type: 'number' },
            gpCarryPaid: { type: 'number' },
          },
        },
      },
    },
  },
]
