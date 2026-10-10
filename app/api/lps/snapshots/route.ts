import { lockedMessage, reportShareCount } from '@/lib/lps/shared-lock'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'

// GET — list all snapshots for this fund
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Use user-scoped client for membership check (RLS enforces user can only see own memberships)
  const { data: membership } = await (supabase as any)
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle() as { data: { fund_id: string; role: string } | null }

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('lp_snapshots' as any)
    .select('*')
    .eq('fund_id', membership.fund_id)
    .order('as_of_date', { ascending: false, nullsFirst: false }) as { data: any[] | null; error: any }

  if (error) return dbError(error, 'lp-snapshots')

  return NextResponse.json({ snapshots: data ?? [], role: membership.role })
}

// POST — create a new snapshot
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json()
  const { name, asOfDate } = body

  if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (name.trim().length > 200) return NextResponse.json({ error: 'name too long (max 200 chars)' }, { status: 400 })
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return NextResponse.json({ error: 'asOfDate must be YYYY-MM-DD format' }, { status: 400 })
  }

  const { data, error } = await admin
    .from('lp_snapshots' as any)
    .insert({
      fund_id: writeCheck.fundId,
      name: name.trim(),
      as_of_date: asOfDate || null,
    })
    .select('*')
    .single() as { data: any; error: any }

  if (error) return dbError(error, 'lp-snapshots-create')

  return NextResponse.json(data, { status: 201 })
}

// PUT — update a snapshot (name, date, description)
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json()
  const { id, name, asOfDate, description, footerNote, associatesCalcEnabled } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return NextResponse.json({ error: 'asOfDate must be YYYY-MM-DD format' }, { status: 400 })
  }

  if (asOfDate !== undefined || associatesCalcEnabled !== undefined) {
    const shares = await reportShareCount(admin, writeCheck.fundId, id)
    if (shares > 0) return NextResponse.json({ error: lockedMessage(shares, "this report's date and calculation") }, { status: 409 })
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (name.trim().length > 200) return NextResponse.json({ error: 'name too long (max 200 chars)' }, { status: 400 })
    updates.name = name.trim()
  }
  if (asOfDate !== undefined) updates.as_of_date = asOfDate || null
  if (description !== undefined) {
    if (typeof description !== 'string') return NextResponse.json({ error: 'description must be a string' }, { status: 400 })
    if (description.length > 10000) return NextResponse.json({ error: 'description too long (max 10000 chars)' }, { status: 400 })
    updates.description = description
  }
  if (footerNote !== undefined) {
    if (typeof footerNote !== 'string') return NextResponse.json({ error: 'footerNote must be a string' }, { status: 400 })
    if (footerNote.length > 2000) return NextResponse.json({ error: 'footerNote too long (max 2000 chars)' }, { status: 400 })
    updates.footer_note = footerNote
  }
  if (associatesCalcEnabled !== undefined) {
    if (typeof associatesCalcEnabled !== 'boolean') return NextResponse.json({ error: 'associatesCalcEnabled must be a boolean' }, { status: 400 })
    updates.associates_calc_enabled = associatesCalcEnabled
  }

  const { data, error } = await admin
    .from('lp_snapshots' as any)
    .update(updates)
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)
    .select('*')
    .single() as { data: any; error: any }

  if (error) return dbError(error, 'lp-snapshots-update')

  return NextResponse.json(data)
}

// DELETE — remove a snapshot (cascades to its investments)
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const shares = await reportShareCount(admin, writeCheck.fundId, id)
  if (shares > 0) return NextResponse.json({ error: lockedMessage(shares, 'deleting it') }, { status: 409 })

  const { error } = await admin
    .from('lp_snapshots' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)

  if (error) return dbError(error, 'lp-snapshots-delete')

  return NextResponse.json({ ok: true })
}
