import { recordAudit } from '@/lib/audit/events'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'

/**
 * Admin-only snapshot sharing (Phase 2 of LP reporting).
 *
 *   GET    → the lp_investor_ids this snapshot is currently shared with.
 *   POST   { lp_investor_ids: string[] } → set the share list (idempotent upsert + prune).
 *   DELETE ?lp_investor_id=... → unshare a single investor.
 *
 * All scoped to the admin's fund; investors are verified to belong to it.
 */

async function adminCtx(snapshotId: string) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  if (writeCheck.role !== 'admin') return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }

  const { data: snapshot } = await (admin as any)
    .from('lp_snapshots')
    .select('id, fund_id')
    .eq('id', snapshotId)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()
  if (!snapshot) return { error: NextResponse.json({ error: 'Snapshot not found' }, { status: 404 }) }

  return { admin, user, fundId: writeCheck.fundId as string, snapshotId }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, fundId, snapshotId } = ctx

  const { data, error } = await (admin as any)
    .from('lp_snapshot_shares')
    .select('lp_investor_id')
    .eq('snapshot_id', snapshotId)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'lps-snapshots-share')
  return NextResponse.json({ lp_investor_ids: (data ?? []).map((r: any) => r.lp_investor_id) })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, user, fundId, snapshotId } = ctx

  const body = await req.json().catch(() => ({}))
  const requested: string[] = Array.isArray(body.lp_investor_ids)
    ? body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string')
    : []

  // Only investors that actually belong to this fund are shareable.
  const { data: validRows } = await (admin as any)
    .from('lp_investors')
    .select('id')
    .eq('fund_id', fundId)
    .in('id', requested.length ? requested : ['00000000-0000-0000-0000-000000000000'])
  const valid = new Set((validRows ?? []).map((r: any) => r.id))
  const target = requested.filter(id => valid.has(id))

  // Prune shares no longer in the set, then upsert the rest.
  const { data: current } = await (admin as any)
    .from('lp_snapshot_shares')
    .select('lp_investor_id')
    .eq('snapshot_id', snapshotId)
    .eq('fund_id', fundId)
  const currentIds = new Set((current ?? []).map((r: any) => r.lp_investor_id))
  const toRemove = Array.from(currentIds).filter(id => !target.includes(id as string))
  const toAdd = target.filter(id => !currentIds.has(id))

  if (toRemove.length) {
    await (admin as any)
      .from('lp_snapshot_shares')
      .delete()
      .eq('snapshot_id', snapshotId)
      .eq('fund_id', fundId)
      .in('lp_investor_id', toRemove)
  }
  if (toAdd.length) {
    const rows = toAdd.map(lp_investor_id => ({
      snapshot_id: snapshotId,
      lp_investor_id,
      fund_id: fundId,
      shared_by: user.id,
    }))
    const { error: insErr } = await (admin as any).from('lp_snapshot_shares').insert(rows)
    if (insErr) return dbError(insErr, 'lps-snapshots-share')
  }
  // Who an investor report went to, and who it was taken back from — sharing locks the report's
  // figures (lib/lps/shared-lock.ts), and unsharing is how it is unlocked.
  if (toAdd.length) await recordAudit(admin, { fundId, actorId: user.id, action: 'snapshot.share', subjectType: 'lp_snapshot', subjectId: snapshotId, details: { investorIds: toAdd } })
  if (toRemove.length) await recordAudit(admin, { fundId, actorId: user.id, action: 'snapshot.unshare', subjectType: 'lp_snapshot', subjectId: snapshotId, details: { investorIds: toRemove } })

  return NextResponse.json({ ok: true, lp_investor_ids: target })
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, user, fundId, snapshotId } = ctx

  const lpInvestorId = new URL(req.url).searchParams.get('lp_investor_id') ?? ''
  if (!lpInvestorId) return NextResponse.json({ error: 'lp_investor_id is required' }, { status: 400 })

  const { error } = await (admin as any)
    .from('lp_snapshot_shares')
    .delete()
    .eq('snapshot_id', snapshotId)
    .eq('fund_id', fundId)
    .eq('lp_investor_id', lpInvestorId)
  if (error) return dbError(error, 'lps-snapshots-share')
  await recordAudit(admin, { fundId, actorId: user.id, action: 'snapshot.unshare', subjectType: 'lp_snapshot', subjectId: snapshotId, details: { investorIds: [lpInvestorId] } })
  return NextResponse.json({ ok: true })
}
