// Pure metadata for the ADMIN-REPORTED VEHICLE tools: vehicles whose fund administrator keeps the
// books, and whose LP figures the app shows as the administrator states them. NO server imports.
// Handlers live in admin-reporting-tools.ts; the mechanics in lib/admin-reporting.
//
// All of them act on ONE vehicle, so they bind as ledger tools: the dispatcher resolves the vehicle
// with the caller's access and injects it.
//
//   admin_pulls                → the vehicle's record source and its saved pulls; writes nothing
//   pull_admin_figures         → fetch one date's figures from the administrator and check them; writes nothing
//   stage_admin_figures        → save one date's figures, always staged
//   set_vehicle_record_source  → say who keeps a vehicle's books (the app, or an administrator), always staged

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const AMOUNT = { type: 'number', description: 'As the administrator states it.' }

/** One date's figures, as a pull or a person gives them. Shared by the tool and the staged action. */
export const ADMIN_FIGURES_PROPERTIES = {
  as_of: { type: 'string', description: 'The quarter end the figures are as of, YYYY-MM-DD.' },
  source: { type: 'string', description: 'The administrator the figures come from, as a reader would name it: "Carta", "CSV upload".' },
  positions: {
    type: 'array',
    description: 'One entry per partner. Every partner needs commitment, paid_in, distributions and nav: the card totals are made from them.',
    items: {
      type: 'object',
      required: ['name'],
      properties: {
        external_id: { type: 'string', description: "The administrator's id for the partner. Defaults to the name." },
        name: { type: 'string', description: "The partner's name at the administrator." },
        lp_entity_id: { type: 'string', description: 'The app partner this is, when a name match would be wrong (list_lps gives ids).' },
        commitment: AMOUNT,
        paid_in: AMOUNT,
        distributions: AMOUNT,
        nav: AMOUNT,
        receivable: { type: 'number', description: 'Called but not yet funded, where stated.' },
      },
    },
  },
  fund: {
    type: 'object',
    description: "The fund's net LP-only figures for the date, shown on every partner's row.",
    properties: {
      irr: { type: 'number', description: 'Net LP-only IRR: 6.08 or 0.0608.' },
      tvpi: { type: 'number', description: 'LP-only TVPI.' },
      dpi: { type: 'number', description: 'LP-only DPI.' },
    },
  },
  explanation: { type: 'string', description: 'For the approver: where the figures came from.' },
} as const

export const RECORD_SOURCE_PROPERTIES = {
  record_source: {
    type: 'string', enum: ['books', 'admin'],
    description: "books = the app's own books (the default). admin = the administrator's figures, shown as stated and never recalculated.",
  },
  provider: {
    type: 'string',
    description: "Where an admin vehicle's figures come from: the id of a fund administrator's MCP server (admin_pulls lists them), " +
      'or csv / other for figures given by hand.',
  },
  fund_ref: { type: 'string', description: "The vehicle's id at the administrator (for Carta, the fund UUID). Needed where the app has a built-in pull." },
  explanation: { type: 'string', description: 'Why, for the approver.' },
} as const

export const ADMIN_REPORTING_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'admin_pulls',
    description:
      "Whether a vehicle keeps its own books or reports its fund administrator's figures, which administrator, the " +
      "administrators' MCP servers this deployment lists (any of them can be a vehicle's source), and the pulls saved " +
      'for it (date, source, partners, the fund\'s net IRR, TVPI and DPI). Writes nothing.',
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pull_admin_figures',
    description:
      "Fetch one date's figures for an admin-reported vehicle from its fund administrator's MCP server, with the caller's " +
      "own connection there: each partner's commitment, paid-in, distributions and NAV, and the fund's net LP-only IRR, TVPI " +
      'and DPI. Checks only that the pull is complete and that every partner is matched; never recalculates a figure. ' +
      'Writes nothing: pass the result to stage_admin_figures to save it. Where the app has no built-in pull for that ' +
      "administrator it says so: read the figures with that administrator's own MCP tools in this chat, then stage them.",
    scope: 'read',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    inputSchema: {
      type: 'object', required: ['as_of'], additionalProperties: false,
      properties: { as_of: { type: 'string', description: 'A quarter end, YYYY-MM-DD.' } },
    },
  },
  {
    name: 'stage_admin_figures',
    description:
      "Ask for one date's administrator figures to be saved for an admin-reported vehicle, replacing any saved for that " +
      "date. The LP report cards then show them as stated: each partner's figures, and the fund's net IRR, TVPI and DPI " +
      'on every row. Refused while a partner is unmatched or a figure is missing. Always staged: a person with LP capital ' +
      'write approves it.',
    scope: 'write',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    stagesAs: 'apply_admin_figures',
    inputSchema: { type: 'object', required: ['as_of', 'source', 'positions'], additionalProperties: false, properties: { ...ADMIN_FIGURES_PROPERTIES } },
  },
  {
    name: 'set_vehicle_record_source',
    description:
      "Ask for a vehicle to report its fund administrator's figures instead of the app's own books, or back. An admin " +
      'vehicle\'s LP cards show only what the administrator states. Always staged.',
    scope: 'write',
    accessDomain: 'lp_capital',
    accessFeature: 'lp_tracking',
    stagesAs: 'set_vehicle_record_source',
    inputSchema: { type: 'object', required: ['record_source'], additionalProperties: false, properties: { ...RECORD_SOURCE_PROPERTIES } },
  },
]
