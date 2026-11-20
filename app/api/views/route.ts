import { NextRequest, NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { CustomViewError, listViews, saveView, viewPath } from '@/lib/custom-views/store'

/**
 * Custom views (lib/custom-views):
 *   GET                        → the member's own views and the fund's shared ones
 *   POST { name, spec, shared } → save (replaces the member's own view of that name)
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

export async function POST(req: NextRequest) {
  const c = await viewsContext()
  if ('error' in c) return c.error
  // A view is the member's own bookmark, but the read-only viewer role leaves no rows behind,
  // as the MCP save_custom_view tool needs a write-scoped credential.
  if (c.access.role === 'viewer') return NextResponse.json({ error: 'Read-only members cannot save views.' }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const saved = await saveView(c.admin, c.fundId, c.userId, { name: body?.name, spec: body?.spec, shared: body?.shared })
    return NextResponse.json({ saved: { ...saved, path: viewPath(saved.id) } })
  } catch (e) {
    if (e instanceof CustomViewError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}
