import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAccessContext, hasAccess } from '@/lib/access/effective'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { loadDashboardTable } from '@/lib/dashboard/table'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Own-session RPC supplies membership, grants and entity scope together. The proxy keeps its
    // independent check; this context is reused throughout the handler, never cached across users.
    const access = await resolveAccessContext(supabase as never, user.id)
    if (!access || !hasAccess(access, 'portfolio', 'read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const scope = await entityScopeFor(createAdminClient(), access)
    const companies = await loadDashboardTable(supabase, scope)
    return NextResponse.json({ companies })
  } catch {
    return NextResponse.json({ error: 'Could not load portfolio table' }, { status: 500 })
  }
}
