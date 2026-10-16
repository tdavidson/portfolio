import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant; this resolves identity and the vehicle.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadPostedLedger, loadLedgerChart } from '@/lib/accounting/load'
import { accountRegister, findAccount } from '@/lib/accounting/register'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { booksForBasis, basisFromParam } from '@/lib/accounting/statement-package'

// GET — one account's register for the vehicle: the balance carried in, every posted line in the
// window with its counter-accounts and running balance, and the closing balance.
//
//   ?account=<code or id>                — which account. Omit it to get just the chart, for a picker.
//   ?preset=this_quarter|…|itd  — or —  ?start=YYYY-MM-DD&end=YYYY-MM-DD   (same as /statements)
//
// Reads the POSTED ledger through the same loader the statements use, so the closing balance
// here is the trial balance there, to the cent. Drafts are not on a register: they are not on
// the books.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const preset = sp.get('preset') as PeriodPreset | null
  const asOf = sp.get('asOf')
  const asOfDate = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? new Date(asOf) : undefined
  const period = preset && preset !== 'custom'
    ? resolvePeriod(preset, asOfDate)
    : customPeriod(sp.get('start'), sp.get('end') ?? asOf)

  // ?basis=tax reads the ledger plus the book-to-tax overlay, as the statements do.
  const ref = sp.get('account')
  const { accounts, sourcedPostings } = ref ? await loadPostedLedger(
    admin, gate.fundId, group, undefined, undefined, undefined, booksForBasis(basisFromParam(sp.get('basis'))),
  ) : { accounts: await loadLedgerChart(admin, gate.fundId, group), sourcedPostings: [] }
  const chart = accounts
    .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lpEntityId: a.lpEntityId ?? null, companyId: a.companyId ?? null }))
    .sort((a, b) => a.code.localeCompare(b.code))

  if (!ref) return NextResponse.json({ period, accounts: chart, register: null })

  const account = findAccount(accounts, ref)
  if (!account) return NextResponse.json({ error: `No account "${ref}" in this vehicle's chart` }, { status: 404 })

  const byId = new Map(accounts.map(a => [a.id, a]))
  const register = accountRegister(account, sourcedPostings, byId, period)
  return NextResponse.json({ period, accounts: chart, register })
}
