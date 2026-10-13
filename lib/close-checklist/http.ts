// The web transport for close checklists: authenticate, resolve the caller's fund and access, run
// the service, and turn its refusals into responses. Everything else is lib/close-checklist/service.ts,
// shared with the MCP and REST agent tools.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { CloseChecklistError, type CloseChecklistContext } from './service'

export async function closeChecklistRequest(
  need: 'read' | 'write',
  run: (ctx: CloseChecklistContext) => Promise<unknown>,
): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = need === 'write' ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  try {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    return NextResponse.json(await run({ admin, fundId: gate.fundId, userId: gate.userId, access }))
  } catch (error) {
    if (error instanceof CloseChecklistError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[close-checklist]', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function readJson(req: NextRequest): Promise<Record<string, any>> {
  const body = await req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}
