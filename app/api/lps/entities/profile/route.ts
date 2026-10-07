import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts), like the entity and investor tables it writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { parseEntityProfile, parseInvestorContact } from '@/lib/lp-profile'
import { logOnboardingEvent } from '@/lib/lp-onboarding-audit'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * The investor record beyond a name.
 *
 *   PATCH { lp_entity_id, entity?: {...}, investor?: {...} }
 *     entity:   entity_type, formation_jurisdiction, address_line1, address_line2, city, region,
 *               postal_code, country, notice_email, signatories [{ name, title?, email? }],
 *               profile_notes — the facts a subscription document is filled from.
 *     investor: contact_name, contact_email, contact_phone — the relationship contact, and where
 *               an onboarding request goes when the investor has no portal account.
 *
 * Only the keys sent are changed. The entity must be this fund's; the investor written is the
 * entity's own, never one named in the body.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId
  const a = admin as any

  const body = await req.json().catch(() => ({}))
  const entityId = typeof body.lp_entity_id === 'string' ? body.lp_entity_id : ''
  if (!entityId) return NextResponse.json({ error: 'lp_entity_id is required' }, { status: 400 })
  // Only an LP with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  if (!lpVisible(lp.entityIds, entityId)) return NextResponse.json({ error: 'Entity not found in your fund' }, { status: 404 })

  const { data: entity } = await a.from('lp_entities').select('id, investor_id, onboarding_excluded').eq('id', entityId).eq('fund_id', fundId).maybeSingle()
  if (!entity) return NextResponse.json({ error: 'Entity not found in your fund' }, { status: 404 })

  const ent = body.entity != null ? parseEntityProfile(body.entity) : null
  if (ent && 'error' in ent) return NextResponse.json({ error: ent.error }, { status: 400 })
  const inv = body.investor != null ? parseInvestorContact(body.investor) : null
  if (inv && 'error' in inv) return NextResponse.json({ error: inv.error }, { status: 400 })
  if (!ent && !inv) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })

  if (ent && Object.keys(ent.patch).length > 0) {
    const { error } = await a.from('lp_entities').update({ ...ent.patch, profile_updated_at: new Date().toISOString() }).eq('id', entityId).eq('fund_id', fundId)
    if (error) return dbError(error, 'lp-entity-profile')
    if (ent.patch.onboarding_excluded !== undefined && ent.patch.onboarding_excluded !== !!entity.onboarding_excluded) {
      await logOnboardingEvent(admin, { fundId, itemId: null, lpEntityId: entityId, kind: 'all', action: ent.patch.onboarding_excluded ? 'excluded' : 'included', actorUserId: user.id })
    }
  }
  if (inv && Object.keys(inv.patch).length > 0) {
    const { error } = await a.from('lp_investors').update({ ...inv.patch, updated_at: new Date().toISOString() }).eq('id', entity.investor_id).eq('fund_id', fundId)
    if (error) return dbError(error, 'lp-entity-profile')
  }

  const [{ data: e }, { data: i }] = await Promise.all([
    a.from('lp_entities').select('id, entity_name, entity_type, formation_jurisdiction, address_line1, address_line2, city, region, postal_code, country, notice_email, signatories, profile_notes, profile_updated_at, onboarding_excluded').eq('id', entityId).single(),
    a.from('lp_investors').select('id, name, contact_name, contact_email, contact_phone').eq('id', entity.investor_id).single(),
  ])
  return NextResponse.json({ ok: true, entity: e, investor: i })
}
