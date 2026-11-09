// A vehicle's default statement basis (fund_vehicles.statement_basis,
// 20261109230000_vehicle_statement_basis.sql), so a vehicle whose partners get cost statements does
// not need the toggle every time. A request that names a basis always wins.
import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { DEFAULT_STATEMENT_BASIS, isStatementBasis, parseStatementBasis, type StatementBasis } from './statement-basis'

/** The vehicle's default basis; fair value when none is set or the column is not migrated yet. */
export async function vehicleStatementBasis(admin: SupabaseClient, fundId: string, group: string): Promise<StatementBasis> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return DEFAULT_STATEMENT_BASIS
  const { data, error } = await (admin as any)
    .from('fund_vehicles').select('statement_basis').eq('id', vehicleId).eq('fund_id', fundId).maybeSingle()
  // Column not migrated yet: every vehicle is on fair value, as before.
  if (error || !data) return DEFAULT_STATEMENT_BASIS
  return isStatementBasis(data.statement_basis) ? data.statement_basis : DEFAULT_STATEMENT_BASIS
}

/** The basis a statement request asked for, or the vehicle's default when it named none. */
export async function resolveStatementBasis(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  requested: unknown,
): Promise<StatementBasis | { error: string }> {
  if (requested !== undefined && requested !== null && requested !== '') return parseStatementBasis(requested)
  return vehicleStatementBasis(admin, fundId, group)
}
