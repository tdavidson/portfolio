import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { applyDefaultsToAllCompanies } from '@/lib/metrics/seed-default-metrics'
import { loadEntityScope } from '@/lib/access/entity-scope'

// Re-apply the whole profile across every company. Idempotent (insert-if-not-exists by
// (company_id, slug)) — safe to run repeatedly; a "Sync to all companies" button.

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  // Across the caller's companies only — and the count says how many of theirs, not the fund's.
  const scope = await loadEntityScope(admin, gate)
  const { inserted, companies } = await applyDefaultsToAllCompanies(admin, gate.fundId, scope.companyIds)
  return NextResponse.json({ inserted, companies })
}
