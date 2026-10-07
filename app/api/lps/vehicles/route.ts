import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScope } from '@/lib/access/entity-scope'

/**
 * Admin-only: the distinct investment vehicles (lp_investments.portfolio_group)
 * for the fund. A "vehicle" isn't a first-class table — it's the free-text
 * portfolio_group on investment rows — so we derive the list the same way the
 * LP batch editor does: distinct values across all snapshots. Used to populate
 * the "share with a vehicle" picker for LP documents.
 */
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = await assertReadAccess(admin, user.id)
  if (access instanceof NextResponse) return access

  const { data, error } = await (admin as any)
    .from('lp_investments')
    .select('portfolio_group')
    .eq('fund_id', access.fundId)
  if (error) return dbError(error, 'lps-vehicles')

  const vehicles = Array.from(
    new Set(((data ?? []) as { portfolio_group: string | null }[])
      .map(r => (r.portfolio_group ?? '').trim())
      .filter(Boolean))
  ).sort((a, b) => a.localeCompare(b))

  // Only the caller's entities.
  const scope = await loadEntityScope(admin, access)
  return NextResponse.json({ vehicles: scope.vehicleNames === null ? vehicles : vehicles.filter(v => scope.vehicleNames!.includes(v)) })
}
