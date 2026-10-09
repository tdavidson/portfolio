// The web transport's half of the budgeting module: authenticate, resolve the caller's fund and
// vehicle, build the service context, and turn service errors into responses. Everything else is
// lib/forecast/service.ts, shared with MCP and the Analyst.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadAccessContext } from '@/lib/access/effective'
import { ForecastError, type ForecastServiceContext } from './service'

export async function forecastRequest(
  req: NextRequest,
  need: 'read' | 'write',
  run: (ctx: ForecastServiceContext, vehicle: string) => Promise<unknown>,
  /** Where the vehicle name comes from: `?group=` (default) or a parsed JSON body's `group`. */
  requestedGroup?: string | null,
): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = need === 'write' ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Resolve (and check) the entity: one of the caller's, and a manco only with that grant.
  const group = await resolveGroupOr400(admin, gate, requestedGroup ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  try {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    const result = await run({ admin, fundId: gate.fundId, userId: gate.userId, access }, group)
    return result instanceof NextResponse ? result : NextResponse.json(result)
  } catch (error) {
    if (error instanceof ForecastError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[forecast]', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function readJson(req: NextRequest): Promise<Record<string, any>> {
  const body = await req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}
