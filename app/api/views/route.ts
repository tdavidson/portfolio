import { NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { CustomViewError, listViews, viewPath } from '@/lib/custom-views/store'

/**
 * Custom views (lib/custom-views): GET → the member's own views and the fund's shared ones.
 *
 * Gated at 'any' in route-domains.ts: a view is the member's own list, like a saved dashboard,
 * and each block is checked against the viewer's access when it is opened (/api/views/[id]).
 */
export async function GET() {
  const c = await viewsContext()
  if ('error' in c) return c.error
  try {
    const views = await listViews(c.admin, c.fundId, c.userId)
    return NextResponse.json({ views: views.map(v => ({ ...v, path: viewPath(v.id) })) })
  } catch (e) {
    if (e instanceof CustomViewError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}
