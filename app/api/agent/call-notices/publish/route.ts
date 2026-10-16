import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { adminOnlyMessage, ADMIN_ONLY_ACTIONS, ADMIN_ONLY_TOOLS } from '@/lib/access/admin-only'
import { resolveVehicle, VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { getProposedCall } from '@/lib/accounting/proposed-calls'
import { withChangeSource } from '@/lib/audit/source'
import { bearerToken, verifyNoticePublish, type NoticePublishClaims, type NoticePublishResult } from '@/lib/agent/notice-publish-link'
// Both render each partner's notice PDF, so this route ships Chromium (lib/pdf-routes.mjs).
import { executePublishCallNotices } from '@/lib/pending-actions/call-notices-publish'
import { publishCallNotices } from '@/lib/accounting/proposed-call-publish'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/agent/call-notices/publish — publish a capital call's notices for a chat
 * (lib/agent/notice-publish-link.ts). Called by this deployment's own agent functions, which do not
 * ship Chromium, never by a browser.
 *
 * Authenticated by a signed, five-minute token in the Authorization header naming the fund, the
 * member and exactly what to publish. The token only says who asked for what: everything else is
 * checked again here, live — still a member, still an admin (publishing to LPs is admin-only
 * everywhere), agent access still on, the access the publish needs, the vehicle within their
 * entities. Then it runs exactly what the app runs: the Approvals page's executor for a staged
 * publish_call_notices, or the Approve button's publish for a proposed call.
 *
 * Responds `{ ok: true, result: { callId, published, reused, errors } }`, or a status with `{ error }`.
 */
export async function POST(req: NextRequest) {
  const claims = verifyNoticePublish(bearerToken(req.headers.get('authorization')) ?? '')
  if (!claims) return NextResponse.json({ error: 'This request is not authorized.' }, { status: 401 })
  return withChangeSource(claims.source ?? 'mcp', () => publish(claims))
}

async function publish(claims: NoticePublishClaims) {
  const admin = createAdminClient()
  const { fundId, userId } = claims

  const { data: membership } = await admin
    .from('fund_members').select('role').eq('fund_id', fundId).eq('user_id', userId).maybeSingle()
  if (!membership) return refuse('You are no longer a member of this fund.')
  if (!(await agentApiEnabled(admin, fundId))) return refuse('Agent access is off for this fund.')
  const role = (membership as { role: string }).role
  const label = claims.mode === 'staged' ? ADMIN_ONLY_ACTIONS.publish_call_notices : ADMIN_ONLY_TOOLS.lp_proposed_call_approve.label
  if (role !== 'admin') return refuse(adminOnlyMessage(label))

  const access = await loadAccessContext(admin, fundId, userId, role)
  // The gate each door answers to in the app: the staged action's (lp_relations, lp_portal), and
  // the proposed-calls route's (lp_capital).
  const allowed = claims.mode === 'staged'
    ? hasAccess(access, 'lp_relations', 'write', 'lp_portal')
    : hasAccess(access, 'lp_capital', 'write')
  if (!allowed) return refuse('You no longer have the access publishing these notices needs.')

  try {
    let result: NoticePublishResult
    if (claims.mode === 'staged') {
      // Resolves the vehicle through the member's access, re-reads the review, refuses a stale
      // previewToken or any blocker: what goes out is what was approved.
      result = await executePublishCallNotices({ admin, fundId, userId, access }, {
        vehicle: claims.vehicle, callId: claims.callId, lpEntityIds: claims.lpEntityIds, previewToken: claims.previewToken,
      }) as unknown as NoticePublishResult
    } else {
      const group = await resolveVehicle(admin, fundId, claims.vehicle, { access })
      // Only the call this proposal issued: the token cannot be pointed at another call.
      const proposal = await getProposedCall(admin, { fundId, group, userId }, claims.proposedCallId)
      if (!proposal.ok) return NextResponse.json({ error: proposal.error }, { status: proposal.status })
      if (proposal.value.status !== 'approved' || proposal.value.capitalCallId !== claims.callId) {
        return NextResponse.json({ error: 'That proposed call has not issued this capital call.' }, { status: 409 })
      }
      const out = await publishCallNotices(admin, { fundId, group, userId }, claims.callId)
      result = { callId: claims.callId, published: out.published - out.reused, reused: out.reused, errors: out.errors }
    }
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    if (e instanceof VehicleResolutionError) return refuse(e.message)
    const message = e instanceof Error ? e.message : 'The notices could not be published.'
    console.error('[agent/call-notices/publish]', claims.mode, message)
    return NextResponse.json({ error: message }, { status: 422 })
  }
}

function refuse(error: string) {
  return NextResponse.json({ error }, { status: 403 })
}
