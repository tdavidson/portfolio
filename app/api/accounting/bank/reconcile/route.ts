import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadPostedLedger } from '@/lib/accounting/load'
import { accountBalances } from '@/lib/accounting/ledger'
import { openingCashBefore, summarizeBankRec, type BankTxnState } from '@/lib/accounting/bank'

// GET — bank reconciliation for a vehicle: ledger cash vs the bank feed.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const { accounts, postings } = await loadPostedLedger(admin, gate.fundId, group)
  const cash = accounts.find(a => a.code === '1000')
  const ledgerCashBalance = cash ? (accountBalances(postings).get(cash.id) ?? 0) : 0

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const { data } = await admin
    .from('bank_transactions' as any)
    .select('txn_date, amount, status')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .neq('status', 'ignored')
  const rows = (data as any[]) ?? []
  const txns: BankTxnState[] = rows.map(t => ({ amount: Number(t.amount), matched: t.status === 'reconciled' }))

  return NextResponse.json(summarizeBankRec(txns, ledgerCashBalance, openingCashBefore(postings, cash?.id, rows.map(t => t.txn_date))))
}
