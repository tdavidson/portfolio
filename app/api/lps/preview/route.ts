import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { overviewFromLive, type LiveOverviewRow } from '@/lib/lp-overview'
import { lastDataDates } from '@/lib/accounting/lp-positions'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'

/** Portfolio overview for one investor — LIVE (the same data /lps shows, sliced to this LP). */
async function computeOverview(admin: any, fundId: string, investorId: string) {
  const { data: entities } = await admin
    .from('lp_entities').select('id').eq('fund_id', fundId).eq('investor_id', investorId)
  const entityIds = new Set(((entities ?? []) as any[]).map(e => e.id as string))
  if (entityIds.size === 0) return null
  const report = await generateLiveReport(admin, fundId)
  const mine = report.rows.filter((r: any) => entityIds.has(r.entity_id))
  const rows: LiveOverviewRow[] = mine.map((r: any) => ({
    portfolio_group: r.portfolio_group, commitment: r.commitment, paid_in_capital: r.paid_in_capital, distributions: r.distributions, nav: r.nav,
  }))
  const groups = Array.from(new Set(mine.map((r: any) => r.portfolio_group as string)))
  const vehicleDates = await lastDataDates(admin, fundId, groups)
  return overviewFromLive(rows, vehicleDates)
}

/**
 * Admin-only "view as LP" preview (read-only). Given an investor in the admin's
 * own fund, returns exactly what that LP would see in their portal — snapshots,
 * finalized letters, and documents (fund-wide + investor-scoped) — scoped to the
 * admin's fund. This is NOT impersonation: the admin stays themselves; their own
 * fund-admin role authorizes previewing their fund's LP view. The portal's
 * lp_portal_enabled gate is deliberately ignored here so admins can preview
 * before turning the portal on; the live state is returned as `portal_enabled`.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Any fund member may preview the LP portal (read-only); the demo viewer uses this.
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  // Previewing the portal shows an investor everything they hold, in every entity — so only someone
  // who can see every entity may preview it (the sidebar already offers it to admins only).
  const previewScope = await loadEntityScopeForUser(admin, user.id)
  if (!previewScope || !canSeeVehicle(previewScope.access, null)) {
    return NextResponse.json({ error: 'Previewing the LP portal needs access to every entity.' }, { status: 403 })
  }
  const fundId = membership.fund_id

  // Fund branding, so the preview header mirrors the real portal chrome.
  const { data: fundRow } = await (admin as any).from('funds').select('name, logo_url').eq('id', fundId).maybeSingle()
  const fund = { name: (fundRow?.name as string) ?? 'Investor Portal', logo_url: (fundRow?.logo_url as string | null) ?? null }

  const investorId = new URL(req.url).searchParams.get('investor_id') ?? ''

  // Sample mode — no real LP needed. Renders a representative portal so admins
  // can preview the layout before any LPs are added: the fund's most recent
  // reports + letters and its fund-wide documents, as examples.
  if (!investorId || investorId === 'sample') {
    const { data: ef } = await (admin as any).from('fund_settings').select('lp_portal_enabled, currency').eq('fund_id', fundId).maybeSingle()
    const [{ data: snaps }, { data: lets }, { data: fundDocs }, { data: rep }] = await Promise.all([
      (admin as any).from('lp_snapshots').select('id, name, as_of_date').eq('fund_id', fundId).order('as_of_date', { ascending: false }).limit(10),
      (admin as any).from('lp_letters').select('id, period_label, period_year, period_quarter, status').eq('fund_id', fundId).order('period_year', { ascending: false }).limit(10),
      (admin as any).from('lp_documents').select('id, title, file_name, size_bytes, category, doc_date, uploaded_at, scope, storage_path').eq('fund_id', fundId).eq('scope', 'fund'),
      // A representative investor with real positions, so the sample overview isn't empty.
      (admin as any).from('lp_investments').select('lp_entities!inner(investor_id)').eq('fund_id', fundId).limit(1),
    ])
    const repId = (rep ?? [])[0]?.lp_entities?.investor_id as string | undefined
    const overview = repId ? await computeOverview(admin, fundId, repId) : null
    return NextResponse.json({
      investor: { id: 'sample', name: 'Sample investor' },
      fund,
      currency: ef?.currency ?? 'USD',
      portal_enabled: !!ef?.lp_portal_enabled,
      overview,
      snapshots: snaps ?? [],
      letters: (lets ?? []).filter((l: any) => l && l.status !== 'generating'),
      documents: (fundDocs ?? []).map((d: any) => ({ ...d, sample: String(d.storage_path ?? '').startsWith('sample/'), storage_path: undefined })),
    })
  }

  const { data: investor } = await (admin as any)
    .from('lp_investors').select('id, name').eq('id', investorId).eq('fund_id', fundId).maybeSingle()
  if (!investor) return NextResponse.json({ error: 'Investor not found in your fund' }, { status: 404 })

  const { data: ef } = await (admin as any).from('fund_settings').select('lp_portal_enabled, currency').eq('fund_id', fundId).maybeSingle()
  const overview = await computeOverview(admin, fundId, investorId)

  const [{ data: snapShares }, { data: letterShares }, { data: fundDocs }, { data: invDocShares }] = await Promise.all([
    (admin as any).from('lp_snapshot_shares').select('lp_snapshots(id, name, as_of_date)').eq('lp_investor_id', investorId).eq('fund_id', fundId),
    (admin as any).from('lp_letter_shares').select('lp_letters(id, period_label, period_year, period_quarter, status)').eq('lp_investor_id', investorId).eq('fund_id', fundId),
    (admin as any).from('lp_documents').select('id, title, file_name, size_bytes, category, doc_date, uploaded_at, scope, storage_path').eq('fund_id', fundId).eq('scope', 'fund'),
    (admin as any).from('lp_document_shares').select('lp_documents(id, title, file_name, size_bytes, category, doc_date, uploaded_at, scope, storage_path)').eq('lp_investor_id', investorId),
  ])

  const snapshots = (snapShares ?? [])
    .map((s: any) => s.lp_snapshots)
    .filter(Boolean)
    .sort((a: any, b: any) => (b.as_of_date ?? '').localeCompare(a.as_of_date ?? ''))

  const letters = (letterShares ?? [])
    .map((s: any) => s.lp_letters)
    .filter((l: any) => l && l.status !== 'generating')
    .sort((a: any, b: any) => b.period_year - a.period_year || b.period_quarter - a.period_quarter)

  const documents = [
    ...(fundDocs ?? []),
    ...(invDocShares ?? []).map((s: any) => s.lp_documents).filter((d: any) => d && d.scope === 'investor'),
  ].map((d: any) => ({ ...d, sample: String(d.storage_path ?? '').startsWith('sample/'), storage_path: undefined }))

  return NextResponse.json({
    investor: { id: investor.id, name: investor.name },
    fund,
    currency: ef?.currency ?? 'USD',
    portal_enabled: !!ef?.lp_portal_enabled,
    overview,
    snapshots,
    letters,
    documents,
  })
}
