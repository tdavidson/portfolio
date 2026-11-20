import { NextRequest, NextResponse } from 'next/server'
import { viewsContext } from '@/lib/custom-views/http'
import { draftViewSpec, ViewDraftError } from '@/lib/custom-views/draft'
import { resolveView } from '@/lib/custom-views/resolve'
import { parseViewSpec, ViewSpecError } from '@/lib/custom-views/spec'
import { getFeatureProvider } from '@/lib/ai/feature-provider'
import { fundHasAIKey } from '@/lib/ai/keyless'
import { logAIUsage } from '@/lib/ai/usage'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 120

/**
 * POST { instruction, spec?, arguments? } → { spec, payload }
 *
 * The "New view" page: the fund's own model turns the words into a view spec (or revises `spec`
 * by them), the spec is validated, and every block is loaded as the caller for the preview.
 * Nothing is saved; POST /api/views saves.
 *
 * Gated at 'any' in route-domains.ts, like the rest of /api/views: the model sees only the
 * catalog's names, never a row, and every block of the preview is checked against the caller's
 * own access as it loads (lib/custom-views/resolve.ts).
 */
export async function POST(req: NextRequest) {
  const c = await viewsContext()
  if ('error' in c) return c.error

  const limited = await rateLimit({ key: `views-draft:${c.userId}`, limit: 30, windowSeconds: 3600 })
  if (limited) return limited

  if (!(await fundHasAIKey(c.admin, c.fundId))) {
    return NextResponse.json({
      error: 'This fund has no AI key, so the app cannot build views itself. Add one in Settings, or build the view in Claude with the Hemrock connector.',
    }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  let current = null
  if (body?.spec) {
    try {
      current = parseViewSpec(body.spec)
    } catch (e) {
      if (e instanceof ViewSpecError) return NextResponse.json({ error: e.message }, { status: 400 })
      throw e
    }
  }

  const { provider, model, providerType } = await getFeatureProvider(c.admin as never, c.fundId, 'portfolio')
  try {
    const draft = await draftViewSpec({
      provider, model, instruction: String(body?.instruction ?? ''), current, signal: req.signal,
    })
    for (const usage of draft.usage) {
      logAIUsage(c.admin, { fundId: c.fundId, userId: c.userId, provider: providerType, model, feature: 'custom_view_draft', usage })
    }
    const payload = await resolveView(
      { admin: c.admin, fundId: c.fundId, userId: c.userId, access: c.access },
      draft.spec,
      body?.arguments,
      { id: null },
    )
    return NextResponse.json({ spec: draft.spec, payload })
  } catch (e) {
    if (e instanceof ViewDraftError || e instanceof ViewSpecError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
