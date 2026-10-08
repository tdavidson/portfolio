import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts), write — a POST that may post to the ledger.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { buildAllocationEntry, type AllocationBody } from '@/lib/accounting/allocation-actions'
import { persistEntry } from '@/lib/accounting/persist'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

const ACTIONS = ['management_fee', 'expense', 'gain', 'distribution', 'carry']

// POST — build one of the standard entries from its inputs, and either return it as a preview or
// write it. The same builder the agent's `allocation` tool uses (lib/accounting/allocation-actions.ts),
// reached from the journal's New entry menu.
//
// Body: AllocationBody plus
//   preview: true       → { entry } with account codes and names resolved, nothing written
//   status: 'draft'|'posted'  → written as such (default draft — nothing posts itself)
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  if (!ACTIONS.includes(body?.action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 })
  }
  if (!body?.entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.entryDate)) {
    return NextResponse.json({ error: 'entryDate (YYYY-MM-DD) is required' }, { status: 400 })
  }

  const built = await buildAllocationEntry(admin, gate.fundId, group, body as AllocationBody)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const entry = { ...built.entry, reference: typeof body.reference === 'string' ? body.reference.slice(0, 80) : null }

  // Names for the preview, so the modal can show "5000 · Management fee" rather than an id.
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const { data: accts } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code, name')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
  const nameById = new Map(((accts as any[]) ?? []).map(a => [a.id as string, { code: a.code as string, name: a.name as string }]))
  const described = {
    ...entry,
    postings: entry.postings.map(p => ({ ...p, accountCode: nameById.get(p.accountId)?.code ?? '', accountName: nameById.get(p.accountId)?.name ?? '' })),
  }

  if (body.preview) return NextResponse.json({ entry: described })

  const status = body.status === 'posted' ? 'posted' : 'draft'
  const result = await persistEntry(admin, gate.fundId, group, user.id, entry, status)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ id: result.entryId, status, entry: described })
}
