import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows, groupWriteDenial } from '@/lib/access/scope'

// ---------------------------------------------------------------------------
// GET — list all fund cash flows for this fund, ordered by flow_date ASC
// ---------------------------------------------------------------------------

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const { data, error } = await admin
    .from('fund_cash_flows' as any)
    .select('*')
    .eq('fund_id', membership.fund_id)
    .order('flow_date', { ascending: true }) as {
      data: { id: string; fund_id: string; portfolio_group: string; flow_date: string; flow_type: string; amount: number; notes: string | null; created_at: string; updated_at: string }[] | null
      error: { message: string } | null
    }

  if (error) return dbError(error, 'fund-cash-flows')

  // Only the caller's entities' cash flows.
  const scope = await loadEntityScopeForUser(admin, user.id)
  return NextResponse.json(scopeCompanyRows(data ?? [], (scope ? scope.vehicleNames : []), 'portfolio_group'))
}

// ---------------------------------------------------------------------------
// POST — create a new fund cash flow
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json()
  const { portfolioGroup, flowDate, flowType, amount, notes } = body

  if (!portfolioGroup || !flowDate || !flowType || !amount) {
    return NextResponse.json({ error: 'portfolioGroup, flowDate, flowType, and amount are required' }, { status: 400 })
  }
  const writeScope = await loadEntityScopeForUser(admin, user.id)
  const denied = groupWriteDenial((writeScope ? writeScope.vehicleNames : []), portfolioGroup)
  if (denied) return NextResponse.json({ error: denied }, { status: 403 })

  if (!['commitment', 'called_capital', 'distribution'].includes(flowType)) {
    return NextResponse.json({ error: 'flowType must be commitment, called_capital, or distribution' }, { status: 400 })
  }

  const parsedAmount = parseFloat(amount)
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }

  const { data, error } = await admin
    .from('fund_cash_flows' as any)
    .insert({
      fund_id: membership.fund_id,
      portfolio_group: portfolioGroup,
      flow_date: flowDate,
      flow_type: flowType,
      amount: parsedAmount,
      notes: notes ?? null,
    })
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'fund-cash-flows-create')

  return NextResponse.json(data)
}

// ---------------------------------------------------------------------------
// PUT — update an existing fund cash flow by id
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json()
  const { id, flowDate, flowType, amount, notes, portfolioGroup } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const editDenied = await cashFlowDenial(admin, user.id, membership.fund_id, id, portfolioGroup)
  if (editDenied) return editDenied

  if (flowType && !['commitment', 'called_capital', 'distribution'].includes(flowType)) {
    return NextResponse.json({ error: 'flowType must be commitment, called_capital, or distribution' }, { status: 400 })
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (flowDate !== undefined) updates.flow_date = flowDate
  if (flowType !== undefined) updates.flow_type = flowType
  if (amount !== undefined) {
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    updates.amount = parsedAmount
  }
  if (notes !== undefined) updates.notes = notes
  if (portfolioGroup !== undefined) updates.portfolio_group = portfolioGroup

  const { data, error } = await admin
    .from('fund_cash_flows' as any)
    .update(updates)
    .eq('id', id)
    .eq('fund_id', membership.fund_id)
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'fund-cash-flows-update')

  return NextResponse.json(data)
}

// ---------------------------------------------------------------------------
// DELETE — remove a fund cash flow by id
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const deleteDenied = await cashFlowDenial(admin, user.id, membership.fund_id, id, undefined)
  if (deleteDenied) return deleteDenied

  const { error } = await admin
    .from('fund_cash_flows' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', membership.fund_id)

  if (error) return dbError(error, 'fund-cash-flows-delete')

  return NextResponse.json({ ok: true })
}

/**
 * A member edits or deletes only a cash flow in one of their entities, and moves it only into
 * another of theirs. 404 rather than 403 for someone else's row: the id should mean nothing to them.
 */
async function cashFlowDenial(
  admin: ReturnType<typeof createAdminClient>, userId: string, fundId: string, id: string, newGroup: string | undefined,
): Promise<NextResponse | null> {
  const scope = await loadEntityScopeForUser(admin, userId)
  const names = scope ? scope.vehicleNames : []
  if (names === null) return null
  const { data: row } = await admin.from('fund_cash_flows' as any).select('portfolio_group').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (!row || groupWriteDenial(names, (row as any).portfolio_group)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const moved = newGroup !== undefined ? groupWriteDenial(names, newGroup) : null
  return moved ? NextResponse.json({ error: moved }, { status: 403 }) : null
}
