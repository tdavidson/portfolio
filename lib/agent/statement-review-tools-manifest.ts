// Pure metadata for the STATEMENT REVIEW tools (docs/spec/statement-review.md). NO server imports.
// Handlers live in statement-review-tools.ts; the mechanics in lib/statement-review.
//
// Both act on ONE vehicle, so they bind as ledger tools: the dispatcher resolves the vehicle with the
// caller's access and injects it. Both are read level in the lp_capital domain, like the app's
// review route: a review reports on figures and changes none of them.
//
//   statement_review_extract        → the vehicle's documents' text, the package shape and the rules, for
//                                     an assistant to read a package from (and the fund's model's reading, with a key)
//   statement_review_run            → run the tie-out checks on a package and save the review
//   statement_review_findings       → the vehicle's reviews, or one review's checks and findings
//   statement_review_settings       → the vehicle's materiality, instructions, watched accounts, known adjustments
//   statement_review_settings_save  → change them (lp_capital write, applied directly: configuration, not figures)
//
// The write tools in the spec (statement_review_note, statement_review_sign_off) arrive with the
// findings workflow (stage 5).

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { CHECK_IDS } from '@/lib/statement-review/types'

const AMOUNT = { type: 'number', description: 'As the statement states it.' }
const CITE = {
  type: 'object',
  description: 'Field name (ending, allocations.income, …) → where the package states it: { document, page?, label? }.',
}
const CAPITAL = {
  commitment: AMOUNT,
  beginning: { type: 'number', description: 'Capital at the start of the period.' },
  contributions: { type: 'number', description: 'Contributed during the period.' },
  distributions: { type: 'number', description: 'Distributed during the period, as a positive amount.' },
  allocations: {
    type: 'object',
    description: 'Allocated during the period, each signed as it changes the account: expenses, fees and carry charged to an LP are negative.',
    properties: {
      income: AMOUNT, expenses: AMOUNT, management_fee: AMOUNT, realized: AMOUNT, unrealized: AMOUNT, carry: AMOUNT,
      total: { type: 'number', description: 'The net allocation, where the statement states one.' },
    },
  },
  ending: { type: 'number', description: 'Capital at the period end (the NAV).' },
  unfunded: AMOUNT,
  paid_in_to_date: { type: 'number', description: 'Contributed since inception, through the period end.' },
  distributed_to_date: { type: 'number', description: 'Distributed since inception, through the period end.' },
  cite: CITE,
} as const

export const STATEMENT_PACKAGE_SCHEMA = {
  type: 'object',
  description:
    "One vehicle's statements for one period, as the package states them. Every part is optional; a check runs when its inputs " +
    'are there and says so when they are not. Give figures exactly as stated: never fill one in from another.',
  properties: {
    period_end: { type: 'string', description: 'YYYY-MM-DD.' },
    period_start: { type: 'string', description: 'YYYY-MM-DD. Defaults to the start of the quarter.' },
    documents: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hash: { type: 'string', description: 'SHA-256, hex.' }, kind: { type: 'string' }, pages: { type: 'number' } } } },
    partners: {
      type: 'array',
      description: 'One entry per capital account.',
      items: {
        type: 'object', required: ['name'],
        properties: {
          external_id: { type: 'string', description: "The package's id for the partner. Defaults to the name." },
          name: { type: 'string' },
          lp_entity_id: { type: 'string', description: 'The app partner this is, when a name match would be wrong (list_lps gives ids).' },
          ...CAPITAL,
        },
      },
    },
    fund: {
      type: 'object',
      properties: {
        balance_sheet: {
          type: 'object',
          properties: {
            assets: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: AMOUNT } } },
            liabilities: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: AMOUNT } } },
            total_assets: AMOUNT, total_liabilities: AMOUNT, partners_capital: AMOUNT, total_liabilities_and_capital: AMOUNT, cite: CITE,
          },
        },
        operations: {
          type: 'object',
          properties: {
            lines: { type: 'array', description: 'Signed as each adds to net income: expenses negative.', items: { type: 'object', properties: { label: { type: 'string' }, amount: AMOUNT } } },
            net_income: AMOUNT, cite: CITE,
          },
        },
        partners_capital: { type: 'object', description: "The fund's statement of changes in partners' capital (the total across partners).", properties: { ...CAPITAL } },
        partner_totals: { type: 'object', description: 'The total row printed under the partner schedule.', properties: { ...CAPITAL } },
        soi: { type: 'object', description: "The schedule of investments' stated totals.", properties: { cost: AMOUNT, fair_value: AMOUNT, cite: CITE } },
      },
    },
    holdings: { type: 'array', description: 'The schedule of investments, one line per holding.', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, cost: AMOUNT, fair_value: AMOUNT } } },
    cash: { type: 'array', description: 'Ending cash by account, as stated.', items: { type: 'object', required: ['account', 'balance'], properties: { account: { type: 'string' }, balance: AMOUNT } } },
  },
} as const

const SETTINGS_PROPERTIES = {
  materiality: {
    type: 'object',
    description: 'Differences above the larger of these are errors; smaller ones are information.',
    properties: {
      amount: { type: 'number', description: "An amount in the vehicle's currency." },
      nav_share: { type: 'number', description: 'A share of fund NAV: 0.001 for 0.1%.' },
    },
  },
  instructions: {
    type: 'string',
    description: "The reviewer's own instructions for this vehicle's reviews, in their words: what to pay attention to, how the " +
      'administrator presents things, what to ask about. Up to 8,000 characters.',
  },
  watch_accounts: {
    type: 'array',
    description: 'Accounts to report every period with their balance and movement. Replaces the whole list.',
    items: {
      type: 'object', required: ['account'],
      properties: {
        account: { type: 'string', description: 'An account code (4100) or name.' },
        note: { type: 'string', description: 'What to look for.' },
        threshold: { type: 'number', description: 'Warn when the account moves by more than this in the period.' },
      },
    },
  },
  adjustments: {
    type: 'array',
    description: 'Differences the reviewer already knows about. A finding one matches is marked explained, with its description, ' +
      'and shown as information. Each needs a subject or an amount. Replaces the whole list.',
    items: {
      type: 'object', required: ['description'],
      properties: {
        description: { type: 'string', description: 'Why the difference is expected.' },
        check: { type: 'string', enum: CHECK_IDS },
        subject: { type: 'string', description: 'Part of the partner, holding, account or statement name it applies to.' },
        amount: { type: 'number', description: 'The difference it accounts for.' },
        tolerance: { type: 'number', description: 'How far from amount the difference may be. Default a cent.' },
      },
    },
  },
} as const

export const STATEMENT_REVIEW_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'statement_review_run',
    description:
      "Check a vehicle's quarterly statements: whether they foot, whether the partners add up to the fund, whether each capital " +
      "account rolls forward, whether this period carries on from the last review, whether every partner the app knows is " +
      "there and nobody unknown is, whether contributions, distributions, cash and the schedule of investments agree with the " +
      "app's books, bank feed and portfolio, whether the management fee, carried interest and income, expense and gain " +
      "allocations follow the vehicle's terms, and how the reviewer's watched accounts moved. Known adjustments in the review " +
      'settings mark the findings they explain. Read statement_review_settings first and follow its instructions when you read ' +
      'a package. The figures come from a saved administrator pull (input admin_pull), a partner capital ' +
      "schedule as CSV text (input csv), or a package read from the administrator's documents (input package): give the " +
      'document_ids with the package you read (statement_review_extract hands you their text), and each cited figure is ' +
      "checked against the document; give document_ids alone and the fund's model reads them, when the fund has a server AI " +
      'key. Saves the review and returns its checks and findings, worst first; each finding cites where the figure is ' +
      'stated. Never changes the figures it reviews.',
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: {
      type: 'object', required: ['input'], additionalProperties: false,
      properties: {
        input: { type: 'string', enum: ['admin_pull', 'csv', 'package'], description: 'Where the figures come from.' },
        period_end: { type: 'string', description: 'The quarter end, YYYY-MM-DD. For admin_pull, the date the pull was saved for.' },
        period_start: { type: 'string', description: 'YYYY-MM-DD. Defaults to the start of the quarter.' },
        pull_id: { type: 'string', description: 'admin_pull: a saved pull (admin_pulls lists them). Otherwise the one saved for period_end.' },
        csv: {
          type: 'string',
          description: 'csv: the partner schedule, one row per partner. Columns such as Name, Partner ID, Commitment, Beginning capital, ' +
            'Contributions, Distributions, Income, Expenses, Management fee, Realized gain, Unrealized gain, Carried interest, ' +
            'Net allocation, Ending capital, Unfunded, Paid-in to date, Distributions to date. A Total row is read as the stated totals.',
        },
        file_name: { type: 'string', description: 'csv: the file name, for citations.' },
        fund: { type: 'object', description: "csv: the fund's own statements, in the package's fund shape, to check the schedule against." },
        cash: { type: 'array', description: "csv: ending cash by account, in the package's cash shape.", items: { type: 'object' } },
        holdings: { type: 'array', description: "csv: the schedule of investments, in the package's holdings shape.", items: { type: 'object' } },
        package: STATEMENT_PACKAGE_SCHEMA,
        document_ids: {
          type: 'array', items: { type: 'string' },
          description: "package: the vehicle's documents the package was read from (list_entity_documents). Cited figures are checked against their text. Alone, the fund's model reads them.",
        },
        materiality: {
          type: 'object',
          description: "Differences above the larger of these are errors; smaller ones are information. Defaults to the vehicle's review settings.",
          properties: {
            amount: { type: 'number', description: "An amount in the vehicle's currency." },
            nav_share: { type: 'number', description: 'A share of fund NAV: 0.001 for 0.1%.' },
          },
        },
      },
    },
  },
  {
    name: 'statement_review_extract',
    description:
      "Read a vehicle's quarterly statement package out of its documents: the administrator's PDFs or spreadsheets uploaded to " +
      'the vehicle (list_entity_documents lists them; add_entity_document uploads one). Returns each document\'s text with ' +
      '[Page N] markers, the package shape to fill, and the rules for reading it; with the fund\'s server AI key, also the ' +
      "fund's model's reading. Read the text yourself (or check the model's reading), then call statement_review_run with " +
      'input package, the package and the same document_ids. Writes nothing.',
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: {
      type: 'object', required: ['document_ids'], additionalProperties: false,
      properties: {
        document_ids: { type: 'array', items: { type: 'string' }, description: "The vehicle's documents that make up the package (list_entity_documents)." },
        period_end: { type: 'string', description: 'The quarter end, YYYY-MM-DD, when the documents cover more than one.' },
        offset: { type: 'number', description: 'Where to continue when a long package came back in parts: the next_offset of the last call.' },
        use_server_model: { type: 'boolean', description: "Also have the fund's model read it, when the fund has a key. Default true." },
      },
    },
  },
  {
    name: 'statement_review_findings',
    description:
      "A vehicle's statement reviews. With no period or id, every run, newest period first, with counts of errors, warnings and " +
      "information. With period_end or review_id, that review's checks (which ran, which couldn't and why) and its findings, " +
      'each with the stated and expected figure, the difference and where it is stated. Writes nothing.',
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        period_end: { type: 'string', description: "YYYY-MM-DD: that period's current review." },
        review_id: { type: 'string', description: 'One run, current or earlier.' },
        severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Only findings of this severity.' },
      },
    },
  },
  {
    name: 'statement_review_settings',
    description:
      "A vehicle's statement review settings: materiality, the reviewer's own instructions (what to pay attention to and how " +
      'the administrator presents things), the accounts to watch every period, and the adjustments they already know about. ' +
      'Read these before reading a package for statement_review_run, and follow the instructions. Writes nothing.',
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'statement_review_settings_save',
    description:
      "Change a vehicle's statement review settings. A field left out keeps its value; a list given replaces the whole list, so " +
      'read statement_review_settings first and send the list with your change. Use it when the person asks to watch an ' +
      'account, to remember a recurring adjustment, or to change the instructions or materiality. Applies on the next run.',
    scope: 'write',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...SETTINGS_PROPERTIES } },
  },
]
