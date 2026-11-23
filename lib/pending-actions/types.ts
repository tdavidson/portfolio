import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'

export type ActionType =
  | 'update_company_metric'
  | 'update_company'
  | 'record_investment'
  | 'issue_capital_call'
  | 'declare_distribution'
  | 'request_bank_details'
  | 'publish_call_notices'
  | 'publish_distribution_notices'
  | 'update_portfolio_construction'
  | 'update_forecast_plan'
  | 'publish_forecast_plan'
  | 'create_forecast_plan'
  | 'set_entity_link'
  | 'set_waterfall_terms'
  | 'set_recycling_terms'
  | 'record_recycling'
  | 'remove_recycling'
  | 'set_credit_facility'
  | 'record_facility_event'
  | 'remove_facility_event'
  | 'apply_admin_figures'
  | 'set_vehicle_record_source'

export type PendingActionStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'failed'

/** A read-only rendering of what a write WOULD do, shown to the approver before anything runs. */
export interface PreviewResult {
  summary: string
  details: Record<string, unknown>
}

/** The shared context every preview/execute is called with. */
export interface ActionDeps {
  admin: SupabaseClient
  fundId: string
  userId: string
  access: AccessContext
  /**
   * The origin the approver reached the app at, when the door knows it: a staged tool that calls
   * back into this deployment (a PDF attachment, publishing notices) uses it. Absent = the site origin.
   */
  origin?: string
  /**
   * Epoch ms by which the request applying this must be done, when it runs under a time limit (a
   * run's own clock, lib/agent/run-action.ts). A step that works in rounds, like a close, fits
   * itself inside it. Absent = the step's own default budget.
   */
  deadline?: number
}

export interface PendingAction {
  id: string
  fundId: string
  vehicleId: string | null
  domain: Domain
  actionType: ActionType
  args: Record<string, unknown>
  preview: PreviewResult
  status: PendingActionStatus
  createdBy: string
  createdVia: string | null
  appliedResult: Record<string, unknown> | null
  error: string | null
}
