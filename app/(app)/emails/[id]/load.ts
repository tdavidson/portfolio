import type { PageContext } from '@/lib/pages/context'
import type { InboundEmail } from '@/lib/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricRow = {
  id: string
  period_label: string
  value_number: number | null
  value_text: string | null
  confidence: string
  metric_id: string
}

export type MetricDef = {
  id: string
  name: string
  unit: string | null
  unit_position: string
}

type ReviewRow = {
  id: string
  issue_type: string
  resolution: string | null
  resolved_at: string | null
  extracted_value: string | null
}

export type EmailAttachment = { Name: string; ContentType: string; ContentLength: number; StoragePath?: string; AttachmentId?: string }

export type EmailPageData = NonNullable<Awaited<ReturnType<typeof loadEmailPage>>>

/**
 * One inbound email as the page shows it: the row's headline fields, the company it was routed
 * to, the metric values it wrote, whether reviews exist, and the body and attachment list parsed
 * out of the raw payload. The payload itself stays here.
 */
export async function loadEmailPage({ supabase }: PageContext, params: { id: string }) {
  // Fetch email row (no join — avoids TS inference issues with hand-written DB types)
  const { data: emailData, error } = await supabase
    .from('inbound_emails')
    .select(
      'id, from_address, subject, received_at, processing_status, processing_error, claude_response, metrics_extracted, attachments_count, raw_payload, company_id, fund_id, routed_to, routing_label, routing_confidence, routing_reasoning, diligence_deal_id'
    )
    .eq('id', params.id)
    .maybeSingle()

  if (error || !emailData) return null

  // The router's reasoning can name the diligence record it matched; show it only when the viewer
  // can see that record (their own client, so RLS applies the entity rule).
  const matchedDeal = (emailData as any).diligence_deal_id as string | null
  if (matchedDeal) {
    const { data: deal } = await (supabase as any).from('diligence_deals').select('id').eq('id', matchedDeal).maybeSingle()
    if (!deal) (emailData as any).routing_reasoning = null
  }

  const email = emailData as unknown as InboundEmail

  // Parallel fetches
  const [companyResult, metricValuesResult, reviewsResult] = await Promise.all([
    email.company_id
      ? supabase
          .from('companies')
          .select('id, name')
          .eq('id', email.company_id)
          .maybeSingle()
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
  const metricValues = (metricValuesResult.data ?? []) as MetricRow[]
  const reviews = (reviewsResult.data ?? []) as ReviewRow[]

  // Fetch metric definitions for the metric_values
  const metricIds = Array.from(new Set(metricValues.map(mv => mv.metric_id)))
  const { data: metricsData } = metricIds.length
    ? await supabase.from('metrics').select('id, name, unit, unit_position').in('id', metricIds)
    : { data: [] }

  const metricsById = Object.fromEntries(
    ((metricsData ?? []) as MetricDef[]).map(m => [m.id, m])
  )

  // Parse raw payload for body and attachments
  // Check if file storage is configured
  const { data: settingsData } = await supabase
    .from('fund_settings')
    .select('file_storage_provider')
    .eq('fund_id', email.fund_id)
    .maybeSingle() as { data: { file_storage_provider: string | null } | null }
  const hasFileStorage = !!settingsData?.file_storage_provider

  const payload = email.raw_payload as Record<string, unknown> | null
  const textBody: string = (payload?.TextBody as string) ?? ''
  const attachments = (payload?.Attachments as EmailAttachment[]) ?? []


  return {
    email: {
      id: email.id,
      subject: email.subject,
      from_address: email.from_address,
      received_at: email.received_at,
      processing_status: email.processing_status,
      processing_error: email.processing_error,
      claude_response: email.claude_response,
    },
    company,
    metricValues,
    metricsById,
    hasReviews: reviews.length > 0,
    hasFileStorage,
    textBody,
    attachments,
  }
}
