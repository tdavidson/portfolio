// The request context the /api/views routes share: the signed-in member, their fund and their
// live access. The fund comes from the membership, never from the request.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadGateAccess } from '@/lib/access/request-context'
import type { AccessContext } from '@/lib/access/effective'

export async function viewsContext(): Promise<
  { error: NextResponse } | { admin: SupabaseClient; fundId: string; userId: string; access: AccessContext }
> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  const access = await loadGateAccess(admin, gate)
  return { admin, fundId: gate.fundId, userId: user.id, access }
}
