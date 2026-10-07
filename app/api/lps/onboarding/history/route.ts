import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { ONBOARDING_KIND_LABEL, isOnboardingKind } from '@/lib/lp-onboarding'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * The audit trail for one entity's onboarding: every upload, verification, send-back, waiver and
 * reset, who did it and when.
 *
 *   GET ?lp_entity_id=… → events, newest first, with the actor named (a fund user's email or the
 *   LP account's email).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const a = admin as any

  const entityId = req.nextUrl.searchParams.get('lp_entity_id') ?? ''
  if (!entityId) return NextResponse.json({ error: 'lp_entity_id is required' }, { status: 400 })
  const lp = await loadLpScope(admin, gate)
  if (!lpVisible(lp.entityIds, entityId)) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })

  const { data, error } = await a
    .from('lp_onboarding_events')
    .select('id, kind, action, from_status, to_status, note, document_id, actor_user_id, created_at, lp_accounts(email, kind), lp_documents(file_name)')
    .eq('fund_id', gate.fundId).eq('lp_entity_id', entityId)
    .order('created_at', { ascending: false }).limit(200)
  if (error) return dbError(error, 'onboarding-history')

  // Fund users' emails, looked up once each.
  const userIds = Array.from(new Set(((data ?? []) as any[]).map(r => r.actor_user_id).filter(Boolean))) as string[]
  const emailByUser = new Map<string, string>()
  for (const id of userIds) {
    try {
      const { data: { user: u } } = await admin.auth.admin.getUserById(id)
      if (u?.email) emailByUser.set(id, u.email)
    } catch { /* leave unnamed */ }
  }

  const events = ((data ?? []) as any[]).map(r => {
    const acct = Array.isArray(r.lp_accounts) ? r.lp_accounts[0] : r.lp_accounts
    const doc = Array.isArray(r.lp_documents) ? r.lp_documents[0] : r.lp_documents
    return {
      id: r.id,
      kind: r.kind,
      kindLabel: isOnboardingKind(r.kind as string) ? ONBOARDING_KIND_LABEL[r.kind as keyof typeof ONBOARDING_KIND_LABEL] : String(r.kind),
      action: r.action,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      note: r.note,
      fileName: doc?.file_name ?? null,
      actor: r.actor_user_id ? (emailByUser.get(r.actor_user_id) ?? 'fund user') : (acct?.email ? `${acct.email}${acct.kind === 'authorized_user' ? ' (authorized user)' : ''}` : null),
      actorSide: r.actor_user_id ? 'fund' : acct?.kind === 'authorized_user' ? 'advisor' : 'lp',
      at: r.created_at,
    }
  })
  return NextResponse.json({ events })
}
