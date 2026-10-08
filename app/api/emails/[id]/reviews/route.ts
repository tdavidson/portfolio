import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import type { ParsingReview, Company, Metric, InboundEmail } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { isFundReviewType } from '@/lib/portfolio/fof-review-types'

type ReviewRow = Pick<
  ParsingReview,
  'id' | 'issue_type' | 'extracted_value' | 'context_snippet' | 'created_at'
> & {
  companies: Pick<Company, 'id' | 'name'> | null
  metrics: Pick<Metric, 'id' | 'name' | 'unit' | 'value_type'> | null
  inbound_emails: Pick<InboundEmail, 'id' | 'subject' | 'received_at' | 'from_address'> & {
    diligence_deal_id: string | null
  } | null
}

// GET — returns unresolved reviews for a specific email
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A fund review writes the fund register, the investments feature's: hidden below that read.
  const admin = createAdminClient()
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const fundReadable = hasAccess(access, 'portfolio', 'read', 'investments')

  const { data, error } = await supabase
    .from('parsing_reviews')
    .select(`
      id, issue_type, extracted_value, context_snippet, created_at,
      companies ( id, name ),
      metrics ( id, name, unit, value_type ),
      inbound_emails ( id, subject, received_at, from_address, diligence_deal_id )
    `)
    .eq('email_id', params.id)
    .is('resolution', null)
    .order('created_at', { ascending: false })

  if (error) return dbError(error, 'emails-id-reviews')

  const rows = ((data ?? []) as unknown as ReviewRow[]).filter(r => fundReadable || !isFundReviewType(r.issue_type))

  const items = rows.map(r => ({
    id: r.id,
    issue_type: r.issue_type,
    extracted_value: r.extracted_value,
    context_snippet: r.context_snippet,
    created_at: r.created_at,
    company: r.companies ?? null,
    metric: r.metrics ?? null,
    email: r.inbound_emails ?? null,
  }))

  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.issue_type] = (counts[item.issue_type] ?? 0) + 1
  }

  return NextResponse.json({ total: items.length, counts, items })
}

// POST — bulk actions on reviews for an email
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { action } = body as { action: string }

  if (action !== 'dismiss_all' && action !== 'approve_all') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const resolution = action === 'approve_all' ? 'accepted' as const : 'rejected' as const

  // Verify the email belongs to the caller's fund
  const { fundId: userFundId } = writeCheck
  const { data: emailCheck } = await admin
    .from('inbound_emails')
    .select('fund_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!emailCheck || emailCheck.fund_id !== userFundId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Get all unresolved reviews for this email
  const { data: reviews, error } = await supabase
    .from('parsing_reviews')
    .select('id, fund_id, issue_type')
    .eq('email_id', params.id)
    .is('resolution', null)

  if (error) return dbError(error, 'emails-id-reviews')

  const fundId = userFundId

  // A fund-holding proposal is approved by writing the register (api/review/[id]/resolve), one at a
  // time with its entity. A bulk "accept" would mark it approved with nothing saved, so approve-all
  // leaves it open — and so the email, until it is resolved. Dismissing writes nothing to the
  // register, so dismiss-all resolves it with the rest (RLS already limited `rows` to the caller's).
  const rows = (reviews ?? []) as unknown as { id: string; issue_type: string }[]
  // Either way, a caller without write on the investments feature leaves them open (counted in leftOpen).
  const fundWritable = rows.some(r => isFundReviewType(r.issue_type))
    ? hasAccess(await loadAccessContext(admin, userFundId, writeCheck.userId, writeCheck.role), 'portfolio', 'write', 'investments')
    : true
  const skip = (r: { issue_type: string }) =>
    isFundReviewType(r.issue_type) && (action === 'approve_all' || !fundWritable)
  const leftOpen = rows.filter(skip).length
  const bulk = rows.filter(r => !skip(r))

  if (bulk.length > 0) {
    const reviewIds = bulk.map(r => r.id)

    // Mark all with the appropriate resolution. The ids came from the caller's own (RLS) read; the
    // fund filter says the same on the admin write.
    const { error: updateError } = await admin
      .from('parsing_reviews')
      .update({
        resolution,
        resolved_at: new Date().toISOString(),
      })
      .in('id', reviewIds)
      .eq('fund_id', fundId)
    if (updateError) return dbError(updateError, 'emails-id-reviews')

    // Check retain setting
    if (fundId) {
      const { data: settingsData } = await admin
        .from('fund_settings')
        .select('retain_resolved_reviews')
        .eq('fund_id', fundId)
        .maybeSingle()

      const settings = settingsData as unknown as { retain_resolved_reviews: boolean } | null
      if (settings && !settings.retain_resolved_reviews) {
        const { error: deleteError } = await admin.from('parsing_reviews').delete().in('id', reviewIds).eq('fund_id', fundId)
        // The reviews are resolved; only the clean-up of resolved rows failed.
        if (deleteError) console.error('[emails-id-reviews] could not remove resolved reviews:', deleteError.message)
      }
    }
  }

  // Promote email status to success (scoped to fund) once NOTHING on it is open — counted with the
  // admin client, so a review the caller cannot see (another entity's) still holds the email in review.
  const { count: unresolvedCount, error: countError } = await admin
    .from('parsing_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('email_id', params.id)
    .eq('fund_id', fundId)
    .is('resolution', null)
  if (countError) return dbError(countError, 'emails-id-reviews')

  if (fundId && unresolvedCount === 0) {
    await admin
      .from('inbound_emails')
      .update({ processing_status: 'success', processing_error: null })
      .eq('id', params.id)
      .eq('fund_id', fundId)
      .in('processing_status', ['needs_review', 'processing', 'failed', 'not_processed'])
  }

  expireTag('review-badge')

  return NextResponse.json({ ok: true, resolved: bulk.length, leftOpen })
}
