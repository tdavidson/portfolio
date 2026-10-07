import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import type { InboundEmail, Metric, MetricValue, ParsingReview, Json } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'

type MetricValueRow = Pick<
  MetricValue,
  'id' | 'period_label' | 'value_number' | 'value_text' | 'confidence' | 'metric_id'
>

type ReviewRow = Pick<ParsingReview, 'id' | 'issue_type' | 'resolution' | 'resolved_at' | 'extracted_value'>

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: emailData, error } = await supabase
    .from('inbound_emails')
    .select(
      'id, from_address, subject, received_at, processing_status, processing_error, claude_response, metrics_extracted, attachments_count, raw_payload, company_id, fund_id'
    )
    .eq('id', params.id)
    .maybeSingle()

  if (error) return dbError(error, 'emails-id')
  if (!emailData) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const email = emailData as unknown as InboundEmail

  // Verify the user belongs to the same fund as the email
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || email.fund_id !== membership.fund_id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Parallel fetches
  const [companyResult, mvResult, reviewResult] = await Promise.all([
    email.company_id
      ? supabase.from('companies').select('id, name').eq('id', email.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('metric_values')
      .select('id, period_label, value_number, value_text, confidence, metric_id')
      .eq('source_email_id', params.id)
      .order('created_at'),
    supabase
      .from('parsing_reviews')
      .select('id, issue_type, resolution, resolved_at, extracted_value')
      .eq('email_id', params.id)
      .order('created_at'),
  ])

  const company = companyResult.data as { id: string; name: string } | null
  const metricValues = (mvResult.data ?? []) as unknown as MetricValueRow[]
  const reviews = (reviewResult.data ?? []) as unknown as ReviewRow[]

  // Fetch metric names for the written values
  const metricIds = Array.from(new Set(metricValues.map(mv => mv.metric_id)))
  const { data: metricsData } = metricIds.length
    ? await supabase.from('metrics').select('id, name, unit, unit_position').in('id', metricIds)
    : { data: [] }

  const metricsById = Object.fromEntries(
    ((metricsData ?? []) as unknown as Pick<Metric, 'id' | 'name' | 'unit' | 'unit_position'>[]).map(
      m => [m.id, m]
    )
  )

  // Strip attachment Content (base64) and HtmlBody (unsanitized HTML from
  // external senders — stored XSS risk) from raw_payload before returning.
  let sanitizedPayload = email.raw_payload
  if (sanitizedPayload && typeof sanitizedPayload === 'object') {
    const { HtmlBody, ...safeFields } = sanitizedPayload as Record<string, unknown>
    const p = safeFields
    if (Array.isArray(p.Attachments)) {
      p.Attachments = (p.Attachments as Array<Record<string, unknown>>).map(
        ({ Content, ...rest }) => rest
      )
    }
    sanitizedPayload = p as unknown as Json
  }

  return NextResponse.json({
    id: email.id,
    from_address: email.from_address,
    subject: email.subject,
    received_at: email.received_at,
    processing_status: email.processing_status,
    processing_error: email.processing_error,
    claude_response: email.claude_response,
    metrics_extracted: email.metrics_extracted,
    attachments_count: email.attachments_count,
    raw_payload: sanitizedPayload,
    company,
    metric_values: metricValues.map(mv => ({
      id: mv.id,
      period_label: mv.period_label,
      value_number: mv.value_number,
      value_text: mv.value_text,
      confidence: mv.confidence,
      metric: metricsById[mv.metric_id] ?? null,
    })),
    reviews,
  })
}

// PATCH — update email fields (e.g. assign company)
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Verify user has access to this email's fund
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 404 })

  const { data: email } = await admin
    .from('inbound_emails')
    .select('fund_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!email) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (email.fund_id !== membership.fund_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { companyId, processing_status } = body as { companyId?: string; processing_status?: string }

  const updates: Record<string, unknown> = {}

  if (companyId !== undefined) {
    if (companyId) {
      // Verify the company belongs to the same fund
      const { data: company } = await admin
        .from('companies')
        .select('id')
        .eq('id', companyId)
        .eq('fund_id', membership.fund_id)
        .maybeSingle()
      // …and to a company the caller can see.
      const scope = await loadEntityScopeForUser(admin, user.id)
      const visible = scope ? scope.companyIds : []
      if (!company || (visible !== null && !visible.includes(companyId))) {
        return NextResponse.json({ error: 'Invalid company' }, { status: 400 })
      }
    } else {
      // Unmatching an email makes it an admin-triage item; a member would lose it.
      const scope = await loadEntityScopeForUser(admin, user.id)
      if (!scope || scope.companyIds !== null) {
        return NextResponse.json({ error: 'Choose a company you can see for this email.' }, { status: 403 })
      }
    }
    updates.company_id = companyId || null
  }

  if (processing_status !== undefined) {
    // Success, failure, and review are pipeline outcomes. The only manual
    // override is intentionally declining to process an email.
    if (processing_status !== 'not_processed') {
      return NextResponse.json({ error: 'Emails can only be manually marked as skipped' }, { status: 400 })
    }
    updates.processing_status = processing_status
    // Clear error when manually changing status
    updates.processing_error = null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { error } = await admin
    .from('inbound_emails')
    .update(updates)
    .eq('id', params.id)

  if (error) return dbError(error, 'emails-id')

  return NextResponse.json({ ok: true })
}
