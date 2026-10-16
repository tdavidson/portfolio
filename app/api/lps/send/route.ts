import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { generateInvestorReportPdf, generateLetterPdf } from '@/lib/lp-report-pdf'
import { outcomeResponse } from '@/lib/service-outcome'
import { sendItemRecipients, sendPortalItem, type SendPdfRenderers } from '@/lib/lps/outreach'

export const maxDuration = 300

// This route ships headless Chromium (lib/pdf-routes.mjs), so it is the one that can attach a
// statement or letter as a rendered PDF. The logic is lib/lps/outreach.ts, shared with lp_send_item.
const RENDERERS: SendPdfRenderers = {
  snapshotPdf: (admin, opts) => generateInvestorReportPdf(admin, opts),
  letterPdf: (admin, opts) => generateLetterPdf(admin, opts),
}

async function adminGate() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  if (writeCheck.role !== 'admin') return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  return { admin, userId: user.id, fundId: writeCheck.fundId as string }
}

/**
 * Admin-only: the investors an item is shared with (i.e. the valid send
 * recipients), so the GP dialog can show checkboxes for exactly those LPs.
 *
 * GET ?kind=&id=  →  { portalEnabled, itemTitle, investors: [{ id, name }] }
 */
export async function GET(req: NextRequest) {
  const ctx = await adminGate()
  if ('error' in ctx) return ctx.error
  const sp = new URL(req.url).searchParams
  return outcomeResponse(await sendItemRecipients(ctx.admin, ctx.fundId, sp.get('kind'), sp.get('id') ?? ''))
}

/**
 * Admin-only: email an LP-portal item (snapshot / letter / uploaded document) to
 * selected LPs. Authorized users delegated under each LP are Cc'd automatically.
 * Recipients are restricted to investors the item is actually shared with, so we
 * never email someone a link they can't open.
 *
 * POST { kind, id, lp_investor_ids: string[], subject, message, delivery, preview? }
 */
export async function POST(req: NextRequest) {
  const ctx = await adminGate()
  if ('error' in ctx) return ctx.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await sendPortalItem(ctx.admin, { fundId: ctx.fundId, userId: ctx.userId }, body, RENDERERS))
}
