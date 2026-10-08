import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadAccessContext, type AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

/**
 * The gate for an entity's documents: a member of the fund who can see this entity — whatever their
 * domain grants (owner decision: governing documents are for anyone on the entity's team). Writing
 * also needs write access (so not the read-only demo viewer). Not found, never "forbidden": an
 * entity outside the caller's is not confirmed to exist.
 */
export async function entityDocumentsGate(
  admin: SupabaseClient,
  userId: string,
  vehicleId: string,
  mode: 'read' | 'write',
): Promise<{ fundId: string; userId: string; access: AccessContext } | NextResponse> {
  const gate = mode === 'write' ? await assertWriteAccess(admin, userId) : await assertReadAccess(admin, userId)
  if (gate instanceof NextResponse) return gate
  const { data: vehicle } = await (admin as any).from('fund_vehicles').select('id').eq('id', vehicleId).eq('fund_id', gate.fundId).maybeSingle()
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!vehicle || !canSeeVehicle(access, vehicleId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return { fundId: gate.fundId, userId: gate.userId, access }
}
