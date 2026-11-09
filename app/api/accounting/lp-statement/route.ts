import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { lpStatement } from '@/lib/accounting/capital-calls'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { vehicleLetterheadDetail } from '@/lib/vehicle-letterhead'
import { parseStatementBasis } from '@/lib/accounting/statement-basis'
import { vehicleStatementBasis } from '@/lib/accounting/statement-basis-default'

// GET ?lp=<lpEntityId> — one LP's capital statement: the roll-forward in three columns (statement
// period, year to date, inception to date), the commitment summary, the letterhead the PDF prints,
// and the period's transactions. Optional ?preset= / ?start=&end= scopes the period column; year to
// date runs from January 1 of the period end's year. Optional ?basis=fair_value|cost|cash_only picks
// the basis (lib/accounting/statement-basis.ts); without it, the vehicle's default.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const sp = req.nextUrl.searchParams
  const lp = sp.get('lp')
  if (!lp) return NextResponse.json({ error: 'lp is required' }, { status: 400 })

  const preset = sp.get('preset') as PeriodPreset | null
  const period = preset && preset !== 'custom'
    ? resolvePeriod(preset)
    : customPeriod(sp.get('start'), sp.get('end'))

  const defaultBasis = await vehicleStatementBasis(admin, gate.fundId, group)
  const basis = parseStatementBasis(sp.get('basis'), defaultBasis)
  if (typeof basis !== 'string') return NextResponse.json({ error: basis.error }, { status: 400 })

  const [first, letterhead] = await Promise.all([
    lpStatement(admin, gate.fundId, group, lp, period, basis),
    vehicleLetterheadDetail(admin, gate.fundId, group),
  ])
  // A partner on administrator snapshots can only be shown on fair value. When that basis came from
  // the vehicle's default rather than the request, show fair value (the page hides the toggle for
  // them); a basis asked for by name is refused.
  const result = 'error' in first && first.code === 'basis_unavailable' && !sp.get('basis')
    ? await lpStatement(admin, gate.fundId, group, lp, period, 'fair_value')
    : first
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.code === 'basis_unavailable' ? 400 : 404 })
  return NextResponse.json({ ...result, period, letterhead, defaultBasis })
}
