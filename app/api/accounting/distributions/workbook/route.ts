import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts): the same per-partner capital data the
// distributions route shows, as a file. A read: nothing is written, nothing is sent.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { distributionWorkbookDocument, ISO_DATE } from '@/lib/accounting/distribution-review'

export const runtime = 'nodejs'

// GET ?group=&id=                                    — a declared distribution's calculation
// GET ?group=&total=&asOf=&method=&description=      — a preview's, before declaring
//
// The workbook: terms, tiers, where the waterfall stood before and after, each partner's line as
// return of capital, preferred return, profit and carried interest, and the checks.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const limited = await rateLimit({ key: `distribution-workbook:${user.id}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const id = sp.get('id')
  let args: Parameters<typeof distributionWorkbookDocument>[3]
  if (id) {
    args = { distributionId: id }
  } else {
    const total = Number(sp.get('total'))
    if (!Number.isFinite(total) || total <= 0) return NextResponse.json({ error: 'A positive total (or a distribution id) is required' }, { status: 400 })
    const asOfParam = sp.get('asOf') ?? ''
    const asOf = ISO_DATE.test(asOfParam) ? asOfParam : new Date().toISOString().slice(0, 10)
    args = { total, asOf, method: sp.get('method') === 'pro_rata' ? 'pro_rata' : 'waterfall', description: sp.get('description') }
  }

  const doc = await distributionWorkbookDocument(admin, gate.fundId, group, args)
  if (!doc) return NextResponse.json({ error: 'Distribution not found on this vehicle' }, { status: 404 })
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': doc.contentType,
      'Content-Disposition': `attachment; filename="${doc.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
