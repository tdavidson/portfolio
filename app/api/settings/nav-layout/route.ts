import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isNavLayout } from '@/lib/nav/layout'
import { saveNavLayout } from '@/lib/nav/layout-store'

// The caller's OWN nav layout (Settings → Layout). Any member may change it, read-only viewers
// included: it is a display preference on their own membership row, not fund data, so it does not
// go through assertWriteAccess the way /api/settings does.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { layout?: unknown } | null
  if (!isNavLayout(body?.layout)) {
    return NextResponse.json({ error: 'layout must be one of sidebar, fixed, top' }, { status: 400 })
  }
  const ok = await saveNavLayout(user.id, body.layout)
  if (!ok) return NextResponse.json({ error: 'Could not save the layout' }, { status: 500 })
  return NextResponse.json({ layout: body.layout })
}
