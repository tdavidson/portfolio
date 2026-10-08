import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { draftEntryForTransaction, retractEntriesForTransaction } from '@/lib/accounting/from-portfolio'
import { validateConversionLink } from '@/lib/accounting/conversion-link'
import { normalizeSecurityType, SECURITY_TYPES } from '@/lib/accounting/soi'
import { ensureVehiclesByName } from '@/lib/accounting/vehicle-id'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'

/**
 * A transaction the fund register booked — a manager NAV's mark, or a confirmed capital notice — is
 * owned by that register row: it is derived from the statement or notice, and re-derived when they
 * change. Edited or deleted here it would leave the register describing a value the ledger no longer
 * carries, and every later NAV's mark (a delta against the ledger) stale. So it is changed there.
 * Fails closed: a lookup that errors refuses too.
 */
async function fundRegisterOwner(admin: any, fundId: string, txnId: string): Promise<string | null> {
  const [navs, events] = await Promise.all([
    admin.from('fund_nav_statements').select('id').eq('fund_id', fundId).eq('investment_transaction_id', txnId).limit(1),
    admin.from('fund_capital_events').select('id').eq('fund_id', fundId).eq('investment_transaction_id', txnId).limit(1),
  ])
  if (navs.error || events.error) {
    return 'Could not check whether the fund register owns this transaction, so it was not changed. Try again.'
  }
  if ((navs.data ?? []).length > 0) {
    return 'This is the mark of a manager NAV statement. Change or delete that statement in the fund register on the holding '
      + '(Manager NAV statements), which re-books the mark.'
  }
  if ((events.data ?? []).length > 0) {
    return 'This was booked from a capital notice in the fund register. Change it from the notice in the fund register on the holding.'
  }
  return null
}

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

  // Verify transaction exists and belongs to this company
  const { data: existing } = await admin
    .from('investment_transactions' as any)
    .select('*')
    .eq('id', params.txnId)
    .eq('company_id', params.id)
    .maybeSingle() as { data: { id: string; company_id: string; fund_id: string; transaction_type: string; portfolio_group: string | null; [key: string]: any } | null }

  if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })

  // Verify the transaction's fund matches the user's fund
  if (existing.fund_id !== writeCheck.fundId) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const body = await req.json()

  // Only the caller's entities' rows, and only into one of their entities.
  const scope = await loadEntityScope(admin, writeCheck)
  const deniedHere = groupWriteDenial(scope.vehicleNames, existing.portfolio_group)
    ?? ('portfolio_group' in body ? groupWriteDenial(scope.vehicleNames, body.portfolio_group) : null)
  if (deniedHere) return NextResponse.json({ error: deniedHere }, { status: 403 })

  const owned = await fundRegisterOwner(admin, writeCheck.fundId, params.txnId)
  if (owned) return NextResponse.json({ error: owned }, { status: 409 })

  // A mis-typed row can be reclassified on edit (e.g. a "Round" that should be a "Valuation
  // Update"). Only the DB types are valid; the UI's "conversion" is already translated to
  // 'investment' + converts_from before it reaches here.
  const VALID_TYPES = ['investment', 'proceeds', 'escrow_receipt', 'unrealized_gain_change', 'round_info', 'split', 'income']
  if ('transaction_type' in body && !VALID_TYPES.includes(body.transaction_type)) {
    return NextResponse.json({ error: 'Invalid transaction_type' }, { status: 400 })
  }
  const nextType: string = ('transaction_type' in body ? body.transaction_type : existing.transaction_type)

  // Rows whose conversion depends on THIS row (this row is their SAFE/note source).
  const { data: dependents } = await admin
    .from('investment_transactions' as any)
    .select('id')
    .eq('converts_from_txn_id', params.txnId) as { data: { id: string }[] | null }
  const dependentCount = (dependents ?? []).length

  // #5 — A conversion source must stay an `investment`. Reclassifying it to anything else would
  // silently drop the dependent conversion's carried basis (computeSummary skips non-investment
  // sources). Block it rather than let the numbers shrink with no warning.
  if (dependentCount > 0 && nextType !== 'investment') {
    return NextResponse.json(
      { error: `Can't change this to a ${nextType}: ${dependentCount} conversion${dependentCount > 1 ? 's' : ''} on this company convert${dependentCount > 1 ? '' : 's'} from it. Re-point or remove those conversions first.` },
      { status: 400 },
    )
  }

  // #2 — Validate the conversion link the same way create does (dangling / cross-company / self /
  // non-investment). Without this, an edit could set a link the create path would have rejected.
  if (body.converts_from_txn_id) {
    const linkError = await validateConversionLink(admin, params.id, body.converts_from_txn_id, nextType, scope.vehicleNames, params.txnId)
    if (linkError) return NextResponse.json({ error: linkError }, { status: 400 })
  }

  // Only allow updating known fields
  const allowedFields = [
    'transaction_type',
    'round_name', 'transaction_date', 'notes',
    'investment_cost', 'interest_converted', 'shares_acquired', 'share_price',
    // Corrigible on edit: a split announced at the wrong ratio is a share count that is wrong
    // everywhere until it is fixed. The DB constraints still enforce positive-and-dated.
    'split_ratio',
    // Income the position produced, and acquisition costs capitalised into its basis.
    'income_kind', 'income_settlement', 'income_amount', 'fee_amount',
    'cost_basis_exited', 'proceeds_received', 'proceeds_escrow',
    'proceeds_written_off', 'proceeds_per_share',
    'unrealized_value_change', 'current_share_price',
    'postmoney_valuation', 'ownership_pct', 'latest_postmoney_valuation', 'exit_valuation',
    'original_currency',
    'original_investment_cost', 'original_share_price', 'original_postmoney_valuation',
    'original_proceeds_received', 'original_proceeds_per_share', 'original_exit_valuation',
    'original_unrealized_value_change', 'original_current_share_price',
    'original_latest_postmoney_valuation',
    'valuation_change_source', 'fx_rate', 'prior_fx_rate', 'fx_value_change',
    'original_position_value',
    'portfolio_group',
    // The Schedule of Investments reads `security_type` for its by-asset-type breakout, but
    // it was in no create route, no allowlist and no import — so nothing in the app could
    // ever set it, and the breakout fell back to a two-bucket guess forever.
    'security_type',
    // Convertible-note terms. `interest_rate` is the ONLY rate the ledger accrues on.
    // `dividend_rate` is preferred-equity dividends: they accrue to the liquidation preference,
    // not to income, and never touch the books.
    'interest_rate', 'maturity_date', 'dividend_rate',
    // The conversion link (which SAFE/note this priced round converted). Editing a conversion
    // re-drafts its ledger entry from the new values, same as any other investment edit.
    'converts_from_txn_id',
  ]

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key]
  }

  // Same CHECK constraint as the create route: reject in words rather than let Postgres reject it
  // in a 500. Null stays null — that's how you clear the instrument back to the derived fallback.
  if (body.security_type != null && body.security_type !== '') {
    const security_type = normalizeSecurityType(body.security_type)
    if (!security_type) {
      return NextResponse.json(
        { error: `Invalid security_type "${body.security_type}". Must be one of: ${SECURITY_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    updates.security_type = security_type
  } else if ('security_type' in body) {
    updates.security_type = null
  }

  if ('portfolio_group' in updates) {
    // Every stored portfolio_group name must be backed by a real fund_vehicles row — never a
    // disconnected string. Resolve/create before the write, not after.
    await ensureVehiclesByName(admin, existing.fund_id, [updates.portfolio_group as string | null | undefined])
  }

  // Retract the ledger side FIRST, as DELETE does. When it refuses — a closed period, an adopted
  // entry that can't be split — nothing is written, so the tracker and the ledger stay in step.
  // Editing the row first used to leave the tracker on the new figures and the ledger on the old.
  const retracted = await retractEntriesForTransaction(admin, existing.fund_id, params.txnId, { userId: user.id, original: existing })
  if (retracted.reason) {
    return NextResponse.json({ error: `Can't change this transaction. ${retracted.reason}` }, { status: 409 })
  }

  const { data: company } = await admin
    .from('companies' as any)
    .select('name')
    .eq('id', params.id)
    .maybeSingle() as { data: { name: string } | null }
  const companyName = company?.name ?? 'Investment'

  const { data: txn, error } = await admin
    .from('investment_transactions' as any)
    .update(updates)
    .eq('id', params.txnId)
    .select('*')
    .single()

  if (error) {
    // The old entry was retracted; put the unchanged transaction back on the ledger.
    if (retracted.retracted > 0) {
      const restored = await draftEntryForTransaction(admin, existing.fund_id, user.id, existing, companyName)
      if (!restored.drafted) console.error('[companies-id-investments-txnId-patch] could not re-derive after a failed update', restored.reason)
    }
    return dbError(error, 'companies-id-investments-txnId-patch')
  }

  logActivity(admin, existing.fund_id, user.id, 'investment.update', {
    companyId: params.id,
    transactionId: params.txnId,
  })

  // Re-mirror the ledger: derive the edited transaction afresh.
  const derived = await draftEntryForTransaction(admin, existing.fund_id, user.id, txn, companyName)
  const ledger = retracted.warning ? { ...derived, warning: retracted.warning } : derived

  return NextResponse.json({ ...(txn as object), ledger })
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

  // Verify transaction exists and belongs to this company
  const { data: existing } = await admin
    .from('investment_transactions' as any)
    .select('id, company_id, fund_id, portfolio_group')
    .eq('id', params.txnId)
    .eq('company_id', params.id)
    .maybeSingle() as { data: { id: string; company_id: string; fund_id: string; portfolio_group: string | null } | null }

  if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })

  // Verify the transaction's fund matches the user's fund
  if (existing.fund_id !== writeCheck.fundId) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const deleteScope = await loadEntityScope(admin, writeCheck)
  const deniedDelete = groupWriteDenial(deleteScope.vehicleNames, existing.portfolio_group)
  if (deniedDelete) return NextResponse.json({ error: deniedDelete }, { status: 403 })

  const owned = await fundRegisterOwner(admin, writeCheck.fundId, params.txnId)
  if (owned) return NextResponse.json({ error: owned }, { status: 409 })

  // #3 — Refuse to delete an instrument that a conversion depends on. The FK is ON DELETE SET
  // NULL, so deleting it would silently orphan the conversion into a $0-cost investment (its basis
  // gone, its shares now valued at nothing). Make the dependency explicit instead of destroying it.
  const { data: dependents } = await admin
    .from('investment_transactions' as any)
    .select('id')
    .eq('converts_from_txn_id', params.txnId) as { data: { id: string }[] | null }
  if ((dependents ?? []).length > 0) {
    const n = (dependents ?? []).length
    return NextResponse.json(
      { error: `Can't delete this: ${n} conversion${n > 1 ? 's' : ''} on this company convert${n > 1 ? '' : 's'} from it. Delete or re-point ${n > 1 ? 'those' : 'that'} first.` },
      { status: 400 },
    )
  }

  // Retract the ledger side FIRST. If its journal entry sits in a closed period we refuse the
  // whole delete — otherwise the tracker would lose a transaction the books still carry, and
  // the two would disagree with nothing to explain why. Deleting the tracker row first and
  // then failing here would leave exactly that mess.
  const ledger = await retractEntriesForTransaction(admin, existing.fund_id, params.txnId, { userId: user.id })
  if (ledger.reason) {
    return NextResponse.json({ error: `Can't delete this transaction. ${ledger.reason}` }, { status: 400 })
  }

  const { error } = await admin
    .from('investment_transactions' as any)
    .delete()
    .eq('id', params.txnId)

  if (error) return dbError(error, 'companies-id-investments-txnId-delete')

  logActivity(admin, existing.fund_id, user.id, 'investment.delete', {
    companyId: params.id,
    transactionId: params.txnId,
  })

  return NextResponse.json({ success: true, ledger, ...(ledger.warning ? { warning: ledger.warning } : {}) })
}
