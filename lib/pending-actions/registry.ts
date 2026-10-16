import { FORECASTING_PRINCIPLES } from '@/lib/forecast/principles'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { ActionType, ActionDeps, PreviewResult } from './types'
import { previewMetricValue, writeMetricValue } from './metric-value'
import { previewRecordInvestment, executeRecordInvestment } from './investment'
import { previewIssueCapitalCall, executeIssueCapitalCall } from './capital-call'
import { previewPublishCallNotices, executePublishCallNoticesElsewhere } from './call-notices'
import {
  previewUpdatePortfolioConstruction,
  executeUpdatePortfolioConstruction,
} from './construction'
import {
  previewUpdateForecast, executeUpdateForecast, previewPublishForecast, executePublishForecast,
  previewCreateForecast, executeCreateForecast,
} from './forecast'
import { CREATE_PLAN_SCHEMA, PUBLISH_PLAN_SCHEMA, UPDATE_PLAN_SCHEMA } from '@/lib/forecast/actions'
import { previewSetEntityLink, executeSetEntityLink } from './entity-link'
import { UPDATE_CONSTRUCTION_SCHEMA } from './construction-schema'

/**
 * One write action the Analyst may DRAFT. Each maps to the access `domain` (+ optional feature)
 * that gates it, a JSON Schema the model fills in, a read-only `preview`, and the real `execute`
 * that runs only on human approval. `domain`/`accessFeature` are the authorization answer;
 * `stageAccess` may require write for especially consequential plans, and approval always does.
 */
export interface WriteAction {
  domain: Domain
  accessFeature?: FeatureKey
  /** Permission required to create the draft; approval always requires write. Defaults to read. */
  stageAccess?: 'read' | 'write'
  /**
   * The entity (`vehicle` input) the action acts on: 'required' (a capital call, construction),
   * 'optional' (an investment — none is a company-wide row), 'none' (a company metric). Staging
   * resolves it ONCE, pins its name into the stored args and records pending_actions.vehicle_id, so
   * the action can never be re-resolved to whoever later views or approves it.
   */
  entity: 'required' | 'optional' | 'none'
  /**
   * The entity may be a management company. Staging then resolves through resolveVehicleWithAccess,
   * which requires the stager's management_company grant for one — never a bare opt-in.
   */
  managementCompanies?: true
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Approved only where a person confirms it: in the app, confirming twice, or from their own chat
   * on their explicit yes. Each of those doors supplies the real executor (the browser's approve
   * route in-process, a chat's approve_action through a Chromium-bundled route); `execute` here
   * refuses, so a door that supplies none — a script's key — cannot approve it
   * (lib/pending-actions/call-notices.ts).
   */
  personConfirms?: true
  preview: (deps: ActionDeps, input: any) => Promise<PreviewResult>
  execute: (deps: ActionDeps, input: any) => Promise<Record<string, unknown>>
}


export const WRITE_ACTIONS: Record<ActionType, WriteAction> = {
  update_company_metric: {
    entity: 'none',
    domain: 'portfolio',
    description: 'Set or update a portfolio company metric value for a specific period.',
    inputSchema: {
      type: 'object',
      required: ['companyId', 'metricId', 'period_label', 'period_year', 'value'],
      properties: {
        companyId: { type: 'string', description: 'The company id.' },
        metricId: { type: 'string', description: 'The metric id.' },
        period_label: { type: 'string', description: 'Human label for the period, e.g. "Q2 2026".' },
        period_year: { type: 'number' },
        period_quarter: { type: 'number', description: 'Quarter 1-4, omit for annual/monthly.' },
        period_month: { type: 'number', description: 'Month 1-12, omit for quarterly/annual.' },
        value: { type: ['number', 'string'], description: 'The metric value (number, or text for text metrics).' },
        notes: { type: 'string' },
      },
    },
    preview: previewMetricValue,
    execute: writeMetricValue,
  },
  record_investment: {
    entity: 'optional',
    domain: 'portfolio',
    accessFeature: 'investments',
    description:
      'Record a portfolio transaction (investment | unrealized_gain_change | proceeds | round_info). ' +
      'Drafts the journal entry it implies for review; set converts_from_txn_id to link a SAFE/note conversion.',
    inputSchema: {
      type: 'object',
      required: ['company', 'transaction_type', 'transaction_date'],
      properties: {
        company: { type: 'string', description: 'Company id or name.' },
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group). Required for the ledger draft.' },
        transaction_type: { type: 'string', enum: ['investment', 'unrealized_gain_change', 'proceeds', 'round_info'] },
        transaction_date: { type: 'string', description: 'YYYY-MM-DD.' },
        round_name: { type: 'string' },
        notes: { type: 'string' },
        investment_cost: { type: 'number' },
        shares_acquired: { type: 'number' },
        share_price: { type: 'number' },
        unrealized_value_change: { type: 'number' },
        current_share_price: { type: 'number' },
        cost_basis_exited: { type: 'number' },
        proceeds_received: { type: 'number', description: 'Exit: GROSS proceeds, escrow included (not the cash received).' },
        proceeds_escrow: { type: 'number', description: 'Exit: the part of proceeds_received held back in escrow.' },
        converts_from_txn_id: { type: 'string', description: 'Prior SAFE/note transaction this priced round converts.' },
      },
    },
    preview: previewRecordInvestment,
    execute: executeRecordInvestment,
  },
  issue_capital_call: {
    entity: 'required',
    domain: 'lp_capital',
    description: 'Issue a fund-wide capital call, split across LPs pro-rata by commitment.',
    inputSchema: {
      type: 'object',
      required: ['callDate', 'total'],
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group).' },
        callDate: { type: 'string', description: 'YYYY-MM-DD.' },
        description: { type: 'string' },
        total: { type: 'number', description: 'Fund-wide amount to split pro-rata by commitment.' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD the capital is due. Never assumed: omit it if the user gave none.' },
        purposes: {
          type: 'array',
          description: 'What the call is for, with amounts that add up to total. Shown on each LP notice.',
          items: {
            type: 'object',
            required: ['category', 'amount'],
            properties: {
              category: { type: 'string', enum: ['investment', 'management_fee', 'fund_expense', 'other'] },
              amount: { type: 'number' },
              description: { type: 'string' },
              basis: { type: 'string', description: 'Management fee: rate, base and period, as the user stated them. Never invented.' },
              date: { type: 'string', description: 'YYYY-MM-DD the money is needed for this purpose, e.g. a closing.' },
            },
          },
        },
        noticePeriodDays: { type: 'number', description: 'The LPA notice period the user stated. The vehicle\'s recorded term is checked as well.' },
        noticePeriodBasis: { type: 'string', enum: ['calendar', 'business'] },
        statedPartners: {
          type: 'array',
          description: 'LP figures the user stated (a commitment, or a % of the fund). Checked against the register and flagged when they differ; never used for the split.',
          items: {
            type: 'object',
            required: ['lp'],
            properties: {
              lp: { type: 'string', description: 'LP entity id or name.' },
              commitment: { type: 'number' },
              sharePct: { type: 'number', description: 'Percent of the fund, 0 to 100.' },
            },
          },
        },
      },
    },
    preview: previewIssueCapitalCall,
    execute: executeIssueCapitalCall,
  },
  publish_call_notices: {
    entity: 'required',
    domain: 'lp_relations',
    accessFeature: 'lp_portal',
    stageAccess: 'write',
    personConfirms: true,
    description:
      "Publish an issued capital call's notices to the partners' LP portals. Call preview_call_notices first, show the user " +
      'every partner and figure it lists, and stage this only once they confirm, passing its previewToken. An admin then ' +
      'approves it: in the app, confirming twice, or from their chat on an explicit yes. It does not email anyone.',
    inputSchema: {
      type: 'object',
      required: ['callId', 'previewToken'],
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group).' },
        callId: { type: 'string', description: 'The issued capital call (lp_capital_calls lists them).' },
        lpEntityIds: { type: 'array', items: { type: 'string' }, description: 'Only these partners. Omit for every partner on the call.' },
        previewToken: { type: 'string', description: 'The previewToken preview_call_notices returned for exactly these notices.' },
      },
    },
    preview: previewPublishCallNotices,
    execute: executePublishCallNoticesElsewhere,
  },
  update_portfolio_construction: {
    entity: 'required',
    domain: 'accounting',
    // Unlike conversational suggestions, changing a fund plan is only draftable by a writer.
    stageAccess: 'write',
    description:
      "Propose changes to a plan's Investments tab — its portfolio construction — for one vehicle: add, change or " +
      'remove planned deals (check, timing, exit), set the exit (value or multiple, and when) and follow-on of a ' +
      'company the fund already holds, each deal\'s simulation settings, the fund-wide return assumptions ' +
      '(hold, default exit multiple, write-off rate, exit timing range), and the portfolio targets. Investments and exits are entered here and ' +
      'nowhere else; the forecast\'s cash, calls, distributions and returns follow from them. Fees and expenses ' +
      "are not here: they are the Financials tab's (update_forecast_plan). Omit planId for the entity's primary " +
      'plan; pass it to change a scenario or budget. Stages a preview for human approval and saves nothing until approved. ' +
      FORECASTING_PRINCIPLES,
    inputSchema: UPDATE_CONSTRUCTION_SCHEMA as any,
    preview: previewUpdatePortfolioConstruction,
    execute: executeUpdatePortfolioConstruction,
  },
  create_forecast_plan: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    stageAccess: 'write',
    description:
      'Propose a new budget or rolling forecast for a vehicle. Seeded by default with a rule per account ' +
      'suggested from 12–36 months of its own closed history (call forecast_suggest_rules first to see ' +
      'them); pass `rules` to adjust any for what the user told you (hires, price changes, new costs). ' +
      'Stages one preview of every rule for human approval; creates a draft, never a published version. ' +
      FORECASTING_PRINCIPLES,
    inputSchema: CREATE_PLAN_SCHEMA as any,
    preview: previewCreateForecast,
    execute: executeCreateForecast,
  },
  update_forecast_plan: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    stageAccess: 'write',
    description:
      "Propose changes to a plan's Financials and Capital planning tabs — account rules (fees, expenses; by account code), " +
      'month overrides, a month\'s capital call or distribution (cashFigures), the calls/distributions policy (capitalPolicy), hand ' +
      'entries, or its cutoff/horizon/name, or making it the primary plan. Investments and exits are update_portfolio_construction. ' +
      'Stages a before/after preview for human approval; nothing changes until approved. ' +
      FORECASTING_PRINCIPLES,
    inputSchema: UPDATE_PLAN_SCHEMA as any,
    preview: previewUpdateForecast,
    execute: executeUpdateForecast,
  },
  publish_forecast_plan: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    stageAccess: 'write',
    description:
      'Propose saving a plan as it stands — investments, financials and capital — as a scenario (status ' +
      '"published") or as the plan\'s budget (status "approved", one per plan), the base later actuals are compared ' +
      'against. A saved scenario never changes. Stages for human approval.',
    inputSchema: PUBLISH_PLAN_SCHEMA as any,
    preview: previewPublishForecast,
    execute: executePublishForecast,
  },
  set_entity_link: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    stageAccess: 'write',
    description:
      "Propose adding or changing an entity link (the Forecast page's settings → Entity links): a fund pays the management " +
      'company its management fee, billed every everyMonths (1/3/6/12) from anchorMonth, in advance or arrears, cash ' +
      'cashLagMonths later. vehicle is the management company. Needs write on both. Stages for human approval.',
    inputSchema: {
      type: 'object',
      required: ['vehicle', 'fund'],
      additionalProperties: false,
      properties: {
        vehicle: { type: 'string', description: 'The management company.' },
        fund: { type: 'string', description: 'The fund that pays it.' },
        everyMonths: { type: 'number', enum: [1, 3, 6, 12] },
        anchorMonth: { type: 'number', minimum: 1, maximum: 12 },
        direction: { type: 'string', enum: ['advance', 'arrears'] },
        cashLagMonths: { type: 'number', minimum: 0, maximum: 12 },
        active: { type: 'boolean' },
        explanation: { type: 'string' },
      },
    },
    preview: previewSetEntityLink as any,
    execute: executeSetEntityLink as any,
  },
}

export function getWriteAction(name: string): WriteAction | undefined {
  return (WRITE_ACTIONS as Record<string, WriteAction>)[name]
}
