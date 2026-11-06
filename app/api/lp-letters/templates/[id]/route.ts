import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { outcomeResponse } from '@/lib/service-outcome'
import { templateEdit, makeFundVoice } from '@/lib/lp-letters/templates'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  const { data, error } = await admin
    .from('lp_letter_templates')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', membership.fund_id)
    .maybeSingle()

  if (error) return dbError(error, 'lp-letters-templates-id')
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const body = await req.json().catch(() => ({}))
  const edit = templateEdit(body)
  if (!edit.ok) return outcomeResponse(edit)

  // "Use as the fund's voice": this template becomes the one letters are written in.
  if (body?.is_default === true) {
    if (Object.keys(edit.value).length) {
      const saved = await admin.from('lp_letter_templates').update({ ...edit.value, updated_at: new Date().toISOString() })
        .eq('id', params.id).eq('fund_id', fundId)
      if (saved.error) return dbError(saved.error, 'lp-letters-templates-id')
    }
    return outcomeResponse(await makeFundVoice(admin, fundId, params.id))
  }

  const updates: Record<string, unknown> = { ...edit.value, updated_at: new Date().toISOString() }
  if (body?.is_default === false) updates.is_default = false

  const { data, error } = await admin
    .from('lp_letter_templates')
    .update(updates)
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .select()
    .single()

  if (error) return dbError(error, 'lp-letters-templates-id')
  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const { error } = await admin
    .from('lp_letter_templates')
    .delete()
    .eq('id', params.id)
    .eq('fund_id', fundId)

  if (error) return dbError(error, 'lp-letters-templates-id')
  return NextResponse.json({ ok: true })
}
