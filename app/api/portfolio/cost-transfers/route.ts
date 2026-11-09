import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { convertToCostTransfer, recordCostTransfer } from '@/lib/portfolio/cost-transfer'
import { outcomeResponse } from '@/lib/service-outcome'

// POST — move cost between two holdings of one entity, with no cash and no gain.
//
//   { action: 'record', from_company_id, to_company_id, amount, date, vehicle, memo? }
//     posts one journal entry, Dr Investment — target / Cr Investment — source, adopted as two
//     cost_transfer rows.
//   { action: 'convert', entry_id, dry_run? }
//     replaces the proceeds + investment rows an earlier adoption read from a transfer-shaped entry
//     with the two cost_transfer rows. The journal entry is not changed.
//
// The work lives in lib/portfolio/cost-transfer.ts, shared with the agent tools `transfer_cost` and
// `convert_to_cost_transfer`.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const scope = await loadEntityScope(admin, writeCheck)
  const who = { fundId: writeCheck.fundId, userId: user.id, vehicleNames: scope.writableNames }

  if (body.action === 'convert') {
    return outcomeResponse(await convertToCostTransfer(admin, who, String(body.entry_id ?? ''), { dryRun: body.dry_run === true }))
  }
  if (body.action === 'record') {
    return outcomeResponse(await recordCostTransfer(admin, who, {
      fromCompanyId: String(body.from_company_id ?? ''),
      toCompanyId: String(body.to_company_id ?? ''),
      amount: Number(body.amount),
      date: String(body.date ?? ''),
      vehicle: String(body.vehicle ?? ''),
      memo: typeof body.memo === 'string' ? body.memo : null,
    }))
  }
  return NextResponse.json({ error: "action must be 'record' or 'convert'" }, { status: 400 })
}
