import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { addChart, removeChart, updateChart, MAX_CHART_BYTES } from '@/lib/lp-letters/charts'
import { rateLimit } from '@/lib/rate-limit'

async function gate() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  const scope = await loadEntityScopeForUser(admin, user.id)
  return { admin, userId: user.id, ctx: { fundId: writeCheck.fundId, userId: user.id, visible: scope ? scope.vehicleNames : [] as string[] } }
}

/** Add a chart (a PNG or JPEG) to a draft letter: multipart `file`, `caption`, `section_id`. */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const g = await gate()
  if ('error' in g) return g.error
  const limited = await rateLimit({ key: `lp-letter-charts:${g.userId}`, limit: 30, windowSeconds: 300 })
  if (limited) return limited
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Add the chart image.' }, { status: 400 })
  if (file.size > MAX_CHART_BYTES) return NextResponse.json({ error: 'A chart image must be 5 MB or less.' }, { status: 400 })
  const bytes = new Uint8Array(await file.arrayBuffer())
  return outcomeResponse(
    await addChart(g.admin, g.ctx, params.id, { bytes, caption: form?.get('caption'), sectionId: form?.get('section_id') }),
    charts => ({ charts }),
  )
}

/** Change a chart's caption or the section it follows: { chart_id, caption?, section_id? }. */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const g = await gate()
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))
  if (typeof body?.chart_id !== 'string') return NextResponse.json({ error: 'chart_id is required' }, { status: 400 })
  return outcomeResponse(
    await updateChart(g.admin, g.ctx, params.id, body.chart_id, { caption: body.caption, sectionId: body.section_id }),
    charts => ({ charts }),
  )
}

/** Take a chart off a draft letter: ?chart=<id>. The stored image is kept. */
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const g = await gate()
  if ('error' in g) return g.error
  const chartId = req.nextUrl.searchParams.get('chart')
  if (!chartId) return NextResponse.json({ error: 'chart is required' }, { status: 400 })
  return outcomeResponse(await removeChart(g.admin, g.ctx, params.id, chartId), charts => ({ charts }))
}
