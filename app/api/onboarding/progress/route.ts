import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { computeSetupProgress, loadSetupFacts } from '@/lib/onboarding/progress'
import { parseSkipChange, saveChecklistSkips } from '@/lib/onboarding/checklist-skips'

/**
 * The getting-started count for the "Finish setting up" banner on /start and /dashboard, and for
 * the sidebar, which hides Getting started once `complete` (every step done or skipped). Both are
 * client components, so they cannot take it as server props.
 *
 * Admin-only (ROUTE_DOMAINS: `admin`), checked again here. Returns step keys and statuses only —
 * the banner needs a count, not the details — plus the caller's own user id, which keys their
 * per-browser banner dismissal.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  const progress = computeSetupProgress(await loadSetupFacts(admin, gate.fundId, access))

  return NextResponse.json({
    userId: user.id,
    done: progress.done,
    total: progress.total,
    skipped: progress.skipped,
    complete: progress.complete,
    steps: progress.sections.flatMap(s => s.steps.map(st => ({
      key: st.key,
      status: st.status,
      ...(st.skipped ? { skipped: true } : {}),
    }))),
  })
}

/**
 * Skip or unskip checklist steps for the whole fund: `{ skip?: StepKey[], unskip?: StepKey[] }`.
 * Admin-only, like the rest of setup. Same writer as the `setup_fund` tool's skipSteps.
 */
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => null)
  const change = parseSkipChange(body)
  if ('error' in change) return NextResponse.json({ error: change.error }, { status: 400 })

  const saved = await saveChecklistSkips(admin, gate.fundId, change)
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 500 })
  return NextResponse.json({ skipped: saved.skipped })
}
