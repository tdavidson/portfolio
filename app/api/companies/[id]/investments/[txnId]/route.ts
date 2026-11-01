import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { deleteInvestmentTransaction, updateInvestmentTransaction } from '@/lib/portfolio/transaction-edit'
import { outcomeResponse } from '@/lib/service-outcome'

// The edit and delete themselves live in lib/portfolio/transaction-edit.ts, shared with the agent
// tools `update_investment` and `delete_investment`.

// ---------------------------------------------------------------------------
// PATCH — update a transaction
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; txnId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const scope = await loadEntityScope(admin, writeCheck)

  const result = await updateInvestmentTransaction(
    admin,
    { fundId: writeCheck.fundId, userId: user.id, vehicleNames: scope.writableNames },
    params.id, params.txnId, body,
  )
  return outcomeResponse(result, ({ transaction, ledger }) => ({ ...(transaction as object), ledger }))
}

// ---------------------------------------------------------------------------
// DELETE — delete a transaction
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ id: string; txnId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const scope = await loadEntityScope(admin, writeCheck)

  const result = await deleteInvestmentTransaction(
    admin,
    { fundId: writeCheck.fundId, userId: user.id, vehicleNames: scope.writableNames },
    params.id, params.txnId,
  )
  return outcomeResponse(result, ({ ledger }) => ({ success: true, ledger, ...(ledger.warning ? { warning: ledger.warning } : {}) }))
}
