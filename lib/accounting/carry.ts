// Accrued carried interest — the loader.
//
// The math (preferred return, hypothetical-liquidation target, per-LP accrual) lives in the open
// fund engine, packages/fund-engine/src/carry.ts (@portfolio/fund-engine), and is re-exported here
// so existing imports keep working. This module adds only what needs the database: reading a
// vehicle's stored terms.

import type { SupabaseClient } from '@supabase/supabase-js'
import { carryTermsFromRow, NO_CARRY, type VehicleCarryTerms } from '@portfolio/fund-engine'
import { vehicleIdByName } from './vehicle-id'

export {
  NO_CARRY,
  resolveCarryRecipients,
  preferredTarget,
  carryTarget,
  carryAccrual,
  carryTermsFromRow,
  runsPerLp,
} from '@portfolio/fund-engine'
export type {
  CarryKind,
  CarryStep,
  ContributionPurpose,
  DayCount,
  PrefBase,
  HurdleReduction,
  CarryRecipient,
  VehicleCarryTerms,
  LpEconomics,
  DatedContribution,
  CarryTargetInput,
  CarryAccrual,
  WaterfallScope,
} from '@portfolio/fund-engine'

/** A vehicle's carry terms. Absent row = no carry, which is the only safe default:
 *  accruing carry nobody agreed to is worse than accruing none. */
export async function loadCarryTerms(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<VehicleCarryTerms> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return NO_CARRY

  const { data } = await admin
    .from('vehicle_waterfall_terms' as any)
    // '*', not a column list: a column this release reads but the database has not been migrated
    // to yet would fail the whole select, and a failed read here is no carry at all.
    .select('*')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()

  return carryTermsFromRow(data as any)
}
