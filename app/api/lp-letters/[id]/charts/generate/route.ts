import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { fundChart } from '@/lib/lp-letters/charts'
import { renderSvgToPng } from '@/lib/lp-report-pdf'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 60

/**
 * A chart of the letter's own figures: { kind, options: { color, limit, active_only, sort },
 * section_id?, caption?, save? }. Without save it returns the drawing (SVG) and its suggested
 * caption, for a preview; with save: true it adds it to the draft as an image, like an upload.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const limited = await rateLimit({ key: `lp-letter-fund-chart:${user.id}`, limit: 60, windowSeconds: 300 })
  if (limited) return limited
  const body = await req.json().catch(() => ({}))
  const scope = await loadEntityScopeForUser(admin, user.id)
  const ctx = { fundId: writeCheck.fundId, userId: user.id, visible: scope ? scope.vehicleNames : [] as string[] }
  const out = await fundChart(admin, ctx, params.id, {
    kind: body?.kind, options: body?.options, sectionId: body?.section_id, caption: body?.caption, save: body?.save === true,
  }, renderSvgToPng)
  return outcomeResponse(out, v => ({
    svg: v.chart.svg, width: v.chart.width, height: v.chart.height, caption: v.chart.caption,
    ...(v.charts ? { charts: v.charts } : {}),
  }))
}
