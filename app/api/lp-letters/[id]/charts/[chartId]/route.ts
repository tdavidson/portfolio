import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { getLetter } from '@/lib/lp-letters/service'
import { chartBytes } from '@/lib/lp-letters/charts'
import { chartsOf } from '@/lib/lp-letters/document'

/** One chart's image, for the letter page. Read-only; the letter's entity check applies. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; chartId: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = membership.fund_id as string
  const scope = await loadEntityScopeForUser(admin, user.id)
  const found = await getLetter(admin, fundId, scope ? scope.vehicleNames : [], params.id)
  const letter = found.ok ? found.value : null
  if (!letter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const chart = chartsOf(letter).find(c => c.id === params.chartId)
  if (!chart) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const bytes = (await chartBytes(admin, fundId, letter.id, [chart])).get(chart.id)
  if (!bytes) return NextResponse.json({ error: 'The image could not be read.' }, { status: 404 })
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': chart.content_type,
      // Immutable: the path is the image's hash, and the id never points at another image.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
