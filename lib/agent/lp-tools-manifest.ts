// Pure metadata for the LP REPORTING agent tools. NO server imports (the Settings key UI
// lists these). Handlers live in lp-tools.ts.
//
// THE THING TO UNDERSTAND BEFORE READING THESE: the fund has TWO producers of LP figures,
// with identical row shapes and different meanings.
//
//   • A SNAPSHOT (`lp_snapshots` + `lp_investments`) is a frozen, hand-imported
//     spreadsheet: what the administrator reported as of a date. Immutable by convention.
//   • The LIVE report is derived from the books on demand, as of any date, and is never
//     written down.
//
// They can disagree, and when they do that disagreement is itself the interesting fact —
// it is a reconciliation break. So no tool here quietly picks one for you: `lp_snapshot`
// reads the stored figures, `lp_live_report` derives them, and `lp_reconcile_snapshot`
// diffs the two. A single `get_lp_numbers` tool would have to choose, and would be wrong
// half the time without saying so.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const VEHICLE = { type: 'string', description: 'The vehicle (portfolio_group) — e.g. the fund or an SPV. Use list_vehicles to see them.' }
const LP = { type: 'string', description: 'LP entity id, or the investor/entity name (matched case-insensitively).' }

export const LP_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'lp_list_snapshots',
    description: 'List the stored LP snapshots — each is a frozen set of LP figures as of a date, as reported by the administrator.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lp_snapshot',
    description:
      'Pull the LP figures held in a stored snapshot: per investor and vehicle — commitment, called, paid-in, distributions, NAV, ' +
      'DPI, RVPI, TVPI, IRR. These are the STORED numbers as imported. For what the books say right now, use lp_live_report.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'string', description: 'Snapshot id or name. Omit for the most recent snapshot.' },
        lp: { type: 'string', description: 'Optional: only this investor or entity.' },
        vehicle: { type: 'string', description: 'Optional: only this vehicle.' },
      },
    },
  },
  {
    name: 'lp_live_report',
    description:
      'LP positions derived LIVE from the ledger as of a date (default today): commitment, called, paid-in, distributions, NAV, ' +
      'DPI, RVPI, TVPI, IRR per investor and vehicle. This is computed from the books, not from a stored snapshot, so it reflects ' +
      'everything posted to date. Associate/GP vehicles are exploded into their members.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        as_of: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Defaults to today.' },
        lp: { type: 'string', description: 'Optional: only this investor or entity.' },
        vehicle: { type: 'string', description: 'Optional: only this vehicle.' },
      },
    },
  },
  {
    name: 'lp_reconcile_snapshot',
    description:
      'Diff a stored snapshot against what the ledger says live, as of the snapshot date. Surfaces every LP whose figures differ, ' +
      'plus rows present in one and not the other. This is the tool for "do our books agree with what the administrator reported".',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: { snapshot: { type: 'string', description: 'Snapshot id or name. Omit for the most recent.' } },
    },
  },
  {
    name: 'lp_capital_summary',
    description:
      "Per-LP capital position in one vehicle straight from the books: commitment, called, funded, outstanding (uncalled), " +
      'unfunded receivable, and capital-account ending balance.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'] },
  },
  {
    name: 'lp_statement',
    description:
      'One LP\'s capital-account statement in a vehicle: the roll-forward (beginning, contributions, distributions, fees, expenses, ' +
      'gains, carry, ending) both inception-to-date and for the period, plus every transaction with a running balance.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: LP,
        start: { type: 'string', description: 'Optional period start (YYYY-MM-DD). Omit for since-inception.' },
        end: { type: 'string', description: 'Optional period end (YYYY-MM-DD).' },
      },
      required: ['vehicle', 'lp'],
    },
  },
  {
    name: 'lp_statement_pdf',
    description:
      'A download link to one LP\'s capital account statement as a PDF — the same document the app produces: ' +
      'the roll-forward for the period and since inception, ownership, and the contributions and distributions. ' +
      'Use when the user asks for the statement as a file, to send, or to download. The link works for an hour; ' +
      'give it to the user as a link. A statement is per LP entity and per vehicle.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        lp: LP,
        period: { type: 'string', enum: ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd'], description: 'The statement period. Default last_quarter. Or pass start and end.' },
        start: { type: 'string', description: 'Custom period start (YYYY-MM-DD).' },
        end: { type: 'string', description: 'Custom period end (YYYY-MM-DD).' },
      },
      required: ['vehicle', 'lp'],
    },
  },
  {
    name: 'lp_report_card_pdf',
    description:
      'A download link to an investor\'s LP report card as a PDF: their positions across every vehicle aggregated — ' +
      'commitment, paid-in, distributions, NAV, DPI, TVPI and IRR per vehicle and in total — on current figures. ' +
      'Use when the user asks for an investor\'s report, report card or summary as a file. The link works for an hour; ' +
      'give it to the user as a link.',
    scope: 'read',
    domain: 'lp',
    inputSchema: {
      type: 'object',
      properties: { investor: { type: 'string', description: 'The investor (or one of their entities), by name or id.' } },
      required: ['investor'],
    },
  },
  {
    name: 'lp_capital_calls',
    description: 'The capital calls issued in a vehicle: date, description, total, and each LP\'s share.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'] },
  },
  {
    name: 'lp_list_investors',
    description:
      'The fund\'s LPs. An investor (a person, family or institution) may hold through several legal entities; the positions are ' +
      'keyed on the entities, and this returns both levels so you can roll up correctly.',
    scope: 'read',
    domain: 'lp',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]
