import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'

export type ActionType =
  | 'update_company_metric'
  | 'record_investment'
  | 'issue_capital_call'
  | 'publish_call_notices'
  | 'update_portfolio_construction'
  | 'update_forecast_plan'
  | 'publish_forecast_plan'
  | 'create_forecast_plan'
  | 'set_entity_link'

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
