import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts); the vehicle is checked below.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { feeInvoiceDocument } from '@/lib/accounting/fee-invoice-pdf'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET ?group=X&id=<period> — the period's management fee invoice as a PDF.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const id = req.nextUrl.searchParams.get('id') ?? ''

  // Rendering launches a browser; cap it like the other PDF routes.
  const limited = await rateLimit({ key: `fee-invoice-pdf:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const doc = await feeInvoiceDocument(admin, gate.fundId, group, id)
  if (!doc) return NextResponse.json({ error: 'That period has no invoice.' }, { status: 404 })
  return new NextResponse(new Uint8Array(doc.body), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${doc.fileName.replace(/"/g, '')}"` },
  })
}
