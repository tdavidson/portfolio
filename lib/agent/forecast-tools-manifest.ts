import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'
import { CREATE_PLAN_SCHEMA, PUBLISH_PLAN_SCHEMA, UPDATE_PLAN_SCHEMA } from '@/lib/forecast/actions'

// Budget & forecast, read side. Same service as the page and the API (lib/forecast/service.ts),
// so a number quoted by the Analyst is the number on the screen. Gated on accounting + the
// `budgeting` switch; a management company also needs its own grant, checked by the service.

const VEHICLE = { type: 'string', description: 'Vehicle name — a fund, SPV or management company.' }

export const FORECAST_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'forecast_list_plans',
    description:
      'List the budgets and rolling forecasts for one vehicle, with their published versions ' +
      '(an "approved" version is the budget baseline) and the month the books are closed through. ' +
      'Call this first to find a plan id.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_series',
    description:
      'Monthly, quarterly or annual P&L (revenue, expenses, net income, by account) and cash ' +
      '(opening, movement, ending) for a date range. view "actual" = posted actuals only; "plan" = ' +
      'the plan alone; "combined" (default with a plan) = actuals through the cutoff, then the plan. ' +
      'Every period carries a status — actual, actual_unclosed, forecast or mixed — and the result ' +
      'gives actualsThrough, closedThrough, version and warnings: always say which periods are ' +
      'projected, which months are unclosed, and which plan/version the projection is. Quarterly and ' +
      'annual cash is the opening of the first month and the ending of the last, never a sum.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        planId: { type: 'string', description: 'Plan id from forecast_list_plans. Omit for actuals only.' },
        versionId: { type: 'string', description: 'A published version, to see it as originally published. Omit for the current draft.' },
        view: { type: 'string', enum: ['actual', 'plan', 'combined'] },
        start: { type: 'string', description: 'First month, YYYY-MM.' },
        end: { type: 'string', description: 'Last month, YYYY-MM (at most 240 months after start).' },
        interval: { type: 'string', enum: ['month', 'quarter', 'year'] },
      },
      required: ['vehicle', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_explain',
    description:
      'Explain one plan: each account\'s rule (method, parameters, cash timing) with the basis it ' +
      'computes from and its warnings, every month override, the actuals cutoff and whether the draft ' +
      'is stale against the books, and its versions. Use it to answer where a forecast number comes ' +
      'from, what is manually overridden, and what rests on unclosed or missing actuals.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, planId: { type: 'string' } },
      required: ['vehicle', 'planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_variance',
    description:
      'Variance of actuals (or another plan) against a plan, by account and period: base, compare, ' +
      'dollar difference, percentage (null when the base is 0) and whether it is favourable — revenue ' +
      'above or expense below the base. Default base is the plan\'s approved version; pass ' +
      'baseVersionId "draft" or a version id to use another. compare "actual" (default) only counts ' +
      'months that have actuals, and periods with fewer marked partial; pass comparePlanId for the ' +
      'latest forecast against a budget. `largest` lists the biggest misses by dollars. Quarterly and ' +
      'annual percentages come from summed dollars, never averaged.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: VEHICLE,
        planId: { type: 'string', description: 'The base plan.' },
        baseVersionId: { type: 'string', description: "'approved' (default), 'draft', or a version id." },
        comparePlanId: { type: 'string', description: 'Compare another plan instead of actuals.' },
        compareVersionId: { type: 'string', description: "'draft' (default) or a version id of the compare plan." },
        start: { type: 'string', description: 'First month, YYYY-MM.' },
        end: { type: 'string', description: 'Last month, YYYY-MM.' },
        interval: { type: 'string', enum: ['month', 'quarter', 'year'] },
      },
      required: ['vehicle', 'planId', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'forecast_create_plan',
    description:
      'Create a budget (a fiscal year, monthly) or a rolling forecast (starts after the last closed month, ' +
      '12/18/24/36-month horizon) for one vehicle, seeded blank, from actuals, or from another plan\'s rules. ' +
      'Never posts to the ledger.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: CREATE_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_update_plan',
    description:
      'Change a plan\'s draft: set or remove account rules, set or clear month overrides, or change its ' +
      'cutoff/horizon/name. Accounts are given by code. The draft recompiles; published versions never ' +
      'change. Pass expectedRevision from forecast_explain to refuse a stale write.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: UPDATE_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_publish',
    description:
      'Freeze a plan\'s draft as an immutable version. status "approved" makes it the budget baseline ' +
      '(one per plan); "published" is a revision or forecast snapshot.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: PUBLISH_PLAN_SCHEMA as any,
  },
  {
    name: 'forecast_fee_links',
    description:
      'List which funds pay which management company and on what billing cycle (fee links), for one ' +
      'vehicle. A linked-fee rule forecasts nothing without one. A fund you cannot see appears with its ' +
      'name withheld.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: { type: 'object', properties: { vehicle: VEHICLE }, required: ['vehicle'], additionalProperties: false },
  },
  {
    name: 'forecast_set_fee_link',
    description:
      'Create or change a fee link: the fund pays the management company its construction fee, billed every ' +
      'everyMonths (1/3/6/12) starting in anchorMonth, in advance or arrears, cash cashLagMonths later. ' +
      'Needs write on both vehicles. vehicle is the management company.',
    scope: 'write',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'fund'],
      additionalProperties: false,
      properties: {
        vehicle: { type: 'string', description: 'The management company.' },
        fund: { type: 'string', description: 'The fund that pays it.' },
        everyMonths: { type: 'number', enum: [1, 3, 6, 12] },
        anchorMonth: { type: 'number' },
        direction: { type: 'string', enum: ['advance', 'arrears'] },
        cashLagMonths: { type: 'number' },
        active: { type: 'boolean' },
      },
    },
  },
  {
    name: 'forecast_suggest_rules',
    description:
      'Suggest a forecasting rule for every income and expense account of a vehicle from its own closed ' +
      'history — at least 12 months, up to 36 — so annual and quarterly bills, seasonal shapes (a December ' +
      'bonus), trends and step changes are recognised rather than averaged away. Each suggestion has its ' +
      'method and parameters, a confidence and the evidence. Linked sources win where they exist (fee ' +
      'links, construction). Creates nothing: pass the suggestions, adjusted for what the user said, to ' +
      'create_forecast_plan.',
    scope: 'read',
    domain: 'portfolio',
    accessDomain: 'accounting',
    accessFeature: 'budgeting',
    inputSchema: {
      type: 'object',
      properties: { vehicle: VEHICLE, lookbackMonths: { type: 'number', description: '12–36, default 36.' } },
      required: ['vehicle'],
      additionalProperties: false,
    },
  },
]
