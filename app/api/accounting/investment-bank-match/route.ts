import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { unbankedInvestments, matchInvestmentToBank } from '@/lib/accounting/investment-bank-match'

// GET — posted investment entries with no bank row, each with candidate bank rows.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  return NextResponse.json(await unbankedInvestments(admin, gate.fundId, group))
}

// POST — { entryId, bankTransactionId, group? } links them. Nothing is posted.
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
  const entryId = typeof body?.entryId === 'string' ? body.entryId : null
  const bankTransactionId = typeof body?.bankTransactionId === 'string' ? body.bankTransactionId : null
  if (!entryId || !bankTransactionId) return NextResponse.json({ error: 'entryId and bankTransactionId are required' }, { status: 400 })

  const result = await matchInvestmentToBank(admin, gate.fundId, group, entryId, bankTransactionId)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
