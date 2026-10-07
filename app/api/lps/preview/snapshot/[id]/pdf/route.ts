import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateInvestorReportPdf } from '@/lib/lp-report-pdf'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'

export const maxDuration = 120

/**
 * Admin-only: download the snapshot report PDF for a chosen investor, for the
 * "view as LP" preview. Fund-scoped (investor + snapshot must belong to the
 * admin's fund).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  // Previewing the portal shows an investor everything they hold, in every entity — so only someone
  // who can see every entity may preview it (the sidebar already offers it to admins only).
  const previewScope = await loadEntityScopeForUser(admin, user.id)
  if (!previewScope || !canSeeVehicle(previewScope.access, null)) {
    return NextResponse.json({ error: 'Previewing the LP portal needs access to every entity.' }, { status: 403 })
  }
  const fundId = membership.fund_id

  const investorId = new URL(req.url).searchParams.get('investor_id') ?? ''

  let targetInvestorId = investorId
  if (!investorId || investorId === 'sample') {
    // Sample preview: use a representative investor who has a position in this
    // snapshot, so the report renders with real (non-empty) data.
    const { data: rep } = await (admin as any)
      .from('lp_investments')
      .select('lp_entities!inner(investor_id)')
      .eq('fund_id', fundId)
      .eq('snapshot_id', params.id)
      .limit(1)
    targetInvestorId = (rep ?? [])[0]?.lp_entities?.investor_id ?? ''
    if (!targetInvestorId) return NextResponse.json({ error: 'No investor data in this snapshot' }, { status: 404 })
  } else {
    const { data: inv } = await (admin as any).from('lp_investors').select('id').eq('id', investorId).eq('fund_id', fundId).maybeSingle()
    if (!inv) return NextResponse.json({ error: 'Investor not found in your fund' }, { status: 404 })
  }

  const result = await generateInvestorReportPdf(admin, { fundId, snapshotId: params.id, investorIds: [targetInvestorId] })
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${result.fileName}"` },
  })
}
