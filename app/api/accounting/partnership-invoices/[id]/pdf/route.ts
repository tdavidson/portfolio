import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts); both entities are checked below.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { getPartnershipInvoice } from '@/lib/accounting/partnership-invoices'
import { partnershipInvoiceDocument } from '@/lib/accounting/partnership-invoice-pdf'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET — the invoice as a PDF, with every receipt behind it appended as backup.
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const inv = await getPartnershipInvoice(admin, gate.fundId, id)
  if (!inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  for (const name of [inv.from.name, inv.to.name]) {
    const ok = await resolveGroupOr400(admin, gate, name)
    if (ok instanceof NextResponse) return ok
  }

  // Rendering launches a browser; cap it like the other PDF routes.
  const limited = await rateLimit({ key: `partnership-invoice-pdf:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  const doc = await partnershipInvoiceDocument(admin, gate.fundId, id)
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.fileName.replace(/"/g, '')}"`,
      // Receipts that are not PDFs or images (a plain-text e-receipt) cannot be appended.
      ...(doc.skipped.length ? { 'X-Receipts-Not-Appended': String(doc.skipped.length) } : {}),
    },
  })
}
