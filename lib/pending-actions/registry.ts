import { FORECASTING_PRINCIPLES } from '@/lib/forecast/principles'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { ActionType, ActionDeps, PreviewResult } from './types'
import { previewMetricValue, writeMetricValue } from './metric-value'
import { previewRecordInvestment, executeRecordInvestment } from './investment'
import { previewIssueCapitalCall, executeIssueCapitalCall } from './capital-call'
import {
  previewUpdatePortfolioConstruction,
  executeUpdatePortfolioConstruction,
} from './construction'
import {
  previewUpdateForecast, executeUpdateForecast, previewPublishForecast, executePublishForecast,
  previewCreateForecast, executeCreateForecast,
} from './forecast'
import { CREATE_PLAN_SCHEMA, PUBLISH_PLAN_SCHEMA, UPDATE_PLAN_SCHEMA } from '@/lib/forecast/actions'

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
        proceeds_received: { type: 'number' },
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
      },
    },
    preview: previewIssueCapitalCall,
    execute: executeIssueCapitalCall,
  },
  update_portfolio_construction: {
    entity: 'required',
    domain: 'accounting',
    // Unlike conversational suggestions, changing a fund plan is only draftable by a writer.
    stageAccess: 'write',
    description:
      'Propose changes to the forward-looking portfolio-construction assumptions for one vehicle. ' +
      'This stages a preview for human approval and does not save the model immediately.',
    inputSchema: {
      type: 'object',
      required: ['vehicle'],
      additionalProperties: false,
      properties: {
        vehicle: { type: 'string', description: 'Investment vehicle name.' },
        feeAnnualRate: { type: 'number', minimum: 0 },
        feeBasis: { type: 'string', enum: ['committed', 'invested', 'nav'] },
        feeTermYears: { type: 'number', minimum: 0 },
        feeStartDate: { type: 'string' },
        feeStepDownYear: { type: ['number', 'null'], minimum: 0 },
        feeStepDownRate: { type: ['number', 'null'], minimum: 0 },
        annualPartnershipExpense: { type: 'number', minimum: 0 },
        remainingOrgCosts: { type: 'number', minimum: 0 },
        targetPortfolioSize: { type: 'number', minimum: 0 },
        targetFundMultiple: { type: 'number', minimum: 0 },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'label', 'initialCheck', 'initialPostMoney', 'followOnMultiple', 'dilutionFactor'],
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              initialCheck: { type: 'number', minimum: 0 },
              initialPostMoney: { type: 'number', minimum: 0 },
              followOnMultiple: { type: 'number', minimum: 0 },
              followOnCheck: { type: 'number', minimum: 0 },
              dilutionFactor: { type: 'number', minimum: 0 },
              ownershipAtExit: { type: 'number', minimum: 0 },
              additionalDilution: { type: 'number', minimum: 0, maximum: 1 },
              expectedExitValue: { type: 'number', minimum: 0 },
              forecastMoic: { type: 'number', minimum: 0 },
              returnMethod: { type: 'string', enum: ['ownership', 'moic'] },
            },
          },
        },
        positionForecasts: {
          type: 'object',
          description: 'Forecast changes keyed by stable company UUID.',
          propertyNames: { format: 'uuid' },
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              plannedFollowOn: { type: 'number', minimum: 0 },
              ownershipAtExit: { type: 'number', minimum: 0 },
              additionalDilution: { type: 'number', minimum: 0, maximum: 1 },
              expectedExitValue: { type: 'number', minimum: 0 },
              forecastMoic: { type: 'number', minimum: 0 },
              returnMethod: { type: 'string', enum: ['ownership', 'moic'] },
            },
          },
        },
        explanation: { type: 'string', description: 'Optional explanation supplied by the user.' },
      },
    },
    preview: previewUpdatePortfolioConstruction,
    execute: executeUpdatePortfolioConstruction,
  },
  create_forecast_plan: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    accessFeature: 'budgeting',
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
    accessFeature: 'budgeting',
    stageAccess: 'write',
    description:
      'Propose changes to a budget or forecast draft — account rules (by account code), month overrides, ' +
      'or its cutoff/horizon. Stages a before/after preview for human approval; nothing changes until approved. ' +
      FORECASTING_PRINCIPLES,
    inputSchema: UPDATE_PLAN_SCHEMA as any,
    preview: previewUpdateForecast,
    execute: executeUpdateForecast,
  },
  publish_forecast_plan: {
    entity: 'required',
    managementCompanies: true,
    domain: 'accounting',
    accessFeature: 'budgeting',
    stageAccess: 'write',
    description:
      'Propose publishing a plan as an immutable version, or approving it as the budget baseline. ' +
      'Stages for human approval.',
    inputSchema: PUBLISH_PLAN_SCHEMA as any,
    preview: previewPublishForecast,
    execute: executePublishForecast,
  },
}

export function getWriteAction(name: string): WriteAction | undefined {
  return (WRITE_ACTIONS as Record<string, WriteAction>)[name]
}
