import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { ConnectionError } from './index'

// Shared by the fund-connection settings routes: every one is for the fund's admins only, and acts
// as the admin's own fund (resolved from the session, never from the request).

export type AdminContext = { admin: ReturnType<typeof createAdminClient>; fundId: string; userId: string }

export async function gateConnectionAdmin(): Promise<AdminContext | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  return { admin, fundId: gate.fundId, userId: user.id }
}

const MIGRATION_HINT = 'Fund connections need a database migration (fund_connections) that has not been applied yet.'

export function connectionErrorResponse(e: unknown, context: string) {
  if (e instanceof ConnectionError) return NextResponse.json({ error: e.message }, { status: e.status })
  const err = e as { code?: string; message?: string }
  if (err?.code === '42P01' || err?.code === 'PGRST205' || /fund_connections|lp_investor_links/.test(err?.message ?? '') && /does not exist|schema cache/.test(err?.message ?? '')) {
    return NextResponse.json({ error: MIGRATION_HINT }, { status: 409 })
  }
  return dbError({ message: err?.message ?? String(e) }, context)
}
