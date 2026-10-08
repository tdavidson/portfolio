import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { ensureVehicleAccounts } from '@/lib/accounting/provision-accounts'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; this resolves identity and keeps the demo out of writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from '@/lib/accounting/persist'
import { roundCents } from '@/lib/accounting/ledger'
import { isInvestmentAccount } from '@/lib/accounting/investment-accounts'
import type { Posting, JournalEntry } from '@/lib/accounting/types'

// POST — book per-LP opening capital balances as a posted opening entry (cutover).
// Capital in nets against cash (offset defaults to 1000); the investment purchase
// is booked separately. Body: { entryDate, offsetAccountCode?, group?, balances }
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

  const entryDate: string = body?.entryDate
  const offsetCode: string = body?.offsetAccountCode ?? '1000'
  const balances = (body?.balances ?? []) as { lpEntityId: string; amount: number }[]
  if (!entryDate || !Array.isArray(balances) || balances.length === 0) {
    return NextResponse.json({ error: 'entryDate and at least one balance are required' }, { status: 400 })
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || !Number.isFinite(Date.parse(entryDate)) || new Date(entryDate).toISOString().slice(0, 10) !== entryDate) {
    return NextResponse.json({ error: 'A valid opening date is required' }, { status: 400 })
  }
  if (new Set(balances.map(b => b.lpEntityId)).size !== balances.length || balances.some(b => !b.lpEntityId || !Number.isFinite(Number(b.amount)))) {
    return NextResponse.json({ error: 'Provide one finite balance per partner' }, { status: 400 })
  }
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  // Refuse before anything is written. A null vehicle id is not a wildcard: the overlap check
  // below would match no rows and pass vacuously, and `publish_opening_balances` scopes on it too.
  if (!vehicleId) return NextResponse.json({ error: `"${group}" is not in this fund's vehicle registry` }, { status: 400 })
  const { data: existing, error: overlapError } = await admin.from('journal_postings' as any)
    .select('id').eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('book', 'actual')
    .in('lp_entity_id', balances.map(b => b.lpEntityId)).limit(1)
  if (overlapError) return NextResponse.json({ error: 'Could not check existing capital entries' }, { status: 500 })
  if (existing?.length) return NextResponse.json({ error: 'These partners already have accounting entries. Reconcile existing balances before importing an opening balance.' }, { status: 409 })

  await ensureVehicleAccounts(admin, gate.fundId, group)
  const codes = await accountIdByCode(admin, gate.fundId, group)
  const offsetId = codes.get(offsetCode)
  if (!offsetId) return NextResponse.json({ error: `The chart is missing the offset account ${offsetCode} — add it under the entity's Admin → Chart of accounts.` }, { status: 400 })
  // Opening POSITIONS are investment transactions, not an opening-balance offset: an offset on an
  // investment account would post value no transaction owns (plans/spec-ledger-one-writer.md §1).
  const { data: offsetAccount } = await admin.from('chart_of_accounts' as any)
    .select('type, subtype, company_id').eq('id', offsetId).eq('fund_id', gate.fundId).maybeSingle()
  if (offsetAccount && isInvestmentAccount({ type: (offsetAccount as any).type, subtype: (offsetAccount as any).subtype, companyId: (offsetAccount as any).company_id })) {
    return NextResponse.json({ error: 'Opening positions are recorded as investment transactions on each company, not as an opening-balance offset. Choose cash or another account.' }, { status: 400 })
  }

  const capMap = await ensureCapitalAccounts(admin, gate.fundId, group, balances.map(b => b.lpEntityId))

  let total = 0
  const postings: Posting[] = []
  for (const b of balances) {
    const amount = roundCents(Number(b.amount))
    if (!Number.isFinite(amount)) return NextResponse.json({ error: `Invalid amount for ${b.lpEntityId}` }, { status: 400 })
    total = roundCents(total + amount)
    const accountId = capMap.get(b.lpEntityId)
    if (!accountId) return NextResponse.json({ error: `No capital account for ${b.lpEntityId}` }, { status: 400 })
    postings.push({ accountId, amount: -amount, currency: 'USD', lpEntityId: b.lpEntityId })
  }
  postings.push({ accountId: offsetId, amount: total, currency: 'USD', lpEntityId: null })

  // DRAFT, then publish. `publish_opening_balances` links each partner's opening to the statement
  // observation it represents and posts the entry in one transaction, so a refused link cannot
  // leave a posted opening behind — the same shape as issuing a call or declaring a distribution.
  const entry: JournalEntry = { fundId: gate.fundId, entryDate, memo: 'Opening balances', sourceType: 'opening_balance', sourceRef: 'partner-opening', postings }
  const result = await persistEntry(admin, gate.fundId, group, user.id, entry, 'draft')
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })

  const { data: published, error: publishError } = await admin.rpc('publish_opening_balances' as any, {
    p_fund_id: gate.fundId, p_vehicle_id: vehicleId, p_entry_id: result.entryId, p_user_id: user.id,
  })
  if (publishError) {
    const { error: cleanupError } = await admin.rpc('discard_unpublished_opening_draft' as any, {
      p_fund_id: gate.fundId, p_vehicle_id: vehicleId, p_entry_id: result.entryId,
    })
    return NextResponse.json({
      error: `Opening balances were not posted: ${publishError.message}${cleanupError ? `; draft cleanup failed: ${cleanupError.message}` : ''}`,
    }, { status: 400 })
  }

  // `linked` is how many partners' openings are now recorded as representing their statement for
  // this date. Fewer than `lpCount` means some partners have no statement on file at that date —
  // legitimate, and surfaced rather than inferred.
  const linked = Number((published as any)?.linked ?? 0)
  return NextResponse.json({ ok: true, entryId: result.entryId, lpCount: balances.length, total, linkedObservations: linked })
}
