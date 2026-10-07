import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ParsingReview, Company, Metric, InboundEmail } from '@/lib/types/database'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'
import { createAdminClient } from '@/lib/supabase/admin'

type ReviewRow = Pick<
  ParsingReview,
  'id' | 'issue_type' | 'extracted_value' | 'context_snippet' | 'created_at'
> & {
  companies: Pick<Company, 'id' | 'name'> | null
  metrics: Pick<Metric, 'id' | 'name' | 'unit' | 'value_type'> | null
  inbound_emails: (Pick<InboundEmail, 'id' | 'subject' | 'received_at' | 'from_address'> & {
    diligence_deal_id: string | null
  }) | null
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only reviews and emails about companies the caller can see.
  const scope = await loadEntityScopeForUser(createAdminClient(), user.id)
  const visible = scope ? scope.companyIds : []

  const { data, error } = await filterByCompany(supabase
    .from('parsing_reviews')
    .select(`
      id, issue_type, extracted_value, context_snippet, created_at,
      companies ( id, name ),
      metrics ( id, name, unit, value_type ),
      inbound_emails ( id, subject, received_at, from_address, diligence_deal_id )
    `)
    .is('resolution', null), visible)
    .order('created_at', { ascending: false })

  if (error) return dbError(error, 'review')

  const rows = (data ?? []) as unknown as ReviewRow[]

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

  // Also fetch inbound emails with needs_review status
  const { data: reviewEmails } = await filterByCompany(supabase
    .from('inbound_emails')
    .select('id, from_address, subject, received_at, processing_status, company_id, attachments_count')
    .eq('processing_status', 'needs_review'), visible)
    .order('received_at', { ascending: false })

  // Get company names for those emails
  const emailRows = (reviewEmails ?? []) as unknown as { id: string; from_address: string; subject: string | null; received_at: string; processing_status: string; company_id: string | null; attachments_count: number }[]
  const emailCompanyIds = Array.from(new Set(emailRows.map(e => e.company_id).filter(Boolean))) as string[]
  let companiesById: Record<string, string> = {}
  if (emailCompanyIds.length > 0) {
    const { data: emailCompanies } = await supabase
      .from('companies')
      .select('id, name')
      .in('id', emailCompanyIds)
    companiesById = Object.fromEntries(
      (emailCompanies ?? []).map((c: { id: string; name: string }) => [c.id, c.name])
    )
  }

  const needsReviewEmails = emailRows.map(e => ({
    id: e.id,
    from_address: e.from_address,
    subject: e.subject,
    received_at: e.received_at,
    company: e.company_id ? { id: e.company_id, name: companiesById[e.company_id] ?? 'Unknown' } : null,
  }))

  return NextResponse.json({ total: items.length, counts, items, needsReviewEmails })
}
