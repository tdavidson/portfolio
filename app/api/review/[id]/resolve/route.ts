import { NextRequest, NextResponse } from 'next/server'
import { expireTag } from '@/lib/cache/tags'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { parseValue } from '@/lib/pipeline/processEmail'
import type { ParsingReview, Metric } from '@/lib/types/database'
import type { ExtractMetricsResult } from '@/lib/claude/extractMetrics'
import { logActivity } from '@/lib/activity'
import { dbError } from '@/lib/api-error'
import { loadAccessContext } from '@/lib/access/effective'
import { approveFundReview, type FundApproval } from '@/lib/portfolio/fof-reviews'
import { isFundReviewType, scopeFundReviews } from '@/lib/portfolio/fof-review-types'

type ReviewRow = Pick<
  ParsingReview,
  | 'id'
  | 'fund_id'
  | 'email_id'
  | 'metric_id'
  | 'company_id'
  | 'issue_type'
  | 'extracted_value'
  | 'resolution'
  | 'vehicle_id'
  | 'payload'
>

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(createAdminClient(), user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const body = await req.json()
  const { resolution, resolved_value } = body as {
    resolution: string
    resolved_value?: string
    /** Fund reviews: the entity, when the review names none. */
    vehicleId?: string
    /** Fund reviews: the approver's corrections to the proposal (fof-review-types.ts applyEdits). */
    edits?: Record<string, unknown>
  }

  if (!['accepted', 'rejected', 'manually_corrected'].includes(resolution)) {
    return NextResponse.json({ error: 'Invalid resolution' }, { status: 400 })
  }
  if (resolution === 'manually_corrected' && !resolved_value?.trim()) {
    return NextResponse.json(
      { error: 'resolved_value is required for manually_corrected' },
      { status: 400 }
    )
  }

  // RLS ensures the review belongs to the user's fund; say the same with the gate's fund.
  const { data: reviewData, error: reviewError } = await supabase
    .from('parsing_reviews')
    .select('id, fund_id, email_id, metric_id, company_id, issue_type, extracted_value, resolution, vehicle_id, payload')
    .eq('id', params.id)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()

  if (reviewError) return dbError(reviewError, 'review-id-resolve')
  if (!reviewData) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const review = reviewData as unknown as ReviewRow
  if (review.resolution) return NextResponse.json({ error: 'Already resolved' }, { status: 409 })

  const admin = createAdminClient()

  // A FUND-HOLDING proposal (lib/portfolio/fof-email.ts) is one entity's: a member may resolve it —
  // approve or dismiss — only for an entity of theirs, and one naming no entity is for unscoped
  // callers to assign. The same rule RLS applies, said here because what follows uses the admin client.
  const isFund = isFundReviewType(review.issue_type)
  const access = isFund ? await loadAccessContext(admin, writeCheck.fundId, writeCheck.userId, writeCheck.role) : null
  if (access && scopeFundReviews([review], access).length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const corrected = isFund && resolution !== 'rejected' && !!body.edits && Object.keys(body.edits).length > 0
  const validResolution = (corrected ? 'manually_corrected' : resolution) as 'accepted' | 'rejected' | 'manually_corrected'

  // CLAIM the review before writing anything: only the request that moves it from open to resolved
  // goes on, so a double-click or a second tab cannot save the NAV or draft the notice twice.
  const { data: claimed, error: claimError } = await admin
    .from('parsing_reviews')
    .update({
      resolution: validResolution,
      resolved_value: corrected ? JSON.stringify(body.edits) : resolved_value ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('fund_id', writeCheck.fundId)
    .is('resolution', null)
    .select('id')
  if (claimError) return dbError(claimError, 'review-id-resolve')
  if (!claimed || claimed.length === 0) return NextResponse.json({ error: 'Already resolved' }, { status: 409 })

  // Approving a fund proposal writes the register row it proposes — a NAV statement, which books its
  // mark, or a draft notice. Dismissing writes nothing. A refusal reopens the review.
  let fund: Extract<FundApproval, { ok: true }> | null = null
  let vehicleWarning: string | null = null
  if (isFund && access && resolution !== 'rejected') {
    let approved: FundApproval
    try {
      approved = await approveFundReview(admin, { fundId: writeCheck.fundId, userId: user.id, access }, review, {
        vehicleId: body.vehicleId, edits: body.edits,
      })
    } catch (e) {
      // A throw may follow a committed write (the NAV or notice saved, then something after it failed),
      // so the review stays resolved rather than inviting a second save.
      console.error('[review-id-resolve] fund approval failed:', e)
      return NextResponse.json({
        error: 'Something went wrong while saving this proposal, and it may have been saved. '
             + 'Check the holding\'s statements and notices before entering it again.',
      }, { status: 500 })
    }
    if (!approved.ok) {
      // A clean refusal wrote nothing: reopen the review so it can be corrected and approved.
      const { error: reopenError } = await admin
        .from('parsing_reviews')
        .update({ resolution: null, resolved_value: null, resolved_at: null })
        .eq('id', params.id)
        .eq('fund_id', writeCheck.fundId)
      if (reopenError) {
        console.error('[review-id-resolve] could not reopen review:', reopenError.message)
        return NextResponse.json({
          error: `${approved.error} Nothing was saved, but the review could not be reopened — reload and try again.`,
        }, { status: approved.status })
      }
      return NextResponse.json({ error: approved.error }, { status: approved.status })
    }
    fund = approved
    const { error: vehicleError } = await admin
      .from('parsing_reviews')
      .update({ vehicle_id: fund.vehicleId })
      .eq('id', params.id)
      .eq('fund_id', writeCheck.fundId)
    if (vehicleError) {
      // The register row is written; only the review's record of its entity is missing.
      console.error('[review-id-resolve] could not record the review\'s entity:', vehicleError.message)
      vehicleWarning = 'Saved, but the review could not record which entity it was approved for.'
    }
  }

  // Write to metric_values for issue types where the pipeline skipped writing.
  // low_confidence: value was already written → only write if manually_corrected.
  // duplicate_period, ambiguous_period: nothing was written → write on accept/manually_corrected.
  const writableOnAccept = ['duplicate_period', 'ambiguous_period']
  const shouldWrite =
    (resolution === 'accepted' && writableOnAccept.includes(review.issue_type)) ||
    (resolution === 'manually_corrected' && !!review.metric_id && !!review.company_id)

  const valueToWrite =
    resolution === 'manually_corrected' ? resolved_value! : review.extracted_value

  if (!isFund && shouldWrite && review.metric_id && review.company_id && valueToWrite) {
    // Get period info from the email's stored Claude response
    const { data: emailData } = await admin
      .from('inbound_emails')
      .select('claude_response')
      .eq('id', review.email_id)
      .single()

    const claudeResponse = (emailData as unknown as { claude_response: ExtractMetricsResult | null })?.claude_response
    const period = claudeResponse?.reporting_period

    if (period) {
      const { data: metricData } = await admin
        .from('metrics')
        .select('value_type')
        .eq('id', review.metric_id)
        .single()

      const valueType = (metricData as unknown as Pick<Metric, 'value_type'> | null)?.value_type ?? 'number'
      const valueFields = parseValue(valueToWrite, valueType)

      // Check for existing row (unique index uses coalesce, so we query manually)
      let existingQuery = admin
        .from('metric_values')
        .select('id')
        .eq('metric_id', review.metric_id)
        .eq('period_year', period.year)

      existingQuery =
        period.quarter != null
          ? existingQuery.eq('period_quarter', period.quarter)
          : existingQuery.is('period_quarter', null)

      existingQuery =
        period.month != null
          ? existingQuery.eq('period_month', period.month)
          : existingQuery.is('period_month', null)

      const { data: existing } = await existingQuery.maybeSingle()
      const existingRow = existing as unknown as { id: string } | null

      if (existingRow) {
        await admin
          .from('metric_values')
          .update({
            ...valueFields,
            confidence: 'high',
            is_manually_entered: resolution === 'manually_corrected',
            notes:
              resolution === 'manually_corrected'
                ? 'Manually corrected via review queue'
                : null,
          })
          .eq('id', existingRow.id)
      } else {
        await admin.from('metric_values').insert({
          metric_id: review.metric_id,
          company_id: review.company_id,
          fund_id: review.fund_id,
          period_label: period.label,
          period_year: period.year,
          period_quarter: period.quarter ?? null,
          period_month: period.month ?? null,
          confidence: 'high',
          source_email_id: review.email_id,
          is_manually_entered: resolution === 'manually_corrected',
          notes:
            resolution === 'manually_corrected'
              ? 'Manually corrected via review queue'
              : null,
          ...valueFields,
        })
      }
    }
  }

  // If fund prefers not to retain resolved reviews, delete immediately
  const { data: settingsData } = await admin
    .from('fund_settings')
    .select('retain_resolved_reviews')
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()

  const settings = settingsData as unknown as { retain_resolved_reviews: boolean } | null
  if (settings && !settings.retain_resolved_reviews) {
    await admin.from('parsing_reviews').delete().eq('id', params.id)
  }

  // Check if all review items for this email are now resolved — if so, promote email to 'success'
  const { count: unresolvedCount } = await admin
    .from('parsing_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('email_id', review.email_id)
    .is('resolution', null)

  if (unresolvedCount === 0) {
    await admin
      .from('inbound_emails')
      .update({ processing_status: 'success' })
      .eq('id', review.email_id)
      .eq('processing_status', 'needs_review')
  }

  logActivity(admin, review.fund_id, user.id, 'review.resolve', { reviewId: params.id, resolution })

  expireTag('review-badge')

  return NextResponse.json({
    ok: true,
    ...(fund ? {
      message: fund.message, booking: fund.booking ?? null, eventId: fund.eventId ?? null,
      ...(fund.later ? { later: fund.later } : {}),
      ...(vehicleWarning ? { warning: vehicleWarning } : {}),
    } : {}),
  })
}
