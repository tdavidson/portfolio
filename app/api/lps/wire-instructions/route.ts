import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts): paying partners. Every POST is admin-only
// (lib/access/admin-only.ts): entering, verifying and revealing bank details.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'
import { rateLimit } from '@/lib/rate-limit'
import { recordAudit } from '@/lib/audit/events'
import { loadFullWires, loadWireSummaries, saveWire, verifyWire } from '@/lib/lps/wire-instructions'

export const runtime = 'nodejs'

// GET ?lp_entity_ids=a,b   — masked bank details per entity (last four digits only)
//
// POST { action: 'save', lp_entity_id, wire: { beneficiaryName, bankName, accountNumber, routingNumber | swiftCode, ... } }
// POST { action: 'verify', lp_entity_id, callback: { calledName, calledNumber, calledOn, note? } }
// POST { action: 'reveal', lp_entity_id, reason }   — the full numbers, logged with the reason
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const requested = (req.nextUrl.searchParams.get('lp_entity_ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const lp = await loadLpScope(admin, gate)
  const ids = requested.length > 0 ? requested.filter(id => lpVisible(lp.entityIds, id)) : (lp.entityIds ?? undefined)
  const wires = await loadWireSummaries(admin, gate.fundId, ids)
  return NextResponse.json({ wires: Object.fromEntries(wires) })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const limited = await rateLimit({ key: `wire-instructions:${user.id}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const body = await req.json().catch(() => ({}))
  const entityId = typeof body?.lp_entity_id === 'string' ? body.lp_entity_id : ''
  if (!entityId) return NextResponse.json({ error: 'lp_entity_id is required' }, { status: 400 })
  const lp = await loadLpScope(admin, gate)
  if (!lpVisible(lp.entityIds, entityId)) return NextResponse.json({ error: 'That LP entity is not in your entities.' }, { status: 404 })
  const audit = (action: 'lp_wire.save' | 'lp_wire.verify' | 'lp_wire.reveal', details: Record<string, unknown>, reason?: string | null) =>
    recordAudit(admin, { fundId: gate.fundId, actorId: user.id, action, subjectType: 'lp_entity', subjectId: entityId, reason: reason ?? null, details })

  if (body?.action === 'save') {
    const out = await saveWire(admin, gate.fundId, entityId, user.id, body?.wire ?? {})
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
    // Field names only: never the numbers.
    if (out.value.created || out.value.changed.length > 0) {
      await audit('lp_wire.save', { created: out.value.created, changed: out.value.changed, verificationCleared: out.value.verificationCleared })
    }
    return NextResponse.json(out.value)
  }

  if (body?.action === 'verify') {
    const out = await verifyWire(admin, gate.fundId, entityId, user.id, body?.callback ?? {})
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
    await audit('lp_wire.verify', { note: out.value.verificationNote })
    return NextResponse.json({ summary: out.value })
  }

  if (body?.action === 'reveal') {
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
    if (!reason) return NextResponse.json({ error: 'Say why you need the full numbers; it is logged.' }, { status: 400 })
    const full = (await loadFullWires(admin, gate.fundId, [entityId])).get(entityId)
    if (!full) return NextResponse.json({ error: 'No bank details are on file for this entity.' }, { status: 404 })
    await audit('lp_wire.reveal', {}, reason)
    return NextResponse.json({ accountNumber: full.accountNumber, routingNumber: full.routingNumber }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({ error: "action must be 'save', 'verify' or 'reveal'" }, { status: 400 })
}
