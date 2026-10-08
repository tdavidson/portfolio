import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { postTaxAdjustments } from '@/lib/accounting/book-tax-run'
import { rateLimit } from '@/lib/rate-limit'

// Book-to-tax adjustments for one vehicle and one tax year.
//
// GET previews, POST posts. Both run the SAME function — a preview that could disagree with what
// posting does would be worse than no preview at all, so `preview` only decides whether the
// entries are written.

function taxYearOr400(raw: string | null): number | NextResponse {
  const year = Number(raw)
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ error: 'A four-digit taxYear is required' }, { status: 400 })
  }
  return year
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const taxYear = taxYearOr400(req.nextUrl.searchParams.get('taxYear'))
  if (taxYear instanceof NextResponse) return taxYear

  const result = await postTaxAdjustments(admin, gate.fundId, group, user.id, taxYear, { preview: true })
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `tax-adjustments:${user.id}`, limit: 20, windowSeconds: 60 })
  if (limited) return limited

  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const taxYear = taxYearOr400(body?.taxYear != null ? String(body.taxYear) : null)
  if (taxYear instanceof NextResponse) return taxYear

  const result = await postTaxAdjustments(admin, gate.fundId, group, user.id, taxYear, {
    inceptionDate: typeof body?.inceptionDate === 'string' ? body.inceptionDate : undefined,
  })
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })

  // A run blocked on a missing account is not a success. Say which accounts, and say where to
  // get them, rather than returning an empty entry list that reads as "nothing to do".
  if (result.missingAccounts.length > 0) {
    return NextResponse.json(
      {
        ...result,
        error:
          `This vehicle's chart is missing ${result.missingAccounts.join(', ')}. ` +
          "Add them under the entity's Admin → Chart of accounts, then post again.",
      },
      { status: 409 },
    )
  }

  return NextResponse.json(result)
}
