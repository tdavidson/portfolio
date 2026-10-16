import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { buildStatementPackage } from '@/lib/accounting/statement-package'

// GET — the full statement package for a vehicle, scoped to a statement period:
//   ?preset=this_quarter|last_quarter|ytd|prior_year|itd   — or —
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// The period means different things to different statements, and that distinction
// is the whole point:
//   • Balance sheet, trial balance, SOI  → POINT IN TIME, cumulative to `end`.
//   • Income statement, cash flows       → OVER TIME, only activity within the window.
//   • Capital accounts                   → both: opens with the balance carried in.
//
// The load + compute lives in buildStatementPackage so the on-screen statements and
// the Excel workpaper export (statements/export) can never disagree.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  // The statement of changes in partners' capital used to be withheld here from a caller without
  // lp_capital. It was theatre: the trial balance below ships the same partners and the same
  // balances, because a fund's chart has one NAMED capital account per partner. Reading the books
  // is reading partner capital — so `accounting` now implies `lp_capital` outright
  // (see DOMAIN_META.lp_capital.impliedBy) and this package is whole again.

  const params = new URLSearchParams(req.nextUrl.searchParams)
  const scheduleOnly = params.get('section') === 'soi'
  if (scheduleOnly) params.delete('compare')
  const pkg = await buildStatementPackage(admin, gate.fundId, group, params)
  if (scheduleOnly) return NextResponse.json({ scheduleOfInvestments: pkg.payload.scheduleOfInvestments })
  return NextResponse.json(pkg.comparisons ? { ...pkg.payload, comparisons: pkg.comparisons } : pkg.payload)
}
