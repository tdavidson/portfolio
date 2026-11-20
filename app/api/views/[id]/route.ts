import { NextRequest, NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { resolveView } from '@/lib/custom-views/resolve'
import { ViewSpecError } from '@/lib/custom-views/spec'
import { CustomViewError, deleteView, getView, viewPath } from '@/lib/custom-views/store'

/**
 * One custom view.
 *
 *   GET    ?vehicle=&as_of=  → the view with every block loaded as the caller
 *   DELETE                   → delete it (the owner's own views only)
 *
 * Gated at 'any' in route-domains.ts. The payload straddles domains by design, so every block is
 * checked in resolveView against the dataset's own gate and the caller's entities: a block the
 * caller may not read comes back `denied`, with no rows.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const c = await viewsContext()
  if ('error' in c) return c.error
  try {
    const view = await getView(c.admin, c.fundId, c.userId, id)
    const p = req.nextUrl.searchParams
    const payload = await resolveView(
      { admin: c.admin, fundId: c.fundId, userId: c.userId, access: c.access },
      view.spec,
      { vehicle: p.get('vehicle') ?? undefined, as_of: p.get('as_of') ?? undefined },
      { id: view.id, name: view.name, url: viewPath(view.id) },
    )
    return NextResponse.json({ view: { id: view.id, name: view.name, kind: view.kind, shared: view.shared }, payload })
  } catch (e) {
    if (e instanceof CustomViewError || e instanceof ViewSpecError) return NextResponse.json({ error: e.message }, { status: 404 })
    throw e
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const c = await viewsContext()
  if ('error' in c) return c.error
  try {
    return NextResponse.json(await deleteView(c.admin, c.fundId, c.userId, id))
  } catch (e) {
    if (e instanceof CustomViewError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}
