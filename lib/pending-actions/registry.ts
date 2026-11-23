import { FORECASTING_PRINCIPLES } from '@/lib/forecast/principles'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { ActionType, ActionDeps, PreviewResult } from './types'
import { RECORDABLE_TXN_TYPES } from '@/lib/agent/portfolio-tools-manifest'
import { previewMetricValue, writeMetricValue } from './metric-value'
import { previewUpdateCompany, executeUpdateCompany } from './company-edit'
import { UPDATE_COMPANY_DESCRIPTION, UPDATE_COMPANY_PROPERTIES } from '@/lib/agent/holding-tools-manifest'
import { previewRecordInvestment, executeRecordInvestment } from './investment'
import { previewIssueCapitalCall, executeIssueCapitalCall } from './capital-call'
import { previewDeclareDistribution, executeDeclareDistribution } from './distribution'
import { previewRequestBankDetails, executeRequestBankDetails } from './bank-details-request'
import { previewPublishCallNotices, executePublishCallNoticesElsewhere } from './call-notices'
import { previewPublishDistributionNotices, executePublishDistributionNoticesElsewhere } from './distribution-notices'
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
import { previewSetWaterfallTerms, executeSetWaterfallTerms } from './waterfall-terms'
import { SET_WATERFALL_TERMS_SCHEMA } from '@/lib/accounting/waterfall-terms-schema'
import {
  previewSetRecyclingTerms, executeSetRecyclingTerms, previewRecordRecycling, executeRecordRecycling,
  previewRemoveRecycling, executeRemoveRecycling,
} from './recycling'
import { RECORD_RECYCLING_PROPERTIES, RECYCLING_TERMS_PROPERTIES } from '@/lib/agent/recycling-tools-manifest'
import {
  previewSetCreditFacility, executeSetCreditFacility,
  previewRecordFacilityEvent, executeRecordFacilityEvent,
  previewRemoveFacilityEvent, executeRemoveFacilityEvent,
} from './credit-facility'
import { CREDIT_FACILITY_PROPERTIES, FACILITY_EVENT_PROPERTIES } from '@/lib/agent/credit-facility-tools-manifest'
import {
  previewApplyAdminFigures, executeApplyAdminFigures, previewSetVehicleRecordSource, executeSetVehicleRecordSource,
} from './admin-figures'
import { ADMIN_FIGURES_PROPERTIES, RECORD_SOURCE_PROPERTIES } from '@/lib/agent/admin-reporting-tools-manifest'

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
  update_company: {
    entity: 'none',
    domain: 'portfolio',
    description: UPDATE_COMPANY_DESCRIPTION,
    inputSchema: { type: 'object', required: ['company'], properties: UPDATE_COMPANY_PROPERTIES },
    preview: previewUpdateCompany,
    execute: executeUpdateCompany,
  },
  record_investment: {
    entity: 'optional',
    domain: 'portfolio',
    accessFeature: 'investments',
    description:
      'Record a portfolio transaction (investment | unrealized_gain_change | proceeds | escrow_receipt | round_info). ' +
      'Drafts the journal entry it implies for review; set converts_from_txn_id to link a SAFE/note conversion.',
    inputSchema: {
      type: 'object',
      required: ['company', 'transaction_type', 'transaction_date'],
      properties: {
        company: { type: 'string', description: 'Company id or name.' },
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group). Required for the ledger draft.' },
        transaction_type: { type: 'string', enum: [...RECORDABLE_TXN_TYPES] },
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
        consideration_in_kind: { type: 'number', description: 'Paid in securities, not cash: on an exit the part of the gross paid in shares; on an investment the part of the cost paid with them.' },
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
  declare_distribution: {
    entity: 'required',
    domain: 'lp_capital',
    description:
      'Declare a fund-wide distribution, split through the vehicle\'s waterfall (LP lines, the GP\'s own capital and its ' +
      'carried interest apart) or pro-rata by capital. Split again from the live books on approval; refused while the checks ' +
      'show a blocker.',
    inputSchema: {
      type: 'object',
      required: ['distributionDate', 'total'],
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group).' },
        distributionDate: { type: 'string', description: 'YYYY-MM-DD.' },
        total: { type: 'number', description: 'Fund-wide amount to distribute.' },
        description: { type: 'string' },
        method: { type: 'string', enum: ['waterfall', 'pro_rata'], description: 'Default waterfall. pro_rata only where the LPA treats this distribution that way.' },
      },
    },
    preview: previewDeclareDistribution,
    execute: executeDeclareDistribution,
  },
  request_bank_details: {
    entity: 'required',
    domain: 'lp_capital',
    description:
      'Email partners asking for their bank details for distributions: by portal account, or the contact or notice email ' +
      'on file when they have none. Partners with verified details are left out unless includeVerified.',
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group).' },
        lpEntityIds: { type: 'array', items: { type: 'string' }, description: 'Only these partners. Omit for every partner without verified details.' },
        message: { type: 'string', description: 'Replaces the opening line. The how-to and the fraud warning are always included.' },
        includeVerified: { type: 'boolean', description: 'Also ask partners whose details are verified to re-confirm them.' },
      },
    },
    preview: previewRequestBankDetails,
    execute: executeRequestBankDetails,
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
  publish_distribution_notices: {
    entity: 'required',
    domain: 'lp_relations',
    accessFeature: 'lp_portal',
    stageAccess: 'write',
    personConfirms: true,
    description:
      "Publish a declared distribution's notices (one per partner; the GP's capital and carry shown apart) and, with email, " +
      'email them: to the portal account, or the contact or notice email with the PDF attached when there is none. Call ' +
      'preview_distribution_notices first, show the user every partner, figure and recipient, and stage this only once they ' +
      'confirm, passing its previewToken. An admin then approves it: in the app, confirming twice, or from their chat on an explicit yes.',
    inputSchema: {
      type: 'object',
      required: ['distributionId', 'previewToken'],
      properties: {
        vehicle: { type: 'string', description: 'The vehicle (portfolio_group).' },
        distributionId: { type: 'string', description: 'The declared distribution (list_distributions lists them).' },
        lpEntityIds: { type: 'array', items: { type: 'string' }, description: 'Only these partners. Omit for every partner on the distribution.' },
        email: {
          type: 'object',
          description: 'Also email each partner their notice. Omit to publish to the portal only.',
          properties: {
            delivery: { type: 'string', enum: ['link', 'attachment', 'both'], description: 'Default attachment. Partners with no portal account always get the PDF.' },
            subject: { type: 'string' },
            message: { type: 'string' },
          },
        },
        previewToken: { type: 'string', description: 'The previewToken preview_distribution_notices returned for exactly these notices and this email.' },
      },
    },
    preview: previewPublishDistributionNotices,
    execute: executePublishDistributionNoticesElsewhere,
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
  set_waterfall_terms: {
    entity: 'required',
    // The partners' carry: GP economics, and only a writer there may even propose a change.
    domain: 'gp_economics',
    stageAccess: 'write',
    description:
      "Propose a vehicle's carry (waterfall) terms: kind (none, straight, american, european), carry rate, preferred return " +
      'and whether it compounds, GP catch-up, and who receives the carry. Usually from extract_lpa_terms, passing its ' +
      'proposedTerms (with documentId and sources, so the approver sees each clause checked against the LPA). Stages a ' +
      'before/after preview for human approval; nothing changes until approved. Rates are fractions (0.2 = 20%).',
    inputSchema: SET_WATERFALL_TERMS_SCHEMA as any,
    preview: previewSetWaterfallTerms,
    execute: executeSetWaterfallTerms,
  },
  set_recycling_terms: {
    entity: 'required',
    // The LPA's recycling clause changes what the partners' capital can be used for.
    domain: 'lp_capital',
    stageAccess: 'write',
    description:
      "Propose a vehicle's recycling terms from its LPA: the cap (a share of commitments or of management fees), the date " +
      'recycling ends, what recycled proceeds may fund, and the default treatment (retained = never distributed, deemed = ' +
      'distributed and recontributed). Stages a before/after preview; nothing changes until approved. Rates are fractions.',
    inputSchema: {
      type: 'object', required: ['vehicle', 'capRate'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...RECYCLING_TERMS_PROPERTIES },
    },
    preview: previewSetRecyclingTerms as any,
    execute: executeSetRecyclingTerms as any,
  },
  record_recycling: {
    entity: 'required',
    domain: 'lp_capital',
    stageAccess: 'write',
    description:
      "Propose recycling part of an exit's proceeds instead of distributing it, within the vehicle's cap. Retained posts " +
      'nothing; deemed posts one netted entry with no cash or notices, so each partner shows a distribution and a ' +
      'recontribution of their share by commitment. Stages a preview with the cap, what is left, and each partner\'s share.',
    inputSchema: {
      type: 'object', required: ['vehicle', 'date', 'amount'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...RECORD_RECYCLING_PROPERTIES },
    },
    preview: previewRecordRecycling as any,
    execute: executeRecordRecycling as any,
  },
  remove_recycling: {
    entity: 'required',
    domain: 'lp_capital',
    stageAccess: 'write',
    description: "Propose taking a recycled amount off a vehicle's register. A deemed amount's entry has to be voided first.",
    inputSchema: {
      type: 'object', required: ['vehicle', 'id'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, id: { type: 'string' }, explanation: { type: 'string' } },
    },
    preview: previewRemoveRecycling as any,
    execute: executeRemoveRecycling as any,
  },
  set_credit_facility: {
    entity: 'required',
    // Which borrowing the fund has, and on what terms: part of the partners' capital picture.
    domain: 'lp_capital',
    stageAccess: 'write',
    description:
      "Propose adding a credit facility (a subscription line or other borrowing) to a vehicle, or changing one: name, kind, " +
      'lender, size, dates and rate. Stages a preview; nothing changes until approved. Nothing is posted.',
    inputSchema: {
      type: 'object', required: ['vehicle', 'name'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...CREDIT_FACILITY_PROPERTIES },
    },
    preview: previewSetCreditFacility as any,
    execute: executeSetCreditFacility as any,
  },
  record_facility_event: {
    entity: 'required',
    domain: 'lp_capital',
    stageAccess: 'write',
    description:
      'Propose recording a draw, repayment, interest payment or fee on a credit facility. Posts its entry (interest and fees ' +
      'are allocated to the partners), or links an entry already on the books. Stages a preview with the balance before and after.',
    inputSchema: {
      type: 'object', required: ['vehicle', 'type', 'date', 'amount'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...FACILITY_EVENT_PROPERTIES },
    },
    preview: previewRecordFacilityEvent as any,
    execute: executeRecordFacilityEvent as any,
  },
  remove_facility_event: {
    entity: 'required',
    domain: 'lp_capital',
    stageAccess: 'write',
    description: "Propose taking a row off a vehicle's credit facility register. A row that posted its own entry needs the entry voided first.",
    inputSchema: {
      type: 'object', required: ['vehicle', 'id'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, id: { type: 'string' }, explanation: { type: 'string' } },
    },
    preview: previewRemoveFacilityEvent as any,
    execute: executeRemoveFacilityEvent as any,
  },
  apply_admin_figures: {
    entity: 'required',
    // Partners' capital as their administrator states it.
    domain: 'lp_capital',
    accessFeature: 'lp_tracking',
    stageAccess: 'write',
    description:
      "Propose saving one date's fund administrator figures for an admin-reported vehicle: each partner's commitment, " +
      "paid-in, distributions and NAV, and the fund's net LP-only IRR, TVPI and DPI. Shown as stated; nothing is recalculated.",
    inputSchema: {
      type: 'object', required: ['vehicle', 'as_of', 'source', 'positions'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...ADMIN_FIGURES_PROPERTIES },
    },
    preview: previewApplyAdminFigures as any,
    execute: executeApplyAdminFigures as any,
  },
  set_vehicle_record_source: {
    entity: 'required',
    domain: 'lp_capital',
    accessFeature: 'lp_tracking',
    stageAccess: 'write',
    description: "Propose that a vehicle report its fund administrator's figures instead of the app's own books, or the reverse.",
    inputSchema: {
      type: 'object', required: ['vehicle', 'record_source'], additionalProperties: false,
      properties: { vehicle: { type: 'string' }, ...RECORD_SOURCE_PROPERTIES },
    },
    preview: previewSetVehicleRecordSource as any,
    execute: executeSetVehicleRecordSource as any,
  },
}

export function getWriteAction(name: string): WriteAction | undefined {
  return (WRITE_ACTIONS as Record<string, WriteAction>)[name]
}
