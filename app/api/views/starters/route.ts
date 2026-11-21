import { NextRequest, NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { resolveView } from '@/lib/custom-views/resolve'
import { hasAccess } from '@/lib/access/effective'
import { findStarter, startersFor, starterSpec } from '@/lib/custom-views/starters'

/**
 * Starter views (lib/custom-views/starters.ts): commonly used views to open and save.
 *
 *   GET                      → the starters this member's access allows
 *   GET ?key=&vehicle=&as_of= → one starter's spec, with every block loaded as the caller
 *
 * The same catalog the MCP `help` tool offers (topic "starters"). Gated at 'any' in
 * route-domains.ts, like /api/views/[id]: a starter is offered only when the member can read every
 * dataset it uses, and resolveView checks each block against its dataset's own gate regardless.
 */
export async function GET(req: NextRequest) {
  const c = await viewsContext()
  if ('error' in c) return c.error
  const canRead = (domain: Parameters<typeof hasAccess>[1], feature?: Parameters<typeof hasAccess>[3]) => hasAccess(c.access, domain, 'read', feature)
  const p = req.nextUrl.searchParams
  const key = p.get('key')
  if (!key) {
    return NextResponse.json({ starters: startersFor(canRead).map(s => ({ key: s.key, name: s.name, description: s.description, area: s.area })) })
  }
  const starter = findStarter(key, canRead)
  if (!starter) return NextResponse.json({ error: 'No starter view by that name.' }, { status: 404 })
  const spec = starterSpec(starter)
  const args = Object.fromEntries(p)
  delete args.key
  const payload = await resolveView({ admin: c.admin, fundId: c.fundId, userId: c.userId, access: c.access }, spec, args, { id: null })
  return NextResponse.json({ starter: { key: starter.key, name: starter.name }, spec, payload })
}
