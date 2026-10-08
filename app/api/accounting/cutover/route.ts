import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { previewCutover, applyCutover, revertCutover } from '@/lib/accounting/snapshot-cutover'
import { loadAccessContext } from '@/lib/access/effective'

// The LP-snapshot → capital-events cutover.
//
// FUND-WIDE, not vehicle-scoped: the whole point is to move every vehicle onto capital
// tracking in one pass, and the preview has to show what happens to each of them —
// including the ones it refuses to touch, and why.
//
//   GET  ?snapshot=<id>   → the plan. Writes nothing.
//   POST { snapshot? }    → apply it. Idempotent; rerunning is a no-op, not a double-count.
//   DELETE ?snapshot=<id> → reverse it exactly.
//
// Admin only. These rows ARE the LP's capital account for an unbooked vehicle, so they
// carry the same weight as a posting.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // A preview reads; it doesn't need write privilege. (Using the write helper here would newly
  // refuse the read-only demo, which this GET never refused.)
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Cutover reads and writes every vehicle's LP positions at once: unscoped callers only.
  if (!(await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)).vehicles.all) {
    return NextResponse.json({ error: 'Cutover covers every entity, so it needs access to all of them.' }, { status: 403 })
  }

  const snapshotId = req.nextUrl.searchParams.get('snapshot') ?? undefined
  try {
    return NextResponse.json(await previewCutover(admin, gate.fundId, snapshotId))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Preview failed' }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Cutover reads and writes every vehicle's LP positions at once: unscoped callers only.
  if (!(await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)).vehicles.all) {
    return NextResponse.json({ error: 'Cutover covers every entity, so it needs access to all of them.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  try {
    const result = await applyCutover(admin, gate.fundId, user.id, body?.snapshot)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Cutover failed' }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Cutover reads and writes every vehicle's LP positions at once: unscoped callers only.
  if (!(await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)).vehicles.all) {
    return NextResponse.json({ error: 'Cutover covers every entity, so it needs access to all of them.' }, { status: 403 })
  }

  const snapshotId = req.nextUrl.searchParams.get('snapshot')
  if (!snapshotId) return NextResponse.json({ error: 'snapshot is required' }, { status: 400 })
  try {
    return NextResponse.json(await revertCutover(admin, gate.fundId, snapshotId))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Revert failed' }, { status: 400 })
  }
}
