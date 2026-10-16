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
  /**
   * A write that is ALWAYS staged as this pending action (lib/pending-actions/registry.ts), from
   * any credential, a script's key included, and approved by a person. Its handler never runs.
   * For what goes out to LPs (publish_call_notices): an admin approves it in the app or from their
   * own chat, never a script's key.
   */
  stagesAs?: string
  /**
   * Deletes, merges or undoes posted books. Offered only when the deployment sets
   * AGENT_DESTRUCTIVE_ACTIONS=true, and then ALWAYS staged for an admin's approval, from any
   * credential (lib/agent/destructive.ts). Every such tool is also in ADMIN_ONLY_TOOLS.
   */
  destructive?: true
  /**
   * A write that changes no record, so it runs directly even from a chat that stages writes:
   * minting a signed upload URL (the file is only taken in by the register tool, which stages), or
   * a preview the assistant applies with tools that stage. Still gated at write, like its route.
   * Staging it would only lose its result: the URL or preview would reach the approver, not the chat.
   */
  runsDirectly?: true
  inputSchema: Record<string, any>
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }

const JOURNAL_SOURCE_SCHEMA = { type: 'string', enum: ['quickbooks', 'carta'], description: 'Whose books these are (default quickbooks). Each source has its own account mapping.' }

/** One outside-ledger transaction (QuickBooks, Carta): a date and its balanced split lines (debit/credit as positive magnitudes). */
const QB_TRANSACTIONS_SCHEMA = {
  type: 'array',
  description: 'Journal transactions, each with balanced lines. Debits and credits are positive magnitudes, as QuickBooks prints them.',
  items: {
    type: 'object',
    required: ['date', 'lines'],
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      type: { type: 'string', description: 'Transaction type, e.g. "Journal Entry", "Bill" (QuickBooks) or "CAPITAL_CALL" (Carta event type)' },
      num: { type: 'string', description: 'The source document number or id — it is part of the idempotency key, so keep it stable across syncs' },
      memo: { type: 'string' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['account'],
          properties: {
            account: { type: 'string', description: 'Fully qualified source account name — the key the mapping is saved under' },
            name: { type: 'string', description: 'Payee, vendor or partner on the line (an LP name routes capital lines to that partner)' },
            memo: { type: 'string' },
            debit: { type: 'number' },
            credit: { type: 'number' },
          },
        },
      },
    },
  },
}
const ALLOCATION_ACTIONS = ['management_fee', 'expense', 'gain', 'distribution', 'carry', 'close_period']

export const AGENT_TOOL_MANIFEST: AgentToolMeta[] = [
  { name: 'list_accounts', description: "List the fund's chart of accounts (code, name, type).", scope: 'read', inputSchema: EMPTY_SCHEMA },
  // LP identities + commitments — the lp_capital tier, not plain bookkeeping.
  { name: 'list_entities', description: 'List LP entities with committed capital.', scope: 'read', accessDomain: 'lp_capital', inputSchema: EMPTY_SCHEMA },
  { name: 'capital_accounts', description: 'Per-LP capital-account roll-forward (beginning, contributions, distributions, fees, gains, ending) plus fund NAV.', scope: 'read', accessDomain: 'lp_capital', inputSchema: EMPTY_SCHEMA },
  { name: 'financial_statements', description: 'Trial balance, balance sheet, and income statement derived from posted entries. For a management company, also each member\'s capital roll-forward since inception (changesInMembersCapital).', scope: 'read', inputSchema: EMPTY_SCHEMA },
  {
    name: 'list_journal',
    description: 'List journal entries with their postings, newest first, one page at a time. Returns { rows, total, hasMore, nextCursor }: when hasMore is true the list is INCOMPLETE — call again with cursor = nextCursor before drawing any conclusion from the whole journal.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Entries per page (default 100, max 500)' },
        cursor: { type: 'string', description: 'nextCursor from the previous page' },
        start: { type: 'string', description: 'ISO date; only entries on or after it' },
        end: { type: 'string', description: 'ISO date; only entries on or before it' },
      },
    },
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
    name: 'add_account',
    description: "Add one account to the vehicle's chart of accounts (code, name, type). Refuses a code the vehicle already has.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['code', 'name', 'type'],
      properties: {
        code: { type: 'string', description: '1-20 characters: letters, digits, dot, dash or underscore' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
        subtype: { type: 'string', description: 'optional subtype, e.g. interest_income' },
      },
    },
  },
  {
    name: 'add_partner',
    description: "Add a partner (LP, GP or GP-entity member) to the vehicle with a commitment, and open their capital account. Reuses an existing investor/entity with the exact same name, and sets that entity's partner class.",
    scope: 'write',
    // Creates partners and commitments — LP capital, not just accounting.
    accessDomain: 'lp_capital',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'entity name; an exact match reuses the existing entity' },
        partnerClass: { type: 'string', enum: ['lp', 'gp'], description: 'default lp' },
        commitment: { type: 'number', description: 'commitment to this vehicle (default 0)' },
      },
    },
  },
  {
    name: 'allocation',
    description: 'Compute and post a period allocation or period close: management_fee, expense, gain, distribution, carry, or close_period. ' +
      'Idempotent: an identical entry (same action, date and lines) already in the books is refused, naming it; a preview says so as alreadyBooked.',
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
    name: 'preview_close',
    description: 'Preview closing a vehicle THROUGH a date without changing anything: the months the close would cover (it starts the day after the last closed period, so there are no gaps), what each month would allocate to each partner, and anything blocking it, such as drafts still sitting inside the window. Run this before close_period.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      required: ['periodEnd'],
      properties: {
        periodEnd: { type: 'string', description: 'ISO date to close through (YYYY-MM-DD), usually a month-end' },
      },
    },
  },
  {
    name: 'close_period',
    description: 'Close the books THROUGH a date: every open month from the day after the last closed period up to periodEnd is closed in order, allocating its P&L to the partners and locking it against new postings. Stops at the first month that fails and leaves the earlier ones closed; calling again picks up from there. Run preview_close (or close_status) first. periodStart is ignored: a close cannot leave gaps.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['periodEnd'],
      properties: {
        periodEnd: { type: 'string', description: 'YYYY-MM-DD to close through.' },
        periodStart: { type: 'string', description: 'Ignored: closing runs through periodEnd from the first open period. Accepted for older callers.' },
        label: { type: 'string', description: 'Ignored. Accepted for older callers.' },
      },
    },
  },
  {
    name: 'reopen_period',
    description:
      'Reopen closed fiscal period(s) so entries can be posted or changed in them: the period named (or every closed period covering ' +
      'or after from_date) and every closed period after it, newest first, voiding each one\'s close allocation entries. Close again ' +
      'afterwards to re-allocate. A reason is required and goes on the audit trail. Refused inside a closed tax year. The voided ' +
      'allocation entries stay void (closing again books new ones), and K-1s already issued for those years are named in the result ' +
      'but not withdrawn. Find periods with list_periods. Admin only: from chat it is staged for an admin to approve; show the ' +
      'person the staged preview, which lists the periods it would reopen.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        period_id: { type: 'string', description: 'A closed period id from list_periods. Or pass from_date.' },
        from_date: { type: 'string', description: 'YYYY-MM-DD: reopen every closed period covering or after this date.' },
        reason: { type: 'string', description: 'Why, in a sentence. Recorded in the audit trail.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export_ledger_text',
    description: "Export the vehicle's ledger (every non-void entry, oldest first) as plain-text double-entry. Returns { text, entries, total, truncated }: a large ledger comes in pages — when truncated is true, call again with the returned cursor (and the same start/end) until it is false; the text alone is NOT the whole ledger.",
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO date; only entries on or after it' },
        end: { type: 'string', description: 'ISO date; only entries on or before it' },
        asOf: { type: 'string', description: 'ISO date; same as end (a snapshot as of that date)' },
        cursor: { type: 'string', description: 'cursor from the previous page' },
      },
    },
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
  // Importing an outside general ledger (QuickBooks, Carta fund admin) — what a connector calls
  // after reading the source's API or MCP server, instead of a person pasting a Journal export.
  // Same three steps and same code path as the Accounting → QuickBooks page
  // (lib/accounting/quickbooks/import-journal.ts): accounts → mapping → import as drafts. Each
  // source keeps its own mapping and tags its entries with its own source_type (sources.ts).
  {
    name: 'journal_import_accounts',
    description: "Step 1 of importing an outside general ledger (QuickBooks or Carta): list the source's accounts a batch of journal transactions touches, with the saved mapping for each and a proposed chart code where none is saved. Writes nothing. Pass `transactions` (structured) or `text` (a QuickBooks Journal report export).",
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        transactions: QB_TRANSACTIONS_SCHEMA,
        text: { type: 'string', description: 'A QuickBooks Journal report export (CSV/TSV), instead of transactions' },
        source: JOURNAL_SOURCE_SCHEMA,
      },
    },
  },
  {
    name: 'save_journal_mapping',
    description: "Step 2: save confirmed source account → chart code mappings for this vehicle and source. A saved mapping always wins over a later proposal. Confirm proposals with the user before saving them; a wrong mapping misstates the account for every period imported.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['rows'],
      properties: {
        source: JOURNAL_SOURCE_SCHEMA,
        rows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['qbAccount'],
            properties: {
              qbAccount: { type: 'string', description: 'The source account name, exactly as in the transactions (e.g. "Investments:Acme Ventures III")' },
              accountCode: { type: 'string', description: 'Chart code on this vehicle' },
              excluded: { type: 'boolean', description: 'Deliberately not imported; transactions touching it are skipped whole' },
              note: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'import_journal',
    description: 'Step 3: import outside journal transactions (QuickBooks or Carta) as DRAFT journal entries for review (nothing posts). Idempotent: a transaction already imported is matched, not duplicated, so overlapping date windows are safe to resend; the `duplicates` in the result says which entry each matched transaction matched and why, and `recovered` lists transactions an earlier import wrongly skipped as duplicates (same date and amount, different payee). Transactions touching an unmapped account are skipped and named. Pass `transactions` (structured) or `text` (a QuickBooks Journal report export).',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        transactions: QB_TRANSACTIONS_SCHEMA,
        text: { type: 'string', description: 'A QuickBooks Journal report export (CSV/TSV), instead of transactions' },
        dryRun: { type: 'boolean', description: 'Report what would be created without writing (default false)' },
        reviewToken: { type: 'string', description: 'Token returned by the import comparison. Supply only after presenting the differences and the user authorizes proceeding.' },
        sourceLabel: { type: 'string', description: 'Shown in the import history, e.g. "quickbooks-connector 2026-10-01..2026-10-31"' },
        source: JOURNAL_SOURCE_SCHEMA,
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
    name: 'set_bank_transaction_account',
    description: "Re-point one drafted bank transaction's draft entry to a chart account by code (the bank page's account picker). A per-partner capital account (3100-<partner>) carries that partner onto the posting. A draft split across several accounts (e.g. a distribution spread over every partner) is refused unless replaceSplit is true, which replaces the split with one posting to this account.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['bankTransactionId', 'accountCode'],
      properties: {
        bankTransactionId: { type: 'string' },
        accountCode: { type: 'string' },
        replaceSplit: { type: 'boolean', description: 'replace a multi-account split on the draft with one posting to accountCode (drafts only)' },
      },
    },
  },
  {
    name: 'ignore_bank_transaction',
    description: "Set aside a bank row that is not a cash movement of the vehicle, such as a money-market sweep or reinvestment, or a duplicate (the bank page's Ignore). Its draft entry is voided. Refuses a posted row: voiding a posted entry needs a reason and is done on the bank page.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['bankTransactionId'],
      properties: { bankTransactionId: { type: 'string' } },
    },
  },
  {
    name: 'post_bank_transaction',
    description: "Post one drafted bank transaction's entry and mark the row reconciled (the bank page's Post). Refuses a voided entry or one dated in a closed period.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['bankTransactionId'],
      properties: { bankTransactionId: { type: 'string' } },
    },
  },
  {
    name: 'post_drafts',
    description: "Post DRAFT journal entries in bulk (the journal's Post all): each is balance-checked, adopted into investment transactions where it touches an investment, and refused in a closed period. Pages: repeat with afterId = the returned cursor while hasMore. allocate: false posts WITHOUT partner allocations — only for a migration whose source books never split income by partner.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'post exactly these drafts (one shot)' },
        start: { type: 'string', description: 'ISO date; only drafts on or after it' },
        end: { type: 'string', description: 'ISO date; only drafts on or before it' },
        sourceType: { type: 'string', description: "only drafts with this source_type, e.g. 'quickbooks'" },
        afterId: { type: 'string', description: 'cursor from the previous call' },
        allocate: { type: 'boolean', description: 'default true; false skips the partner allocation' },
      },
    },
  },
  {
    name: 'discard_drafts',
    description: "Void DRAFT journal entries in bulk (the journal's Discard): drafts the user does not want, such as a duplicate import or a wrong categorization. Drafts only: a posted entry is never touched, and an entry in a closed period is skipped with its reason. Give ids for exactly those drafts, or a window (start/end, sourceType) for every draft in it; pages: repeat with afterId = the returned cursor while hasMore.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'discard exactly these drafts (one shot)' },
        start: { type: 'string', description: 'ISO date; only drafts on or after it' },
        end: { type: 'string', description: 'ISO date; only drafts on or before it' },
        sourceType: { type: 'string', description: "only drafts with this source_type, e.g. 'quickbooks'" },
        afterId: { type: 'string', description: 'cursor from the previous call' },
      },
    },
  },
  {
    name: 'list_bank_transactions',
    description: 'List staged bank transactions and their status (unmatched / drafted / reconciled / ignored), newest first, one page at a time. Returns { rows, total, hasMore, nextCursor }: when hasMore is true the list is INCOMPLETE — call again with cursor = nextCursor.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Transactions per page (default 500, max 1000)' },
        cursor: { type: 'string', description: 'nextCursor from the previous page' },
        status: { type: 'string', enum: ['unmatched', 'drafted', 'reconciled', 'ignored'], description: 'only this status' },
        start: { type: 'string', description: 'ISO date; only transactions on or after it' },
        end: { type: 'string', description: 'ISO date; only transactions on or before it' },
      },
    },
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
  // An entity's governing documents (LPA, operating agreement, side letters). Same files and
  // indexing as the entity's Documents page; see lib/entity-documents/agent.ts.
  {
    name: 'list_entity_documents',
    description: "List the entity's governing documents (LPA, operating agreement, side letters, amendments) with kind, title, effective date and text-extraction status.",
    scope: 'read',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'entity_document_upload_url',
    description: 'Start uploading a governing document of any size up to 25 MB: returns a signed URL to PUT the file bytes to, and the storagePath to pass to add_entity_document afterwards. ' +
      'Never ask the person to paste or attach the file in chat: ask them for its path in a folder, PUT it from there ' +
      '(curl -X PUT -H "Content-Type: <type>" --data-binary @"<path>" "<signedUrl>"), then call add_entity_document. The URL expires in 2 hours.',
    scope: 'write',
    runsDirectly: true,
    inputSchema: {
      type: 'object',
      required: ['fileName'],
      properties: {
        fileName: { type: 'string', description: 'e.g. "3SE Holdings LP - LPA.pdf"' },
        sizeBytes: { type: 'number', description: 'file size, checked against the 25 MB limit' },
      },
    },
  },
  {
    name: 'add_entity_document',
    description: "Store a governing document on the entity's Documents page and index its text so it can be searched and quoted. Pass storagePath from entity_document_upload_url, or contentBase64 for a file under 3 MB.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['fileName'],
      properties: {
        fileName: { type: 'string' },
        storagePath: { type: 'string', description: 'from entity_document_upload_url, after the file was PUT there' },
        contentBase64: { type: 'string', description: 'the file itself, base64; under 3 MB only' },
        contentType: { type: 'string', description: 'e.g. application/pdf' },
        kind: { type: 'string', enum: ['lpa', 'operating_agreement', 'side_letter', 'amendment', 'other'], description: 'default other' },
        title: { type: 'string', description: 'default the file name' },
        effectiveDate: { type: 'string', description: 'ISO date YYYY-MM-DD the document is dated or effective' },
      },
    },
  },
]
