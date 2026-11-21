import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain, gated on the lp_tracking switch (lib/access/route-domains.ts): GET read, PUT
// write. The middleware has already checked the caller's grant for this route + method.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { outcomeResponse } from '@/lib/service-outcome'
import { loadSettings, saveSettings } from '@/lib/statement-review/settings'

// A vehicle's statement review settings (lib/statement-review/settings.ts).
//
//   GET ?group=…                                     → { materiality, instructions, watchAccounts, adjustments }
//   PUT { group, materiality?, instructions?, watch_accounts?, adjustments? }
//                                                    → save; a field left out keeps its value

async function resolve(req: NextRequest, write: boolean, requested: unknown) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = write ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  const group = await resolveGroupOr400(admin, gate, typeof requested === 'string' ? requested : null)
  if (group instanceof NextResponse) return { error: group }
  const id = await vehicleIdByName(admin, gate.fundId, group)
  if (!id) return { error: NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 }) }
  return { admin, user, fundId: gate.fundId, vehicleId: id }
}

export async function GET(req: NextRequest) {
  const r = await resolve(req, false, req.nextUrl.searchParams.get('group'))
  if ('error' in r) return r.error
  return NextResponse.json(await loadSettings(r.admin, r.fundId, r.vehicleId))
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await resolve(req, true, body?.group)
  if ('error' in r) return r.error
  const { group: _group, ...settings } = body ?? {}
  return outcomeResponse(await saveSettings(r.admin, { fundId: r.fundId, userId: r.user.id }, r.vehicleId, settings))
}
