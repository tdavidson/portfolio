import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { assertReadAccess } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { buildK1WorkbookForPackage, type K1PackageRow } from '@/lib/tax/k1-export'
import { assertK1PackageVisible } from '@/lib/accounting/vehicle-visibility'

// The K-1 package as a workbook for the preparer.
//
// Read access, not write: exporting reports what is already there. The file carries TIN last
// fours and no full numbers — see lib/tax/k1-workbook.ts. The workbook itself is built in
// lib/tax/k1-export.ts, which the tax package also uses.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Per-partner K-1 figures include the GP's — see lib/tax/access.ts.
  const carryGate = await refuseWithoutCarryAccess(admin, gate, user.id)
  if (carryGate) return carryGate

  const limited = await rateLimit({ key: `k1-export:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const packageId = req.nextUrl.searchParams.get('packageId')
  if (!packageId) return NextResponse.json({ error: 'packageId is required' }, { status: 400 })
  // A package is one entity's — it must be one of the caller's.
  const hiddenPackage = await assertK1PackageVisible(admin, gate, packageId)
  if (hiddenPackage) return hiddenPackage

  const { data: pkg } = await admin
    .from('k1_packages' as any)
    .select('id, vehicle_id, tax_year, version, status, fund_character, warnings')
    .eq('fund_id', gate.fundId)
    .eq('id', packageId)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

  const { wb, filename } = await buildK1WorkbookForPackage(admin, gate.fundId, pkg as unknown as K1PackageRow)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
    },
  })
}
