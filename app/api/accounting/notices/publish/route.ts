import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts) — publishing is what goes OUT to an LP,
// gated exactly like the capital-account statement it sits beside.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { type NoticeKind } from '@/lib/accounting/notice-pdf'
import { loadNoticeRegister, publishNotices, previewNoticeRecipients, emailNotices, testNoticeEmail, type NoticeDelivery } from '@/lib/accounting/notices'
import { listDeliveries, lastSentByItem } from '@/lib/lp-deliveries'

export const runtime = 'nodejs'
// Each notice launches headless Chrome; a vehicle with twenty partners needs room.
export const maxDuration = 300

// POST — notices for a DECLARED call or distribution.
//
//   { kind: 'capital_call' | 'distribution', id, group?, lpEntityIds?,
//     regenerate?: boolean,                       — render fresh PDFs even where one exists
//     email?: { subject?, message?, delivery: 'link' | 'attachment' | 'both' },
//     preview?: boolean,                          — with email: who would be emailed, no send
//     test?: boolean }                            — with email: send one partner's email, DRAFT
//                                                   notice attached, to the sender only; publishes nothing
//
// Without `email`: publish only — one PDF per partner in their portal (idempotent). With it:
// publish, then email each partner their notice, logging every send. `preview` answers the
// review step before anything goes out.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const kind: NoticeKind = body?.kind === 'distribution' ? 'distribution' : 'capital_call'
  const id = String(body?.id ?? '')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const lpEntityIds: string[] | undefined = Array.isArray(body?.lpEntityIds) && body.lpEntityIds.length > 0 ? body.lpEntityIds : undefined

  const reg = await loadNoticeRegister(admin, gate.fundId, group, kind, id)
  if ('error' in reg) return NextResponse.json({ error: reg.error }, { status: reg.status })

  const email = body?.email && typeof body.email === 'object'
    ? {
        subject: typeof body.email.subject === 'string' ? body.email.subject : null,
        message: typeof body.email.message === 'string' ? body.email.message : null,
        delivery: (['link', 'attachment', 'both'].includes(body.email.delivery) ? body.email.delivery : 'link') as NoticeDelivery,
      }
    : null

  if (body?.preview === true) {
    const preview = await previewNoticeRecipients(admin, gate.fundId, group, reg, lpEntityIds)
    const sentBefore = lastSentByItem(await listDeliveries(admin, gate.fundId, 'notice', reg.lines.map(l => l.id)))
    const byEntity = new Map(reg.lines.map(l => [l.lpEntityId, l]))
    return NextResponse.json({
      preview: true,
      ...preview,
      recipients: preview.recipients.map(r => {
        const line = byEntity.get(r.lpEntityId)
        const last = line ? sentBefore.get(line.id) : undefined
        return { ...r, published: !!line?.noticeDocumentId, lastSentAt: last?.sentAt ?? null }
      }),
    })
  }

  const ctx = { fundId: gate.fundId, group, userId: user.id }

  if (body?.test === true) {
    if (!email) return NextResponse.json({ error: 'A test needs the email settings' }, { status: 400 })
    const t = await testNoticeEmail(admin, ctx, reg, lpEntityIds, email)
    if ('error' in t) return NextResponse.json({ error: t.error }, { status: 400 })
    return NextResponse.json(t)
  }

  const { published, errors } = await publishNotices(admin, ctx, reg, { lpEntityIds, regenerate: body?.regenerate === true })

  if (!email) return NextResponse.json({ count: published.length, published, errors })

  const sendable = published.filter(p => p.investorId)
  const sent = await emailNotices(admin, ctx, reg, sendable, email)
  if ('error' in sent) return NextResponse.json({ error: sent.error, count: published.length, published, errors }, { status: 400 })
  return NextResponse.json({ count: published.length, published, errors, ...sent })
}
