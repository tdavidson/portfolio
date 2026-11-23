// One partner's notice for an issued capital call, rendered exactly as publishing would render it
// but marked DRAFT and filed nowhere: what a person opens before notices go out. Renders through
// headless Chromium, so only routes in lib/pdf-routes.mjs may import it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadNoticeRegister, noticeDataFor } from './notice-register'
import { generateNoticePdf } from './notice-pdf'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export async function callNoticePreviewPdf(
  admin: SupabaseClient,
  ctx: { fundId: string; group: string },
  callId: string,
  lpEntityId: string,
): Promise<Outcome<{ pdf: Buffer; fileName: string }>> {
  const reg = await loadNoticeRegister(admin, ctx.fundId, ctx.group, 'capital_call', callId)
  if ('error' in reg) return fail(reg.status, reg.error)
  const line = reg.lines.find(l => l.lpEntityId === lpEntityId)
  if (!line) return fail(404, 'That partner has no line on this call.')
  const [notice] = await noticeDataFor(admin, ctx, reg, [line])
  const pdf = await generateNoticePdf({ ...notice.data, draft: true })
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9 ._-]/g, '_')
  return done({ pdf, fileName: `DRAFT Capital Call Notice — ${safe(ctx.group)} — ${safe(notice.partnerName)}.pdf` })
}

/** One partner's distribution notice, as publishing would render it, marked DRAFT and filed nowhere. */
export async function distributionNoticePreviewPdf(
  admin: SupabaseClient,
  ctx: { fundId: string; group: string },
  distributionId: string,
  lpEntityId: string,
): Promise<Outcome<{ pdf: Buffer; fileName: string }>> {
  const reg = await loadNoticeRegister(admin, ctx.fundId, ctx.group, 'distribution', distributionId)
  if ('error' in reg) return fail(reg.status, reg.error)
  const line = reg.lines.find(l => l.lpEntityId === lpEntityId)
  if (!line) return fail(404, 'That partner has no line on this distribution.')
  const [notice] = await noticeDataFor(admin, ctx, reg, [line])
  const pdf = await generateNoticePdf({ ...notice.data, draft: true })
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9 ._-]/g, '_')
  return done({ pdf, fileName: `DRAFT Distribution Notice — ${safe(ctx.group)} — ${safe(notice.partnerName)}.pdf` })
}
