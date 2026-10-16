// The PDF half of proposed calls: a preview of one LP's notice before the call is issued, and the
// published notices an approval puts in each LP's portal. Kept apart from proposed-calls.ts because
// rendering launches headless Chromium, and only routes listed in lib/pdf-routes.mjs ship it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PURPOSE_LABEL } from './capital-call-check'
import { getProposedCall, loadCallFacts, type ProposedCallContext } from './proposed-calls'
import { generateNoticePdf } from './notice-pdf'
import { loadNoticeRegister, publishNotices } from './notices'
import { documentLetterhead, contactBlock } from '@/lib/vehicle-letterhead'
import { displayFontOf } from '@/lib/theme'
import { done, fail, type Outcome } from '@/lib/service-outcome'

/**
 * Each partner's own notice for an issued call, in their own portal. Idempotent: publishing again
 * reuses the notice a line already has. Emailing stays the Notices step it always was.
 */
export async function publishCallNotices(
  admin: SupabaseClient, ctx: ProposedCallContext & { userId: string }, callId: string,
): Promise<{ published: number; reused: number; errors: string[] }> {
  const reg = await loadNoticeRegister(admin, ctx.fundId, ctx.group, 'capital_call', callId)
  if ('error' in reg) return { published: 0, reused: 0, errors: [reg.error] }
  const out = await publishNotices(admin, { fundId: ctx.fundId, group: ctx.group, userId: ctx.userId }, reg)
  // `published` counts every notice now in a portal (the app's Approve response); `reused`, those
  // that already were, for a chat that wants to say which.
  return { published: out.published.length, reused: out.published.filter(p => p.reused).length, errors: out.errors }
}

/** One partner's notice as the proposal stands, marked DRAFT. The caller authorizes. */
export async function proposedNoticePdf(admin: SupabaseClient, ctx: ProposedCallContext, id: string, lpEntityId: string): Promise<Outcome<{ pdf: Buffer; fileName: string }>> {
  const d = await getProposedCall(admin, ctx, id)
  if (!d.ok) return d
  const line = d.value.lines.find(l => l.lpEntityId === lpEntityId)
  if (!line) return fail(404, 'That LP has no line on this proposed call.')
  const [fundRes, settingsRes, facts] = await Promise.all([
    (admin as any).from('funds').select('name, logo_url, address').eq('id', ctx.fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('currency, theme').eq('fund_id', ctx.fundId).maybeSingle(),
    loadCallFacts(admin, ctx.fundId, ctx.group),
  ])
  const letterhead = await documentLetterhead(admin, ctx.fundId, (fundRes as any).data, [ctx.group])
  const pdf = await generateNoticePdf({
    kind: 'capital_call',
    draft: true,
    displayFont: displayFontOf((settingsRes as any).data?.theme),
    fundName: letterhead.name,
    fundLogo: letterhead.logo,
    fundAddress: contactBlock(letterhead),
    currency: facts.currency,
    vehicle: ctx.group,
    partnerName: line.name,
    // Never filled in: a proposal without a date says so on its face.
    noticeDate: d.value.noticeDate ?? '[notice date missing]',
    description: d.value.description,
    amount: line.amount,
    dueDate: d.value.dueDate ?? '[due date missing]',
    wireInstructions: facts.wireInstructions,
    purposes: d.value.purposes.map(p => ({ label: p.description || PURPOSE_LABEL[p.category], amount: p.amount, basis: p.basis ?? null })),
    share: line.share,
    context: [
      { label: 'Commitment', value: line.commitment },
      { label: 'Called before this notice', value: line.calledToDate },
      { label: 'Remaining to be called after this notice', value: line.remainingAfter },
    ],
  })
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9 ._-]/g, '_')
  return done({ pdf, fileName: `DRAFT Capital Call Notice — ${safe(ctx.group)} — ${safe(line.name)}.pdf` })
}
