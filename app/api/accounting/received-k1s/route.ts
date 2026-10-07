import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { dbError } from '@/lib/api-error'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadK1Dependencies } from '@/lib/tax/year-close'
import { K1_EXPECTED_HOLDING_TYPE } from '@/lib/tax/received-k1s'
import { assertVehicleVisible } from '@/lib/accounting/vehicle-visibility'
import { loadAccessContext } from '@/lib/access/effective'

// K-1s owed to us by the funds we hold.
//
// The EXPECTATION is derived from the holdings — every fund holding files a partnership return —
// so a newly added fund appears in the chase list without anyone remembering to add it. What is
// stored here is only the departure from that: it arrived, it was amended, or it is not owed.

const STATUSES = ['expected', 'received', 'amended', 'not_expected']

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const taxYear = Number(req.nextUrl.searchParams.get('taxYear'))
  if (!Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'A four-digit taxYear is required' }, { status: 400 })
  }

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}"` }, { status: 400 })

  return NextResponse.json(await loadK1Dependencies(admin, gate.fundId, vehicleId, taxYear))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const companyId = typeof body?.companyId === 'string' ? body.companyId : ''
  const taxYear = Number(body?.taxYear)
  if (!companyId || !Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'companyId and taxYear are required' }, { status: 400 })
  }
  if (!STATUSES.includes(body?.status)) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 })
  }

  // The holding must belong to this fund AND be a fund holding. Filtering the discriminator
  // here is stricter than an allowlist would be: only a partnership files a K-1, so marking a
  // portfolio company as owing one is a mistake worth refusing rather than storing.
  const { data: company } = await admin
    .from('companies' as any)
    .select('id')
    .eq('fund_id', gate.fundId)
    .eq('id', companyId)
    .eq('holding_type', K1_EXPECTED_HOLDING_TYPE)
    .maybeSingle()
  if (!company) {
    return NextResponse.json(
      { error: 'Unknown holding for this fund, or not a fund holding — only a partnership files a K-1.' },
      { status: 400 },
    )
  }

  const group = typeof body?.group === 'string' ? body.group : null
  // Only into one of the caller's entities.
  if (group) {
    const hidden = await assertVehicleVisible(admin, gate, group)
    if (hidden) return hidden
  } else {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    if (!access.vehicles.all) return NextResponse.json({ error: 'Choose which of your entities received this K-1.' }, { status: 403 })
  }
  const vehicleId = group ? await vehicleIdByName(admin, gate.fundId, group) : null

  const { data, error } = await admin
    .from('received_k1s' as any)
    .upsert(
      {
        fund_id: gate.fundId,
        vehicle_id: vehicleId,
        company_id: companyId,
        tax_year: taxYear,
        status: body.status,
        received_date: typeof body?.receivedDate === 'string' ? body.receivedDate : null,
        reported_ordinary_income: body?.reportedOrdinaryIncome ?? null,
        reported_capital_gain: body?.reportedCapitalGain ?? null,
        reported_ending_capital: body?.reportedEndingCapital ?? null,
        notes: typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,tax_year' },
    )
    .select('*')
    .single()
  if (error) return dbError(error, 'received-k1s')
  return NextResponse.json(data)
}
